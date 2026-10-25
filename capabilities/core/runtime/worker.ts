import PostalMime from 'postal-mime'
import type { Registry, Module } from '../kernel/registry'
import { CapabilityError, ConflictError, NotAllowedError, ValidationError } from '../kernel/errors'
import { Logger } from '../kernel/logger'
import { utf8 } from '../kernel/encoding'
import { SWITCHED_OFF, kvOf, switchedOff } from '../kernel/off-switch'
import { IdentityVerifier, type Principal } from '../security/identity'
import { ApprovalGate } from '../approvals/approval-gate'
import { PushSubscriptionStore } from '../channels/web-push'
import { HealthMonitor } from '../looked-after/health'
import { MonthlyNote } from '../looked-after/monthly-note'
import { EnquiryIntake } from '../workflows/enquiry-intake'
import { BillCapture } from '../workflows/bill-capture'
import { aiUseRegister, toCsv } from '../governance/ai-register'
import { AUTOMATIONS, TOKEN_PROVIDERS } from '../core-module'
import { Telemetry, parseTraceparent, type SpanHandle, type SpanOptions } from '../telemetry/telemetry'
import { SECURE_HEADERS, approvalPage, messagePage } from './html'

// The driving side of the hexagon: HTTP, cron and inbound email call into the
// application through the registry, never into adapters directly.
//
// Every HTTP route is behind Cloudflare Access *and* checks the Access JWT
// itself. There is no public route in this Worker; the website's contact form
// lives in the homepage Worker and can forward to EnquiryIntake over a service
// binding if a client wants that.

export type Task = 'automations' | 'health' | 'expire' | 'monthly' | 'tokens'

export interface WorkerOptions<E> {
  module: (env: E) => Module
  /** Cron expression → tasks. Must match the triggers in wrangler config. */
  crons?: Record<string, Task[]>
  /** Local part of the address bills are sent to. */
  billsAddress?: string
}

const DEFAULT_CRONS: Record<string, Task[]> = {
  // 8am AEST / 9am AEDT on weekdays: reminders are drafted before the owner starts.
  '0 22 * * 1-5': ['automations'],
  '0 * * * *': ['health', 'expire'],
  // OAuth tokens last 20 to 30 minutes. A cron trigger runs once per schedule, so
  // refreshing here means requests share one token from KV instead of racing to renew it.
  '*/15 * * * *': ['tokens'],
  '0 23 1 * *': ['monthly'],
}

const MAX_EMAIL_BYTES = 15 * 1024 * 1024
const BILL_TYPES = /^(application\/pdf|image\/(png|jpe?g|webp|heic)|text\/plain)$/i

/** Low-cardinality route names for spans: ids never appear in span names. */
function routeName(pathname: string): string {
  if (/^\/approvals\/[^/]+$/.test(pathname)) return '/approvals/:id'
  if (pathname === '/push/subscribe' || pathname === '/register.csv') return pathname
  return 'unmatched'
}

/**
 * Runs one invocation inside a root span, then flushes telemetry from
 * waitUntil so the response isn't held up. Without telemetry bound, it just runs.
 */
function traced<T>(c: Registry, ctx: ExecutionContext | undefined, name: string, opts: SpanOptions, fn: (span?: SpanHandle) => Promise<T>): Promise<T> {
  if (!c.has(Telemetry)) return fn()
  const t = c.get(Telemetry)
  const p = t.run(() => t.inSpan(name, opts, fn))
  ctx?.waitUntil?.(p.then(() => undefined, () => undefined).then(() => t.flush()))
  return p
}

/** A child span per cron task, so a slow or failing one stands out. */
function step(c: Registry, task: string, fn: () => Promise<unknown>) {
  return c.has(Telemetry) ? c.get(Telemetry).inSpan(`task.${task}`, { attrs: { 'pf.task': task } }, fn) : fn()
}

