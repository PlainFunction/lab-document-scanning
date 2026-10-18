import {
  CapabilityError, DocumentScanner, IdentityVerifier, Logger, MAX_SCAN_BYTES, Module, NotAllowedError, ScanStore, Telemetry,
  ValidationError, createWorker, type Registry,
} from '#capabilities'
import { PAGE_HEADERS, messagePage, resultPage, scanPage } from './pages'
import { ScanningModule, type ScanningEnv } from './module'

// The core Worker (approvals, cron, bills@ email) plus three routes:
//   GET  /             on to /scan
//   GET  /scan         the form and recent scans
//   POST /scan         a photo or PDF in, a result page out
//   GET  /scans/:id    the original, for checking what was read
// Like every core route, they're behind Cloudflare Access and check its JWT.

/** Hands createWorker a registry we already built, so both halves share one per isolate. */
class Built extends Module {
  readonly #c: Registry
  constructor(c: Registry) {
    super()
    this.#c = c
  }
  register() {}
  build() { return this.#c }
}

export function createScanningWorker<E extends object>(module: (env: E) => Module): ExportedHandler<E> {
  const registries = new WeakMap<object, Registry>()
  const registryFor = (env: E) => {
    let c = registries.get(env)
    if (!c) { c = module(env).build(); registries.set(env, c) }
    return c
  }
  const core = createWorker<E>({ module: env => new Built(registryFor(env)) })

  return {
    ...core,
    async fetch(request, env, ctx) {
      const url = new URL(request.url)
      if (url.pathname === '/' && request.method === 'GET') return new Response(null, { status: 303, headers: { location: '/scan' } })
      const route = url.pathname === '/scan' ? '/scan' : /^\/scans\/[0-9a-f]{64}$/.test(url.pathname) ? '/scans/:id' : undefined
      if (!route) return core.fetch!(request, env, ctx)

      const c = registryFor(env)
      const handle = async () => {
        try {
          const who = await c.get(IdentityVerifier).verify(request)
          return await scanRoute(request, url, route, c, who)
        } catch (err) {
          return errorResponse(err, c)
        }
      }
      if (!c.has(Telemetry)) return handle()
      const t = c.get(Telemetry)
      const p = t.run(() => t.inSpan(`${request.method} ${route}`, { kind: 'server', attrs: { 'faas.trigger': 'http', 'http.request.method': request.method, 'http.route': route } }, async span => {
        const res = await handle()
        span.setAttribute('http.response.status_code', res.status)
        return res
      }))
      ctx.waitUntil(p.then(() => t.flush(), () => undefined))
      return p
    },
  }
}

async function scanRoute(request: Request, url: URL, route: string, c: Registry, who: Awaited<ReturnType<IdentityVerifier['verify']>>): Promise<Response> {
  if (route === '/scan' && request.method === 'GET') {
    return new Response(scanPage(await c.get(ScanStore).recent(10)), { headers: PAGE_HEADERS })
  }

  if (route === '/scan' && request.method === 'POST') {
    const origin = request.headers.get('origin')
    if (origin && origin !== url.origin) throw new NotAllowedError('Cross-site request')
    // Refuse before reading the body. Multipart adds a little, hence the slack.
    if (Number(request.headers.get('content-length') ?? 0) > MAX_SCAN_BYTES + 64 * 1024) throw new ValidationError('File is over 10 MB')
    // The default workers-types say FormData only holds strings; with any recent compatibility date it holds Files too.
    const file: unknown = (await request.formData()).get('file')
    if (!(file instanceof File)) throw new ValidationError('No file')
    const result = await c.get(DocumentScanner).scan({ name: file.name || 'scan', type: file.type, bytes: new Uint8Array(await file.arrayBuffer()) }, who)
    return new Response(resultPage(result), { headers: PAGE_HEADERS })
  }

  if (route === '/scans/:id' && request.method === 'GET') {
    const found = await c.get(ScanStore).open(url.pathname.split('/').pop()!)
    if (!found) return new Response(messagePage('Not found', 'There\'s no scan with that link.'), { status: 404, headers: PAGE_HEADERS })
    // Served as a download-safe original: its own type, sandboxed, never sniffed.
    return new Response(found.bytes, {
      headers: {
        'content-type': found.record.type,
        'content-disposition': `inline; filename="${found.record.name.replace(/[^\w.-]+/g, '_')}"`,
        'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
      },
    })
  }

  return new Response(messagePage('Not here', 'That page only takes a scan.'), { status: 405, headers: PAGE_HEADERS })
}

function errorResponse(err: unknown, c: Registry): Response {
  const status = err instanceof NotAllowedError ? 403 : err instanceof ValidationError ? 400 : 500
  if (status === 500 || !(err instanceof CapabilityError)) c.get(Logger).error('scan.request.failed', { error: err })
  const [title, message] = status === 403
    ? ['Not allowed', 'Sign in again and retry.']
    : status === 400
      ? ['That didn\'t work', `${(err as Error).message}. Photos (JPEG, PNG, WebP) and PDFs up to 10 MB.`]
      : ['Something went wrong', 'It\'s been logged and we\'ll look at it.']
  return new Response(messagePage(title, message), { status, headers: PAGE_HEADERS })
}

export default createScanningWorker<ScanningEnv>(env => new ScanningModule(env))
