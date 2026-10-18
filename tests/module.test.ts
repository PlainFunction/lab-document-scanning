import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import {
  BillCapture, CachedDocumentReader, DocumentReader, DocumentScanner, MemoryNotifier, OPS_NOTIFIER, OWNER_NOTIFIER, R2ScanStore, ScanStore,
  aiUseRegister, type Registry,
} from '#capabilities'
import { ScanningModule, type ScanningEnv } from '../src/module'

const scanningEnv = (extra: Partial<ScanningEnv> = {}): ScanningEnv => ({
  CLIENT_ID: 'harbour', BUSINESS_NAME: 'Harbour Plumbing', SIGN_OFF: 'Cheers,\\nDan', PUBLIC_URL: 'https://ops.example',
  APPROVERS: 'dan@harbour.example', OWNER_EMAIL: 'dan@harbour.example', FROM_EMAIL: 'office@harbour.example',
  ACCESS_TEAM: 'team', ACCESS_AUD: 'aud', AI: {} as Ai, KV: env.KV, DB: env.DB, EMAIL: {} as SendEmail, SCANS: env.SCANS,
  KEYRING: JSON.stringify({ current: 'k1', keys: { k1: btoa(String.fromCharCode(...new Uint8Array(32))) } }),
  SIGNING_KEY: 's'.repeat(32), OPS_SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/x',
  ...extra,
})

class TestModule extends ScanningModule {
  register(c: Registry) {
    super.register(c)
    c.bind(OWNER_NOTIFIER, () => new MemoryNotifier())
    c.bind(OPS_NOTIFIER, () => new MemoryNotifier())
  }
}

describe('ScanningModule', () => {
  it('wraps the core document reader so each file is read once', () => {
    const c = new TestModule(scanningEnv()).build()
    expect(c.get(DocumentReader)).toBeInstanceOf(CachedDocumentReader)
    expect(c.get(ScanStore)).toBeInstanceOf(R2ScanStore)
  })

  it('sends bills on only when Xero is connected', () => {
    expect(new TestModule(scanningEnv()).build().has(BillCapture)).toBe(false)
    const c = new TestModule(scanningEnv({ XERO_CLIENT_ID: 'id', XERO_CLIENT_SECRET: 'secret', XERO_TENANT_ID: 'tenant' })).build()
    expect(c.has(BillCapture)).toBe(true)
    expect(c.get(DocumentScanner)).toBeInstanceOf(DocumentScanner)
  })

  it('puts the scanner on the AI use register', () => {
    const rows = aiUseRegister(new TestModule(scanningEnv()).build(), 'March 2027')
    expect(rows.find(r => r.tool === 'Document scanner')).toMatchObject({ personal: 'Yes', decides: 'No' })
  })
})
