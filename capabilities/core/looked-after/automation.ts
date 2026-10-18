import { Port } from '../kernel/port'
import type { Clock } from '../kernel/clock'
import type { Logger } from '../kernel/logger'
import type { Notifier } from '../channels/channel'
import type { RunLog } from './run-log'

export interface AutomationDeps {
  clock: Clock
  runs: RunLog
  logger: Logger
  /** Us, not the client. "If it breaks, we hear about it, not you." */
  ops: Notifier
}

export interface RunResult { note: string }

/**
 * Base class for anything that runs on a schedule. Subclasses write execute();
 * run() times it, logs it, records it in the run log and tells us if it throws.
 * The health monitor then spots one that has stopped running altogether.
 */
export abstract class Automation extends Port {
  /** Stable id, used in the run log and health checks. e.g. 'invoice-chaser' */
  abstract readonly name: string
  /** How long it can go without a successful run before we're told. */
  readonly expectEveryHours: number = 26

  protected readonly deps: AutomationDeps
  constructor(deps: AutomationDeps) {
    super()
    this.deps = deps
  }

  protected abstract execute(): Promise<RunResult>

  async run(): Promise<RunResult & { ok: boolean }> {
    const started = this.deps.clock.now()
    const t0 = Date.now()
    try {
      const result = await this.execute()
      await this.deps.runs.record({ automation: this.name, ok: true, startedAt: started.toISOString(), ms: Date.now() - t0, note: result.note })
      this.deps.logger.info('automation.ok', { automation: this.name, note: result.note })
      return { ...result, ok: true }
    } catch (err) {
      const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
      await this.deps.runs.record({ automation: this.name, ok: false, startedAt: started.toISOString(), ms: Date.now() - t0, note: message.slice(0, 300) })
      this.deps.logger.error('automation.failed', { automation: this.name, error: err })
      await this.deps.ops.notify({ title: `${this.name} failed`, body: message.slice(0, 300), urgency: 'high', tag: `fail:${this.name}` })
        .catch(e => this.deps.logger.error('ops.notify.failed', { error: e }))
      return { note: message, ok: false }
    }
  }
}
