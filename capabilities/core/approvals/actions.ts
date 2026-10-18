import { z } from 'zod'
import { ValidationError } from '../kernel/errors'
import type { AuditLog } from '../audit/audit-log'
import type { Mailer, OutboundEmail } from '../channels/channel'
import type { BillDraft, BillSink } from '../integrations/accounting'
import { billDraftSchema } from '../integrations/accounting'
import { ApprovalAction } from './approval-gate'
import type { Approval } from './approval-store'

const emailSchema = z.object({
  to: z.object({ email: z.email(), name: z.string().max(200).optional() }),
  subject: z.string().trim().min(1).max(200),
  text: z.string().trim().min(1).max(20_000),
  replyTo: z.object({ email: z.email(), name: z.string().max(200).optional() }).optional(),
  reference: z.string().max(200).optional(),
})

const parseWith = <T>(schema: z.ZodType<T>, what: string) => (payload: unknown): T => {
  const r = schema.safeParse(payload)
  if (!r.success) throw new ValidationError(`${what}: ${r.error.issues.map(i => `${i.path.join('.')} ${i.message}`).join('; ')}`)
  return r.data
}

const parseEmail = parseWith(emailSchema, 'Email')
const parseBill = parseWith(billDraftSchema, 'Bill')

/** Sends an email the owner has approved (and maybe edited). */
export class SendEmailAction extends ApprovalAction<OutboundEmail> {
  readonly kind = 'send-email'
  readonly #mailer: Mailer
  readonly #audit: AuditLog
  readonly #replyTo?: OutboundEmail['replyTo']

  constructor(mailer: Mailer, audit: AuditLog, opts: { replyTo?: OutboundEmail['replyTo'] } = {}) {
    super()
    this.#mailer = mailer
    this.#audit = audit
    this.#replyTo = opts.replyTo
  }

  parse(payload: unknown) { return parseEmail(payload) }

  async execute(email: OutboundEmail, approval: Approval<OutboundEmail>) {
    const { id } = await this.#mailer.send({ ...email, replyTo: email.replyTo ?? this.#replyTo, reference: email.reference ?? approval.id })
    await this.#audit.record({ actor: 'system:mailer', action: 'email.sent', subject: email.reference ?? `approval:${approval.id}`, detail: { messageId: id ?? null }, ai: approval.ai })
  }

  withBody(e: OutboundEmail, body: string) { return { ...e, text: body } }

  preview(e: OutboundEmail) {
    return { heading: e.subject, fields: [['To', e.to.name ? `${e.to.name} <${e.to.email}>` : e.to.email]] as [string, string][], body: e.text }
  }
}

/** Puts a supplier bill into the accounting system, as a draft. */
export class CreateBillAction extends ApprovalAction<BillDraft> {
  readonly kind = 'create-bill'
  readonly #bills: BillSink
  readonly #audit: AuditLog

  constructor(bills: BillSink, audit: AuditLog) {
    super()
    this.#bills = bills
    this.#audit = audit
  }

  parse(payload: unknown) { return parseBill(payload) }

  async execute(bill: BillDraft, approval: Approval<BillDraft>) {
    const { id } = await this.#bills.createDraftBill(bill, { idempotencyKey: approval.id })
    await this.#audit.record({ actor: 'system:bills', action: 'bill.created', subject: `bill:${id}`, detail: { approval: approval.id, lines: bill.lines.length }, ai: approval.ai })
  }

  preview(b: BillDraft) {
    const fields: [string, string][] = [
      ['Supplier', b.supplierName],
      ['Reference', b.reference ?? 'None'],
      ['Date', b.issuedOn],
      ['Due', b.dueOn ?? 'Not given'],
      ['Total', `$${b.total.toFixed(2)} ${b.currency}`],
    ]
    return { heading: `Bill from ${b.supplierName}`, fields, body: b.lines.map(l => `${l.quantity} × ${l.description} @ $${l.unitAmount.toFixed(2)}`).join('\n') }
  }
}
