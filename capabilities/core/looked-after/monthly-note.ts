import type { Clock } from '../kernel/clock'
import type { Notifier } from '../channels/channel'
import type { RunLog } from './run-log'
import type { ApprovalStore } from '../approvals/approval-store'

/**
 * "A short note each month on what it did." Built from counts only, so it can
 * go by email without carrying anyone's details.
 */
export class MonthlyNote {
  readonly #runs: RunLog
  readonly #approvals: ApprovalStore
  readonly #clock: Clock
  readonly #owner: Notifier
  readonly #labels: Record<string, string>

  constructor(opts: { runs: RunLog; approvals: ApprovalStore; clock: Clock; owner: Notifier; labels?: Record<string, string> }) {
    this.#runs = opts.runs
    this.#approvals = opts.approvals
    this.#clock = opts.clock
    this.#owner = opts.owner
    this.#labels = opts.labels ?? {}
  }

  async compose(): Promise<{ title: string; body: string }> {
    const now = this.#clock.now()
    const since = new Date(now.getTime() - 30 * 86_400_000).toISOString()
    const runs = await this.#runs.summary(since)
    const decided = await this.#approvals.counts(since)

    const lines = runs.map(r => {
      const label = this.#labels[r.automation] ?? r.automation
      return r.failures === 0
        ? `${label}: ran ${r.runs} time${r.runs === 1 ? '' : 's'}, no problems.`
        : `${label}: ran ${r.runs} time${r.runs === 1 ? '' : 's'}. ${r.failures} hit a problem, and we were told straight away.`
    })
    const body = [
      `Here's what your automations did in the last 30 days.`,
      '',
      ...lines,
      '',
      `You approved ${decided.approved} and said no to ${decided.rejected}.${decided.expired ? ` ${decided.expired} ran out of time without an answer.` : ''}`,
      '',
      'Reply to this email if anything looks off.',
    ].join('\n')
    const month = now.toLocaleString('en-AU', { month: 'long', timeZone: 'Australia/Sydney' })
    return { title: `What your automations did in ${month}`, body }
  }

  async send() {
    await this.#owner.notify({ ...(await this.compose()), urgency: 'low', tag: 'monthly' })
  }
}
