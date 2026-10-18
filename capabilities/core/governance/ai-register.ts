import type { Registry } from '../kernel/registry'

// The AI use register from the Time Check, generated from what is actually
// deployed. Same columns as the toolkit template (src/toolkit/tools.ts), so a
// client's register can be refreshed from the code instead of from memory.
// Required reading for the 10 December 2026 automated-decision rules (APP 1.7).

export interface RegisterRow {
  tool: string
  use: string
  personal: 'Yes' | 'No'
  decides: 'Yes' | 'No'
  checker: string
  stored: string
  review: string
}

export function aiUseRegister(c: Registry, nextReview: string): RegisterRow[] {
  return c.manifests()
    .filter(({ manifest }) => manifest.usesAi)
    .map(({ manifest: m }) => ({
      tool: m.name,
      use: m.use,
      personal: m.personalInfo.length > 0 ? 'Yes' : 'No',
      decides: m.decides ? 'Yes' : 'No',
      checker: m.checkedBy ?? 'Not set: decide who checks this',
      stored: m.storesIn,
      review: nextReview,
    }))
}

/** Every bound adapter: what it touches and where it can reach. For the client's data map. */
export function dataMap(c: Registry) {
  return c.manifests().map(({ key, adapter, manifest: m }) => ({
    port: key, adapter, name: m.name, personalInfo: m.personalInfo.join(', ') || 'None',
    storesIn: m.storesIn, egress: (m.egress ?? []).join(', ') || 'None',
  }))
}

export function toCsv(rows: Record<string, string>[]): string {
  if (rows.length === 0) return ''
  const cols = Object.keys(rows[0])
  const cell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)
  return [cols.join(','), ...rows.map(r => cols.map(k => cell(r[k] ?? '')).join(','))].join('\r\n') + '\r\n'
}
