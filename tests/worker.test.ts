import { describe, expect, it } from 'vitest'
import { DocumentScanner, FixedIdentityVerifier, IdentityVerifier, Logger, Module, Registry, ScanStore, type Principal } from '#capabilities'
import { createScanningWorker } from '../src/worker'
import { OWNER, RECEIPT, scanner } from './helpers'

function setup(who?: Principal) {
  const h = scanner()
  class TestModule extends Module {
    register(c: Registry) {
      c.bind(IdentityVerifier, () => new FixedIdentityVerifier(who))
      c.bind(Logger, () => h.logger)
      c.bind(ScanStore, () => h.store)
      c.bind(DocumentScanner, () => h.scan)
    }
  }
  const worker = createScanningWorker(() => new TestModule())
  const env = {}
  const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext
  const call = (path: string, init?: RequestInit) => worker.fetch!(new Request(`https://ops.example${path}`, init) as never, env, ctx)
  const upload = (bytes: string, type = 'image/jpeg', name = 'IMG_0412.jpg', origin = 'https://ops.example') => {
    const form = new FormData()
    form.set('file', new File([bytes], name, { type }))
    return call('/scan', { method: 'POST', body: form, headers: { origin } })
  }
  return { ...h, call, upload }
}

describe('scan routes', () => {
  it('shows the form, with no scripts allowed', async () => {
    const res = await setup(OWNER).call('/scan')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'")
    // no-referrer would make a browser post the form with "Origin: null", which the cross-site check refuses.
    expect(res.headers.get('referrer-policy')).toBe('same-origin')
    const html = await res.text()
    expect(html).toContain('enctype="multipart/form-data"')
    expect(html).not.toContain('<script')
  })

  it('scans an upload and lists it, escaped', async () => {
    const h = setup(OWNER)
    const res = await h.upload(RECEIPT)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('waiting for the owner to approve')
    const [r] = await h.store.recent(1)
    r.title = '<img src=x onerror=alert(1)>'
    h.store.files.get(r.id)!.record.title = r.title
    const list = await (await h.call('/scan')).text()
    expect(list).toContain('&lt;img src=x')
    expect(list).not.toContain('<img src=x')
  })

  it('serves the original, sandboxed', async () => {
    const h = setup(OWNER)
    await h.upload(RECEIPT)
    const [r] = await h.store.recent(1)
    const res = await h.call(`/scans/${r.id}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/jpeg')
    expect(res.headers.get('content-security-policy')).toContain('sandbox')
    expect(new TextDecoder().decode(await res.arrayBuffer())).toBe(RECEIPT)
    expect((await h.call(`/scans/${'0'.repeat(64)}`)).status).toBe(404)
  })

  it('says what went wrong with a file it cannot take', async () => {
    const res = await setup(OWNER).upload(RECEIPT, 'image/heic', 'IMG.HEIC')
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('PDFs up to 10 MB')
  })

  it('refuses nobody and cross-site posts', async () => {
    expect((await setup().call('/scan')).status).toBe(403)
    expect((await setup().call(`/scans/${'0'.repeat(64)}`)).status).toBe(403)
    const h = setup(OWNER)
    expect((await h.upload(RECEIPT, 'image/jpeg', 'a.jpg', 'https://evil.example')).status).toBe(403)
    expect(h.store.files.size).toBe(0)
  })

  it('sends / on to the form', async () => {
    const res = await setup().call('/')
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('/scan')
  })

  it('leaves every other route to the core Worker', async () => {
    expect((await setup(OWNER).call('/anything')).status).toBe(404)
    expect((await setup().call('/register.csv')).status).toBe(403)
  })
})
