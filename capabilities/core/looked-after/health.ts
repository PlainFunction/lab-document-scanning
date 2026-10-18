import type { Clock } from '../kernel/clock'
import type { Notifier } from '../channels/channel'
import type { Automation } from './automation'
import type { RunLog } from './run-log'

/**
 * Catches the failure Automation.run() can't: the one that never runs at all
 * (cron trigger removed, Worker not deployed, token expired before the run).
 * Runs on its own cron and tells us about anything that's gone quiet.
 */
export class HealthMonitor {
  readonly #automations: Automation[]
  readonly #runs: RunLog
  readonly #clock: Clock
  readonly #ops: Notifier

  constructor(opts: { automations: Automation[]; runs: RunLog; clock: Clock; ops: Notifier }) {
    this.#automations = opts.automations
    this.#runs = opts.runs
    this.#clock = opts.clock
    this.#ops = opts.ops
  }

  async check(): Promise<{ quiet: string[] }> {
    const now = this.#clock.now().getTime()
    const quiet: string[] = []
    for (const a of this.#automations) {
      const last = await this.#runs.lastSuccess(a.name)
      if (!last || now - new Date(last).getTime() > a.expectEveryHours * 3_600_000) quiet.push(a.name)
    }
    if (quiet.length > 0) {
      await this.#ops.notify({
        title: `${quiet.length} automation${quiet.length === 1 ? '' : 's'} gone quiet`,
        body: `No successful run lately: ${quiet.join(', ')}`,
        urgency: 'high',
        tag: 'health',
      })
    }
    return { quiet }
  }
}
