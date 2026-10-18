import { z } from 'zod'
import { Port } from '../kernel/port'
import { sha256Hex } from '../kernel/encoding'
import type { Manifest } from '../kernel/port'
import type { LanguageModel } from '../ai/language-model'
import type { ApprovalGate } from '../approvals/approval-gate'
import type { OutboundEmail } from '../channels/channel'
import type { Contact, InvoiceSource, QuoteSource } from '../integrations/accounting'
import { Automation, type AutomationDeps, type RunResult } from '../looked-after/automation'

// One Job, Done: chasing unpaid invoices and quotes with no reply.
// Each run finds what's due a reminder, drafts it in the owner's voice and
// queues it for approval. Nothing is sent from here.

/** How many reminders each invoice or quote has had queued. */
export abstract class FollowUpLedger extends Port {
  abstract stage(key: string): Promise<number>
  abstract mark(key: string, stage: number): Promise<void>
}

export class MemoryFollowUpLedger extends FollowUpLedger {
  readonly #stages = new Map<string, number>()
  async stage(key: string) { return this.#stages.get(key) ?? 0 }
  async mark(key: string, stage: number) { this.#stages.set(key, stage) }
  describe() { return { name: 'Memory ledger', use: 'Tests', personalInfo: [], storesIn: 'Memory' } }
}

/** KV is fine here: runs are a day apart, far longer than KV takes to settle. */
export class KvFollowUpLedger extends FollowUpLedger {
  readonly #kv: KVNamespace
  constructor(kv: KVNamespace) { super(); this.#kv = kv }
  #key = async (k: string) => `chase:${await sha256Hex(k)}`
  async stage(key: string) { return Number((await this.#kv.get(await this.#key(key))) ?? 0) }
  async mark(key: string, stage: number) { await this.#kv.put(await this.#key(key), String(stage), { expirationTtl: 180 * 86_400 }) }
  describe() { return { name: 'KV follow-up ledger', use: 'Remembering which reminders have gone out', personalInfo: [], storesIn: 'Cloudflare Workers KV (hashed ids only)' } }
}

/** How the owner sounds. Comes from the Time Check, or from a few of their own emails. */
export interface Voice {
  business: string
  /** e.g. "Cheers,\nDan" */
  signOff: string
  /** A sentence or two: "Friendly, short, a bit dry. Never says 'kindly'." */
  style?: string
}

export interface ChaseCandidate {
  /** Stable across runs, e.g. `invoice:<id>`. */
  key: string
  kind: 'invoice' | 'quote'
  number: string
  contact: Contact
  amount: number
  currency: string
  /** Days overdue (invoices) or since sent (quotes). */
  days: number
  title?: string
}

export interface ChaserDeps extends AutomationDeps {
  gate: ApprovalGate
  model: LanguageModel
  ledger: FollowUpLedger
  voice: Voice
}

const draftSchema = z.object({
  subject: z.string().min(1).max(150),
  body: z.string().min(1).max(4000),
})

/**
 * Template for any "chase this until it's done" job. Subclasses say where the
 * candidates come from, when to chase (cadence) and what each reminder is for.
 * Clients override cadence or shouldChase() for their own rules.
 */
export abstract class Chaser extends Automation {
  protected declare readonly deps: ChaserDeps
  /** Days at which reminder 1, 2, 3... become due. */
  protected abstract readonly cadence: number[]

  constructor(deps: ChaserDeps) { super(deps) }

  protected abstract candidates(): Promise<ChaseCandidate[]>
  /** What reminder number `stage` should get across. */
  protected abstract brief(c: ChaseCandidate, stage: number): string

  /** Hook for client rules: skip a customer, pause over Christmas. Default: anyone with an email. */
  protected shouldChase(c: ChaseCandidate): boolean {
    return !!c.contact.email
  }

  protected async execute(): Promise<RunResult> {
    let queued = 0
    let skipped = 0
    for (const c of await this.candidates()) {
      if (!this.shouldChase(c)) { skipped++; continue }
      const due = this.cadence.filter(d => c.days >= d).length
      const sent = await this.deps.ledger.stage(c.key)
      // Several stages overdue (say, on the first run) means one reminder at the latest stage, not a burst.
      if (due <= sent) continue

      const email = await this.draft(c, due)
      await this.deps.gate.request<OutboundEmail>('send-email', email, {
        summary: `Reminder ${due} for ${c.kind} ${c.number} (${c.currency} ${c.amount.toFixed(2)}, ${c.days} days)`,
        ai: true,
        actor: `system:${this.name}`,
      })
      await this.deps.ledger.mark(c.key, due)
      queued++
    }
    return { note: `${queued} queued, ${skipped} skipped` }
  }

  protected async draft(c: ChaseCandidate, stage: number): Promise<OutboundEmail> {
    const { voice } = this.deps
    const firstName = c.contact.name.split(/\s+/)[0]
    const { value } = await this.deps.model.completeJson({
      feature: this.name,
      temperature: 0.2,
      sensitive: [{ label: 'NAME', value: c.contact.name }, { label: 'FIRSTNAME', value: firstName }],
      messages: [
        {
          role: 'system',
          content: [
            `You write short follow-up emails for ${voice.business}, an Australian small business, in the owner's voice.`,
            voice.style ? `How they write: ${voice.style}` : '',
            'Rules: Australian spelling. Plain, warm and brief, under 120 words. No em dashes. No legal threats, no guilt, no "kindly", no "per my last email".',
            'Use only the facts given. Never invent amounts, dates, links or bank details.',
            `End with exactly this sign-off:\n${voice.signOff}`,
            'Reply as JSON: {"subject": "...", "body": "..."}',
          ].filter(Boolean).join('\n'),
        },
        {
          role: 'user',
          content: [
            `Customer's first name: ${firstName}`,
            `${c.kind === 'invoice' ? 'Invoice' : 'Quote'} number: ${c.number}`,
            c.title ? `For: ${c.title}` : '',
            `Amount: ${c.currency} ${c.amount.toFixed(2)}`,
            c.kind === 'invoice' ? `Days overdue: ${c.days}` : `Days since the quote was sent: ${c.days}`,
            `This is reminder ${stage}. ${this.brief(c, stage)}`,
          ].filter(Boolean).join('\n'),
        },
      ],
    }, draftSchema)

    // House rule, enforced rather than hoped for.
    const tidy = (s: string) => s.replace(/\s*\u2014\s*|\s+\u2013\s+/g, ', ')
    return {
      to: { email: c.contact.email!, name: c.contact.name },
      subject: tidy(value.subject),
      text: tidy(value.body),
      reference: `${c.key}:${stage}`,
    }
  }
}

export class InvoiceChaser extends Chaser {
  readonly name: string = 'invoice-chaser'
  protected readonly cadence: number[] = [3, 10, 21]
  readonly #invoices: InvoiceSource

  constructor(deps: ChaserDeps & { invoices: InvoiceSource }) {
    super(deps)
    this.#invoices = deps.invoices
  }

  protected async candidates(): Promise<ChaseCandidate[]> {
    return (await this.#invoices.outstanding()).map(i => ({
      key: `invoice:${i.id}`, kind: 'invoice' as const, number: i.number, contact: i.contact,
      amount: i.amountDue, currency: i.currency, days: this.deps.clock.daysSince(i.dueOn),
    }))
  }

  protected brief(_c: ChaseCandidate, stage: number) {
    return [
      'A friendly nudge. Assume they have just missed it.',
      'Still friendly, a bit more direct. Ask them to let you know if something is wrong with the invoice.',
      'Ask them to pay this week or call to sort out a plan. Calm, not cross.',
    ][Math.min(stage, 3) - 1]
  }

  describe(): Manifest {
    return {
      name: 'Invoice follow-up', use: 'Drafts reminders for overdue invoices; owner approves each before it sends',
      personalInfo: ['customer name', 'customer email'], usesAi: true, decides: false,
      checkedBy: 'Owner approves every email', storesIn: 'Drafts in D1 (encrypted) until approved',
    }
  }
}

export class QuoteChaser extends Chaser {
  readonly name: string = 'quote-chaser'
  protected readonly cadence: number[] = [3, 10]
  readonly #quotes: QuoteSource

  constructor(deps: ChaserDeps & { quotes: QuoteSource }) {
    super(deps)
    this.#quotes = deps.quotes
  }

  protected async candidates(): Promise<ChaseCandidate[]> {
    const today = this.deps.clock.now().toISOString().slice(0, 10)
    return (await this.#quotes.open())
      .filter(q => !q.expiresOn || q.expiresOn >= today)
      .map(q => ({
        key: `quote:${q.id}`, kind: 'quote' as const, number: q.number, contact: q.contact,
        amount: q.total, currency: q.currency, days: this.deps.clock.daysSince(q.sentOn), title: q.title,
      }))
  }

  protected brief(_c: ChaseCandidate, stage: number) {
    return stage === 1
      ? 'Check they got the quote and ask if they have any questions. No pressure.'
      : 'Last check-in. Say no worries if they have gone another way, and that the quote stands if they want it.'
  }

  describe(): Manifest {
    return {
      name: 'Quote follow-up', use: 'Drafts a check-in when a quote has had no reply; owner approves each before it sends',
      personalInfo: ['customer name', 'customer email'], usesAi: true, decides: false,
      checkedBy: 'Owner approves every email', storesIn: 'Drafts in D1 (encrypted) until approved',
    }
  }
}
