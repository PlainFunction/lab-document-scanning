import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { BillCapture, BillSink, IdentityVerifier, MemoryLogger, NotAllowedError, OPS_NOTIFIER, OWNER_NOTIFIER, type Registry } from '#capabilities'
import { DevIdentityVerifier, LogBillSink, LogNotifier } from '../src/dev'
import { ScanningModule, type ScanningEnv } from '../src/module'
import { BILL } from './helpers'

const scanningEnv = (extra: Partial<ScanningEnv> = {}): ScanningEnv => ({
  CLIENT_ID: 'harbour', BUSINESS_NAME: 'Harbour Plumbing', SIGN_OFF: 'Cheers,\\nDan', PUBLIC_URL: 'http://localhost:8788',
  APPROVERS: 'dan@harbour.example', OWNER_EMAIL: 'dan@harbour.example', FROM_EMAIL: 'office@harbour.example',
  ACCESS_TEAM: 'team', ACCESS_AUD: 'aud', AI: {} as Ai, KV: env.KV, DB: env.DB, EMAIL: {} as SendEmail, SCANS: env.SCANS,
  KEYRING: JSON.stringify({ current: 'k1', keys: { k1: btoa(String.fromCharCode(...new Uint8Array(32))) } }),
  SIGNING_KEY: 's'.repeat(32),
  ...extra,
})
const build = (extra: Partial<ScanningEnv> = {}): Registry => new ScanningModule(scanningEnv(extra)).build()

describe('dev stand-ins (ENVIRONMENT = "development")', () => {
  it('signs in as the owner on localhost, and refuses any other host', async () => {
    const v = new DevIdentityVerifier('dan@harbour.example')
    expect(await v.verify(new Request('http://localhost:8788/scan'))).toMatchObject({ email: 'dan@harbour.example', via: 'dev' })
    expect(await v.verify(new Request('http://127.0.0.1:8788/scan'))).toMatchObject({ email: 'dan@harbour.example' })
    await expect(v.verify(new Request('https://scan.harbour.example/scan'))).rejects.toBeInstanceOf(NotAllowedError)
  })

  it('swaps in the dev sign-in, terminal notices and a Xero stand-in, so bills still go for approval', () => {
    const c = build({ ENVIRONMENT: 'development' })
    expect(c.get(IdentityVerifier)).toBeInstanceOf(DevIdentityVerifier)
    expect(c.get(OWNER_NOTIFIER)).toBeInstanceOf(LogNotifier)
    expect(c.get(OPS_NOTIFIER)).toBeInstanceOf(LogNotifier)
    expect(c.get(BillSink)).toBeInstanceOf(LogBillSink)
    expect(c.has(BillCapture)).toBe(true)
  })

  it('uses none of them unless ENVIRONMENT is "development"', () => {
    const c = build({ OPS_SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/x' })
    expect(c.get(IdentityVerifier)).not.toBeInstanceOf(DevIdentityVerifier)
    expect(c.get(OWNER_NOTIFIER)).not.toBeInstanceOf(LogNotifier)
    expect(c.has(BillSink)).toBe(false)
    expect(build({ ENVIRONMENT: 'production' }).get(IdentityVerifier)).not.toBeInstanceOf(DevIdentityVerifier)
  })

  it('logs the approval link and the approved bill', async () => {
    const logger = new MemoryLogger()
    await new LogNotifier(logger, 'owner').notify({ title: 'Waiting for your OK', body: 'Bill', url: 'http://localhost:8788/approvals/x' })
    expect(await new LogBillSink(logger).createDraftBill(BILL)).toEqual({ id: 'dev-bill-1' })
    expect(logger.entries.map(e => e.message)).toEqual(['dev.notice', 'dev.bill'])
    expect(logger.entries[0].fields).toMatchObject({ url: 'http://localhost:8788/approvals/x' })
  })
})
