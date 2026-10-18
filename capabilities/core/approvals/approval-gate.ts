import { ConflictError, NotAllowedError, ValidationError } from '../kernel/errors'
import { randomId } from '../kernel/encoding'
import type { Clock } from '../kernel/clock'
import type { Logger } from '../kernel/logger'
import type { AuditLog } from '../audit/audit-log'
import type { Notifier } from '../channels/channel'
import type { Principal } from '../security/identity'
import type { TokenIssuer } from '../security/signer'
import type { Approval, ApprovalStatus, ApprovalStore } from './approval-store'

/**
 * Something that only happens once the owner says yes: send this email,
 * put this bill into Xero. One subclass per kind.
 */
export abstract class ApprovalAction<P> {
  abstract readonly kind: string
  /** Checks a payload, including one the owner has edited. Throws ValidationError. */
  abstract parse(payload: unknown): P
  abstract execute(payload: P, approval: Approval<P>): Promise<void>
  /** What the owner reviews: a heading, a few labelled fields, and the body if there is one. */
  abstract preview(payload: P): { heading: string; fields: [string, string][]; body?: string }
  /** Applies the owner's edit to the preview body. Default: the body isn't editable. */
  withBody(payload: P, _body: string): P { return payload }
}

export interface ApprovalGateOptions {
  store: ApprovalStore
  tokens: TokenIssuer
  /** Where "something's waiting for you" goes. */
  owner: Notifier
  audit: AuditLog
  clock: Clock
  logger: Logger
  /** e.g. https://approve.client.com.au (behind Cloudflare Access) */
  baseUrl: string
  /** Us. Told when an approved action fails. */
  ops?: Notifier
  /** Lower-case emails of people allowed to approve. */
  approvers: string[]
  ttlHours?: number
}

/**
 * The trust promise in code: nothing reaches a customer until the owner has
 * said yes. Automations call request(); the owner gets a notice with a link;
 * decide() runs the action, once, and only for someone on the approvers list
 * who has signed in through Access.
 */
export class ApprovalGate {
  readonly #o: ApprovalGateOptions
  readonly #actions = new Map<string, ApprovalAction<unknown>>()

  constructor(opts: ApprovalGateOptions) {
    if (opts.approvers.length === 0) throw new NotAllowedError('An approval gate needs at least one approver')
    this.#o = { ...opts, approvers: opts.approvers.map(a => a.trim().toLowerCase()) }
  }

  register<P>(action: ApprovalAction<P>): this {
    this.#actions.set(action.kind, action as ApprovalAction<unknown>)
    return this
  }

  #action(kind: string) {
    const a = this.#actions.get(kind)
    if (!a) throw new ValidationError(`No action registered for ${kind}`)
    return a
  }

  async request<P>(kind: string, payload: P, opts: { summary: string; ai: boolean; actor: string }): Promise<Approval<P>> {
    const action = this.#action(kind)
    const parsed = action.parse(payload) as P
    const now = this.#o.clock.now()
    const ttl = (this.#o.ttlHours ?? 72) * 3600
    const approval: Approval<P> = {
      id: randomId(), kind, summary: opts.summary, payload: parsed, status: 'pending', ai: opts.ai,
      createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + ttl * 1000).toISOString(),
    }
    await this.#o.store.create(approval)
    await this.#o.audit.record({ actor: opts.actor, action: 'approval.requested', subject: `approval:${approval.id}`, detail: { kind }, ai: opts.ai })

    const token = await this.#o.tokens.issue('approval', approval.id, ttl)
    await this.#o.owner.notify({
      title: 'Waiting for your OK',
      body: opts.summary,
      url: `${this.#o.baseUrl}/approvals/${approval.id}?t=${encodeURIComponent(token)}`,
      tag: `approval:${approval.id}`,
    }).catch(err => this.#o.logger.error('approval.notify.failed', { id: approval.id, error: err }))
    return approval
  }

  async #authorise(id: string, token: string, who: Principal) {
    await this.#o.tokens.verify(token, 'approval', id)
    if (who.kind !== 'person' || !who.email || !this.#o.approvers.includes(who.email)) {
      throw new NotAllowedError('Not an approver')
    }
    const approval = await this.#o.store.get(id)
    if (!approval) throw new NotAllowedError('No such approval')
    return approval
  }

  /** For the review page. Same checks as deciding. */
  async view(id: string, token: string, who: Principal) {
    const approval = await this.#authorise(id, token, who)
    return { approval, preview: this.#action(approval.kind).preview(approval.payload) }
  }

  /** `editedBody` is the preview body as the owner left it; ignored if unchanged. */
  async decide(id: string, token: string, who: Principal, decision: 'approve' | 'reject', editedBody?: string): Promise<ApprovalStatus> {
    const approval = await this.#authorise(id, token, who)
    const action = this.#action(approval.kind)
    const at = this.#o.clock.now().toISOString()
    const actor = `owner:${who.email}`

    if (decision === 'reject') {
      if (!(await this.#o.store.transition(id, 'pending', 'rejected', { by: who.email, at, notExpiredAt: at }))) throw new ConflictError('Already decided or expired')
      await this.#o.audit.record({ actor, action: 'approval.rejected', subject: `approval:${id}`, detail: { kind: approval.kind } })
      return 'rejected'
    }

    const original = action.preview(approval.payload).body
    const edited = editedBody !== undefined && original !== undefined && editedBody.replace(/\r\n/g, '\n').trim() !== original.trim()
    const payload = edited ? action.parse(action.withBody(approval.payload, editedBody!.replace(/\r\n/g, '\n').trim())) : approval.payload
    if (!(await this.#o.store.transition(id, 'pending', 'approved', { by: who.email, at, notExpiredAt: at, payload: edited ? payload : undefined }))) {
      throw new ConflictError('Already decided or expired')
    }
    await this.#o.audit.record({ actor, action: 'approval.approved', subject: `approval:${id}`, detail: { kind: approval.kind, edited }, ai: approval.ai })

    try {
      await action.execute(payload, { ...approval, payload, status: 'approved', decidedBy: who.email, decidedAt: at })
      await this.#o.store.transition(id, 'approved', 'done', { at })
      await this.#o.audit.record({ actor: `system:${approval.kind}`, action: 'action.done', subject: `approval:${id}`, detail: { kind: approval.kind }, ai: approval.ai })
      return 'done'
    } catch (err) {
      await this.#o.store.transition(id, 'approved', 'failed', { at })
      await this.#o.audit.record({ actor: `system:${approval.kind}`, action: 'action.failed', subject: `approval:${id}`, detail: { kind: approval.kind, error: err instanceof Error ? err.name : 'Error' } })
      this.#o.logger.error('approval.execute.failed', { id, kind: approval.kind, error: err })
      await this.#o.ops?.notify({ title: `Approved ${approval.kind} failed`, body: `approval:${id}`, urgency: 'high' }).catch(() => {})
      return 'failed'
    }
  }

  /** Marks anything past its expiry as expired. Run from cron. */
  async expireStale(): Promise<number> {
    const now = this.#o.clock.now().toISOString()
    let n = 0
    for (const a of await this.#o.store.listPending()) {
      if (a.expiresAt <= now && (await this.#o.store.transition(a.id, 'pending', 'expired', { at: now }))) {
        await this.#o.audit.record({ actor: 'system:approvals', action: 'approval.expired', subject: `approval:${a.id}`, detail: { kind: a.kind } })
        n++
      }
    }
    return n
  }
}
