import { Port } from '../kernel/port'

export interface Run {
  automation: string
  ok: boolean
  startedAt: string
  ms: number
  /** Counts and outcomes only, e.g. "3 queued, 1 skipped". Never content. */
  note?: string
}

export interface RunSummary { automation: string; runs: number; failures: number; lastOk?: string; lastFailure?: string }

/** Every time an automation runs, and whether it worked. Feeds health checks and the monthly note. */
export abstract class RunLog extends Port {
  abstract record(run: Run): Promise<void>
  abstract summary(sinceIso: string): Promise<RunSummary[]>
  abstract lastSuccess(automation: string): Promise<string | undefined>
}

export class MemoryRunLog extends RunLog {
  readonly runs: Run[] = []
  async record(r: Run) { this.runs.push(r) }
  async lastSuccess(automation: string) {
    return this.runs.filter(r => r.automation === automation && r.ok).map(r => r.startedAt).sort().at(-1)
  }
  async summary(since: string) {
    const by = new Map<string, RunSummary>()
    for (const r of this.runs.filter(r => r.startedAt >= since)) {
      const s = by.get(r.automation) ?? { automation: r.automation, runs: 0, failures: 0 }
      s.runs++
      if (r.ok) s.lastOk = !s.lastOk || r.startedAt > s.lastOk ? r.startedAt : s.lastOk
      else { s.failures++; s.lastFailure = !s.lastFailure || r.startedAt > s.lastFailure ? r.startedAt : s.lastFailure }
      by.set(r.automation, s)
    }
    return [...by.values()]
  }
  describe() { return { name: 'Memory run log', use: 'Tests', personalInfo: [], storesIn: 'Memory' } }
}

export class D1RunLog extends RunLog {
  readonly #db: D1Database
  constructor(db: D1Database) {
    super()
    this.#db = db
  }
  async record(r: Run) {
    await this.#db.prepare('INSERT INTO run_log (automation, ok, started_at, ms, note) VALUES (?, ?, ?, ?, ?)')
      .bind(r.automation, r.ok ? 1 : 0, r.startedAt, r.ms, r.note ?? null).run()
  }
  async lastSuccess(automation: string) {
    const row = await this.#db.prepare('SELECT MAX(started_at) AS at FROM run_log WHERE automation = ? AND ok = 1').bind(automation).first<{ at: string | null }>()
    return row?.at ?? undefined
  }
  async summary(since: string) {
    const { results } = await this.#db.prepare(`
      SELECT automation, COUNT(*) AS runs, SUM(1 - ok) AS failures,
             MAX(CASE WHEN ok = 1 THEN started_at END) AS last_ok,
             MAX(CASE WHEN ok = 0 THEN started_at END) AS last_failure
      FROM run_log WHERE started_at >= ? GROUP BY automation ORDER BY automation`).bind(since).all<Record<string, string | number | null>>()
    return results.map(r => ({
      automation: r.automation as string, runs: r.runs as number, failures: r.failures as number,
      lastOk: (r.last_ok as string | null) ?? undefined, lastFailure: (r.last_failure as string | null) ?? undefined,
    }))
  }
  describe() { return { name: 'D1 run log', use: 'Which automations ran and whether they worked', personalInfo: [], storesIn: 'Cloudflare D1, Oceania' } }
}