export function createWorker<E extends object>(opts: WorkerOptions<E>): ExportedHandler<E> {
  // env is the same object for the life of an isolate, so so is the registry.
  const registries = new WeakMap<object, Registry>()
  const registryFor = (env: E) => {
    let c = registries.get(env)
    if (!c) { c = opts.module(env).build(); registries.set(env, c) }
    return c
  }
  const crons = opts.crons ?? DEFAULT_CRONS

  return {
    async fetch(request, env, ctx) {
      const c = registryFor(env)
      const route_ = routeName(new URL(request.url).pathname)
      return traced(c, ctx, `${request.method} ${route_}`, {
        kind: 'server',
        // Continue a trace from another of our Workers (they're behind Access too).
        parent: parseTraceparent(request.headers.get('traceparent')),
        attrs: { 'faas.trigger': 'http', 'http.request.method': request.method, 'http.route': route_, 'url.scheme': 'https' },
      }, async span => {
        let res: Response
        try {
          const who = await c.get(IdentityVerifier).verify(request)
          res = await switchedOff(kvOf(env))
            ? new Response(messagePage('Switched off', SWITCHED_OFF), { status: 503, headers: SECURE_HEADERS })
            : await route(request, c, who)
        } catch (err) {
          res = errorResponse(err, c)
          if (res.status >= 500) span?.recordError(err)
        }
        span?.setAttribute('http.response.status_code', res.status)
        return res
      })
    },

    async scheduled(controller, env, ctx) {
      const c = registryFor(env)
      // Switched off, only housekeeping that forgets things runs.
      const off = await switchedOff(kvOf(env))
      const tasks = (crons[controller.cron] ?? []).filter(t => !off || t === 'expire')
      await traced(c, ctx, `cron ${controller.cron}`, { kind: 'server', attrs: { 'faas.trigger': 'timer', 'faas.cron': controller.cron } }, async () => {
        const log = c.get(Logger)
        for (const task of tasks) {
          try {
            await step(c, task, async () => {
              if (task === 'automations') for (const a of c.get(AUTOMATIONS)) await a.run()
              if (task === 'health') await c.get(HealthMonitor).check()
              if (task === 'expire') await c.get(ApprovalGate).expireStale()
              if (task === 'monthly') await c.get(MonthlyNote).send()
              if (task === 'tokens') for (const t of c.get(TOKEN_PROVIDERS)) await t.refreshIfDue()
            })
          } catch (err) {
            log.error('scheduled.failed', { task, error: err })
          }
        }
      })
    },

    async email(message, env, ctx) {
      const c = registryFor(env)
      await traced(c, ctx, 'email receive', { kind: 'server', attrs: { 'faas.trigger': 'other', 'pf.email.size': message.rawSize } }, async span => {
        const log = c.get(Logger)
        if (await switchedOff(kvOf(env))) { span?.setAttribute('pf.email.route', 'switched-off'); message.setReject('Switched off for now: nothing was done with this email. Please send it again later or contact the business directly.'); return }
        if (message.rawSize > MAX_EMAIL_BYTES) { span?.setAttribute('pf.email.route', 'too-large'); message.setReject('Message too large'); return }
        const parsed = await PostalMime.parse(message.raw)
        const local = message.to.split('@')[0].toLowerCase()

        if (local === (opts.billsAddress ?? 'bills') && c.has(BillCapture)) {
          const files = (parsed.attachments ?? []).filter(a => BILL_TYPES.test(a.mimeType))
          span?.setAttribute('pf.email.route', 'bills')
          span?.setAttribute('pf.email.attachments', files.length)
          for (const a of files) {
            const bytes = typeof a.content === 'string' ? utf8(a.content) : new Uint8Array(a.content)
            await c.get(BillCapture).capture({ name: a.filename ?? 'bill', type: a.mimeType, bytes })
              .catch(err => log.error('bill.capture.failed', { error: err }))
          }
          log.info('email.bills', { attachments: files.length })
          return
        }

        if (c.has(EnquiryIntake)) {
          span?.setAttribute('pf.email.route', 'enquiry')
          const from = parsed.from?.address ?? message.from
          await c.get(EnquiryIntake).handle({
            name: parsed.from?.name || from.split('@')[0],
            email: from,
            message: [parsed.subject, parsed.text ?? ''].filter(Boolean).join('\n\n').slice(0, 10_000) || '(empty)',
            source: 'email',
          })
          return
        }
        span?.setAttribute('pf.email.route', 'rejected')
        message.setReject('Unknown address')
      })
    },
  }
}

async function route(request: Request, c: Registry, who: Principal): Promise<Response> {
  const url = new URL(request.url)
  const approval = url.pathname.match(/^\/approvals\/([A-Za-z0-9_-]{16,64})$/)

  if (approval && request.method === 'GET') {
    const token = url.searchParams.get('t') ?? ''
    const { approval: a, preview } = await c.get(ApprovalGate).view(approval[1], token, who)
    return new Response(approvalPage({ id: a.id, token, summary: a.summary, ai: a.ai, status: a.status, expiresAt: a.expiresAt, preview }), { headers: SECURE_HEADERS })
  }

  if (approval && request.method === 'POST') {
    sameOrigin(request, url)
    const form = await request.formData()
    const decision = form.get('decision')
    if (decision !== 'approve' && decision !== 'reject') throw new ValidationError('Pick yes or no')
    const body = form.get('body')
    const status = await c.get(ApprovalGate).decide(approval[1], String(form.get('t') ?? ''), who, decision, typeof body === 'string' ? body : undefined)
    const message = {
      done: ['Done', "It's gone. You'll find it in the log."],
      rejected: ['Left alone', "Nothing was sent. It won't come back unless something changes."],
      failed: ['That didn\'t work', "You said yes, but it didn't go through. We've been told and will sort it."],
    }[status as 'done' | 'rejected' | 'failed'] ?? ['Saved', 'Thanks.']
    return new Response(messagePage(message[0], message[1]), { headers: SECURE_HEADERS })
  }

  if (url.pathname === '/push/subscribe' && request.method === 'POST') {
    sameOrigin(request, url)
    const sub = await request.json() as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } }
    if (typeof sub.endpoint !== 'string' || typeof sub.keys?.p256dh !== 'string' || typeof sub.keys?.auth !== 'string') throw new ValidationError('Not a push subscription')
    await c.get(PushSubscriptionStore).add({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } })
    return Response.json({ ok: true })
  }

  if (url.pathname === '/register.csv' && request.method === 'GET') {
    const next = new Date(Date.now() + 90 * 86_400_000).toLocaleString('en-AU', { month: 'long', year: 'numeric' })
    return new Response(toCsv(aiUseRegister(c, next) as unknown as Record<string, string>[]), {
      headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="ai-use-register.csv"', 'cache-control': 'no-store' },
    })
  }

  return new Response('Not found', { status: 404 })
}

/** Belt and braces against cross-site posts (Access cookies are SameSite=Lax, which already helps). */
function sameOrigin(request: Request, url: URL) {
  const origin = request.headers.get('origin')
  if (origin && origin !== url.origin) throw new NotAllowedError('Cross-site request')
}

function errorResponse(err: unknown, c: Registry): Response {
  const status = err instanceof NotAllowedError ? 403 : err instanceof ConflictError ? 409 : err instanceof ValidationError ? 400 : 500
  if (status === 500 || !(err instanceof CapabilityError)) c.get(Logger).error('request.failed', { error: err })
  const [title, message] = status === 403
    ? ['Not allowed', "That link isn't valid for you, or it has expired."]
    : status === 409
      ? ['Already sorted', 'Someone has already said yes or no to this, or it ran out of time.']
      : status === 400 ? ['Something was missing', 'Go back and try again.'] : ['Something went wrong', "It's been logged and we'll look at it."]
  return new Response(messagePage(title, message), { status, headers: SECURE_HEADERS })
}
