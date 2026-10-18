import { Registry, Module, Token } from './kernel/registry'
import { Clock, SystemClock } from './kernel/clock'
import { JsonLogger, Logger } from './kernel/logger'
import { ConfigError } from './kernel/errors'
import { SecretStore, CloudflareSecretStore } from './secrets/secrets'
import { AesGcmCipher, Cipher } from './security/cipher'
import { HmacSigner, Signer, TokenIssuer } from './security/signer'
import { CloudflareAccessVerifier, IdentityVerifier } from './security/identity'
import { PatternRedactor, Redactor } from './security/redactor'
import { Cache } from './cache/cache'
import { EdgeCache, KvCache, MemoryCache, TieredCache } from './cache/adapters'
import { AuditLog, D1AuditLog } from './audit/audit-log'
import { CachedLanguageModel, DEFAULT_GATEWAY, LanguageModel, MeteredLanguageModel, RedactingLanguageModel, WorkersAiModel } from './ai/language-model'
import { DocumentReader, WorkersAiDocumentReader } from './ai/document-reader'
import { FanoutNotifier, Mailer, Notifier } from './channels/channel'
import { CloudflareEmailMailer, EmailNotifier } from './channels/email'
import { SlackNotifier } from './channels/slack'
import { KvPushSubscriptionStore, PushSubscriptionStore, WebPushNotifier } from './channels/web-push'
import { ApprovalStore, D1ApprovalStore } from './approvals/approval-store'
import { ApprovalGate } from './approvals/approval-gate'
import { CreateBillAction, SendEmailAction } from './approvals/actions'
import { BillSink, InvoiceSource, QuoteSource } from './integrations/accounting'
import { JobCardSink } from './integrations/job-system'
import { ClientCredentialsProvider, OAuthTokenProvider, RefreshTokenProvider } from './integrations/oauth'
import { XERO_HOSTS, XeroBills, XeroClient, XeroInvoices, XeroQuotes } from './integrations/xero/xero'
import { ServiceM8Client, ServiceM8JobCards, ServiceM8Quotes } from './integrations/servicem8/servicem8'
import { HttpClient } from './security/egress'
import { AnalyticsEngineUsageMeter, MemoryUsageMeter, UsageMeter } from './looked-after/usage'
import { D1RunLog, RunLog } from './looked-after/run-log'
import { HealthMonitor } from './looked-after/health'
import { MonthlyNote } from './looked-after/monthly-note'
import type { Automation, AutomationDeps } from './looked-after/automation'
import { FollowUpLedger, InvoiceChaser, KvFollowUpLedger, QuoteChaser, type ChaserDeps, type Voice } from './workflows/follow-ups'
import { EnquiryIntake } from './workflows/enquiry-intake'
import { BillCapture } from './workflows/bill-capture'
import { CloudflareTelemetry, OtlpTelemetry, Telemetry } from './telemetry/telemetry'
import { TelemetryLogger, instrument } from './telemetry/instrument'

/** Reported as service.version. Keep in step with package.json. */
export const CAPABILITIES_VERSION = '0.1.0'

/** Ports bound more than once get a named token. */
export const OWNER_NOTIFIER = new Token<Notifier>('owner-notifier', Notifier)
export const OPS_NOTIFIER = new Token<Notifier>('ops-notifier', Notifier)
export const AUTOMATIONS = new Token<Automation[]>('automations', Array)
export const XERO = new Token<XeroClient>('xero-client', XeroClient)
export const SERVICEM8 = new Token<ServiceM8Client>('servicem8-client', ServiceM8Client)
export const XERO_TOKENS = new Token<OAuthTokenProvider>('xero-tokens', OAuthTokenProvider)
/** Every OAuth connection, refreshed ahead of expiry by the `tokens` cron task. */
export const TOKEN_PROVIDERS = new Token<OAuthTokenProvider[]>('token-providers', Array)

/**
 * One client per Worker, one Worker per client: their own D1, KV, secrets and
 * Access app. Nothing is shared between clients, so there's no tenant id to get
 * wrong. Settings are vars in wrangler config; anything secret is a secret.
 */
export interface CoreEnv {
  CLIENT_ID: string
  BUSINESS_NAME: string
  /** e.g. "Cheers,\nDan" */
  SIGN_OFF: string
  VOICE?: string
  /** Where the admin routes live, behind Cloudflare Access. */
  PUBLIC_URL: string
  /** Comma-separated. Only these people can approve anything. */
  APPROVERS: string
  OWNER_EMAIL: string
  FROM_EMAIL: string
  ACCESS_TEAM: string
  ACCESS_AUD: string

  AI: Ai
  /** The AI Gateway model calls go through. Default "default", which Cloudflare creates on first use. */
  AI_GATEWAY_ID?: string
  AI_MODEL?: string
  KV: KVNamespace
  DB: D1Database
  EMAIL: SendEmail
  USAGE?: AnalyticsEngineDataset

  // Secrets (Worker secrets or Secrets Store bindings)
  KEYRING: unknown
  SIGNING_KEY: unknown
  SLACK_WEBHOOK_URL?: unknown
  OPS_SLACK_WEBHOOK_URL?: unknown
  VAPID_PUBLIC_KEY?: string
  VAPID_PRIVATE_KEY?: unknown
  XERO_CLIENT_ID?: unknown
  XERO_CLIENT_SECRET?: unknown
  XERO_TENANT_ID?: string
  /** 'client_credentials' for a Xero custom connection (preferred), else 'refresh_token'. */
  XERO_GRANT?: string
  SERVICEM8_API_KEY?: unknown

  /** 'production' unless set. Becomes deployment.environment.name. */
  ENVIRONMENT?: string
  /** Set to export OTLP ourselves (Grafana Cloud gateway, or a collector). Unset: Cloudflare's own tracing and export. */
  OTEL_EXPORTER_OTLP_ENDPOINT?: string
  /** Secret. Standard OTel format, e.g. "Authorization=Basic%20<base64>". */
  OTEL_EXPORTER_OTLP_HEADERS?: unknown
}

const need = (env: object, ...names: string[]) => {
  for (const n of names) if (!(env as Record<string, unknown>)[n]) throw new ConfigError(`${n} is not set`)
}

/**
 * The default wiring. A client module extends this and overrides only the
 * methods that differ (see "The three ways a client differs" in the README). Each method gets the
 * registry, so an override can call super and then rebind or decorate.
 */
export class CoreModule extends Module {
  protected readonly env: CoreEnv

  constructor(env: CoreEnv) {
    super()
    this.env = env
  }

  register(c: Registry) {
    this.kernel(c)
    this.telemetry(c)
    this.security(c)
    this.caching(c)
    this.records(c)
    this.ai(c)
    this.channels(c)
    this.integrations(c)
    this.approvals(c)
    this.workflows(c)
    this.lookedAfter(c)
  }

  protected voice(): Voice {
    return { business: this.env.BUSINESS_NAME, signOff: this.env.SIGN_OFF.replace(/\\n/g, '\n'), style: this.env.VOICE }
  }

  protected kernel(c: Registry) {
    c.bind(Clock, () => new SystemClock())
    c.bind(Logger, () => new JsonLogger({ client: this.env.CLIENT_ID }))
  }

  /**
   * Traces every capability and sends logs through telemetry. Cloudflare's own
   * tracing by default; our OTLP exporter when an endpoint is set.
   */
  protected telemetry(c: Registry) {
    const resource = { serviceName: `pf-${this.env.CLIENT_ID}`, serviceVersion: CAPABILITIES_VERSION, environment: this.env.ENVIRONMENT ?? 'production', client: this.env.CLIENT_ID }
    c.bind(Telemetry, c => this.env.OTEL_EXPORTER_OTLP_ENDPOINT
      ? new OtlpTelemetry({ resource, endpoint: this.env.OTEL_EXPORTER_OTLP_ENDPOINT, headers: this.env.OTEL_EXPORTER_OTLP_HEADERS ? c.get(SecretStore).ref('OTEL_EXPORTER_OTLP_HEADERS') : undefined })
      : new CloudflareTelemetry(resource))
    c.bind(Logger, c => new TelemetryLogger(c.get(Telemetry)))
    c.intercept(instrument(() => c.get(Telemetry)))
  }

  protected security(c: Registry) {
    c.bind(SecretStore, () => new CloudflareSecretStore(this.env))
    c.bind(Cipher, c => AesGcmCipher.fromSecret(c.get(SecretStore).ref('KEYRING')))
    c.bind(Signer, c => new HmacSigner(c.get(SecretStore).ref('SIGNING_KEY')))
    c.bind(TokenIssuer, c => new TokenIssuer(c.get(Signer), c.get(Clock)))
    c.bind(Redactor, () => new PatternRedactor())
    // Fails closed: no Access settings, no admin routes. There's no dev bypass in core.
    c.bind(IdentityVerifier, c => {
      need(this.env, 'ACCESS_TEAM', 'ACCESS_AUD')
      return new CloudflareAccessVerifier({ teamDomain: this.env.ACCESS_TEAM, audience: this.env.ACCESS_AUD, cache: c.get(Cache).scoped('access'), clock: c.get(Clock) })
    })
  }

  protected caching(c: Registry) {
    c.bind(Cache, c => new TieredCache([new MemoryCache({ clock: c.get(Clock) }), new EdgeCache(this.env.CLIENT_ID), new KvCache(this.env.KV)], c.get(Clock)))
  }

  protected records(c: Registry) {
    c.bind(AuditLog, c => new D1AuditLog(this.env.DB, c.get(Clock)))
    c.bind(RunLog, () => new D1RunLog(this.env.DB))
    c.bind(ApprovalStore, c => new D1ApprovalStore(this.env.DB, c.get(Cipher)))
    c.bind(UsageMeter, () => this.env.USAGE ? new AnalyticsEngineUsageMeter(this.env.USAGE, this.env.CLIENT_ID) : new MemoryUsageMeter())
  }

  /** Workers AI, through AI Gateway. Outermost first: redact, meter, cache, model. */
  protected ai(c: Registry) {
    c.bind(LanguageModel, c => {
      const base = new WorkersAiModel({ ai: this.env.AI, model: this.env.AI_MODEL, gateway: { id: this.env.AI_GATEWAY_ID || DEFAULT_GATEWAY } })
      const cached = new CachedLanguageModel(base, c.get(Cache).scoped('llm'))
      return new RedactingLanguageModel(new MeteredLanguageModel(cached, c.get(UsageMeter)), c.get(Redactor))
    })
    c.bind(DocumentReader, () => new WorkersAiDocumentReader(this.env.AI, { gateway: { id: this.env.AI_GATEWAY_ID || DEFAULT_GATEWAY } }))
  }

  protected channels(c: Registry) {
    c.bind(Mailer, () => new CloudflareEmailMailer(this.env.EMAIL, { email: this.env.FROM_EMAIL, name: this.env.BUSINESS_NAME }))
    c.bind(PushSubscriptionStore, c => new KvPushSubscriptionStore(this.env.KV, c.get(Cipher)))

    // Owner: push to their phone, Slack if they use it, and email always.
    c.bind(OWNER_NOTIFIER, c => {
      const channels: Notifier[] = []
      if (this.env.VAPID_PUBLIC_KEY && this.env.VAPID_PRIVATE_KEY) {
        channels.push(new WebPushNotifier({
          subscriptions: c.get(PushSubscriptionStore), clock: c.get(Clock),
          vapid: { publicKey: this.env.VAPID_PUBLIC_KEY, privateKey: c.get(SecretStore).ref('VAPID_PRIVATE_KEY'), subject: `mailto:${this.env.FROM_EMAIL}` },
        }))
      }
      if (this.env.SLACK_WEBHOOK_URL) channels.push(new SlackNotifier(c.get(SecretStore).ref('SLACK_WEBHOOK_URL')))
      channels.push(new EmailNotifier(c.get(Mailer), { email: this.env.OWNER_EMAIL }))
      return new FanoutNotifier(channels, 'all')
    })

    // Us. Failures and health alerts never go to the client.
    c.bind(OPS_NOTIFIER, c => {
      if (!this.env.OPS_SLACK_WEBHOOK_URL) throw new ConfigError('OPS_SLACK_WEBHOOK_URL is not set')
      return new SlackNotifier(c.get(SecretStore).ref('OPS_SLACK_WEBHOOK_URL'))
    })
  }

  /** Binds whatever the client has connected. Override to pick differently. */
  protected integrations(c: Registry) {
    if (this.env.XERO_CLIENT_ID) {
      c.bind(XERO_TOKENS, c => this.xeroTokens(c))
      c.bind(XERO, c => {
        need(this.env, 'XERO_CLIENT_SECRET', 'XERO_TENANT_ID')
        return new XeroClient({ tokens: c.get(XERO_TOKENS), tenantId: this.env.XERO_TENANT_ID!, contactCache: c.get(Cache).scoped('xero-contacts').encrypted(c.get(Cipher), 'xero-contacts') })
      })
      c.bind(InvoiceSource, c => new XeroInvoices(c.get(XERO)))
      c.bind(QuoteSource, c => new XeroQuotes(c.get(XERO)))
      c.bind(BillSink, c => new XeroBills(c.get(XERO)))
    }
    if (this.env.SERVICEM8_API_KEY) {
      c.bind(SERVICEM8, c => new ServiceM8Client({ apiKey: c.get(SecretStore).ref('SERVICEM8_API_KEY') }))
      c.bind(JobCardSink, c => new ServiceM8JobCards(c.get(SERVICEM8)))
      if (!c.has(QuoteSource)) c.bind(QuoteSource, c => new ServiceM8Quotes(c.get(SERVICEM8)))
    }
  }

  protected xeroTokens(c: Registry): OAuthTokenProvider {
    const secrets = c.get(SecretStore)
    const opts = {
      http: new HttpClient({ service: 'Xero', allow: XERO_HOSTS }),
      tokenUrl: 'https://identity.xero.com/connect/token',
      clientId: secrets.ref('XERO_CLIENT_ID'),
      clientSecret: secrets.ref('XERO_CLIENT_SECRET'),
      // Tiered with KV underneath, so every isolate shares the one token cron keeps fresh.
      cache: c.get(Cache).scoped('xero-token').encrypted(c.get(Cipher), 'xero-token'),
      cacheKey: 'access',
      clock: c.get(Clock),
    }
    return this.env.XERO_GRANT === 'refresh_token'
      ? new RefreshTokenProvider({ ...opts, kv: this.env.KV, cipher: c.get(Cipher), vaultKey: 'xero' })
      : new ClientCredentialsProvider({ ...opts, scope: 'accounting.transactions accounting.contacts.read' })
  }

  protected approvals(c: Registry) {
    c.bind(ApprovalGate, c => {
      const gate = new ApprovalGate({
        store: c.get(ApprovalStore), tokens: c.get(TokenIssuer), owner: c.get(OWNER_NOTIFIER), audit: c.get(AuditLog),
        clock: c.get(Clock), logger: c.get(Logger), baseUrl: this.env.PUBLIC_URL, ops: c.get(OPS_NOTIFIER),
        approvers: this.env.APPROVERS.split(',').map(s => s.trim()).filter(Boolean),
      })
      gate.register(new SendEmailAction(c.get(Mailer), c.get(AuditLog), { replyTo: { email: this.env.OWNER_EMAIL } }))
      if (c.has(BillSink)) gate.register(new CreateBillAction(c.get(BillSink), c.get(AuditLog)))
      return gate
    })
  }


  protected automationDeps(c: Registry): AutomationDeps {
    return { clock: c.get(Clock), runs: c.get(RunLog), logger: c.get(Logger), ops: c.get(OPS_NOTIFIER) }
  }

  protected chaserDeps(c: Registry): ChaserDeps {
    return { ...this.automationDeps(c), gate: c.get(ApprovalGate), model: c.get(LanguageModel), ledger: c.get(FollowUpLedger), voice: this.voice() }
  }

  protected workflows(c: Registry) {
    c.bind(FollowUpLedger, () => new KvFollowUpLedger(this.env.KV))
    if (c.has(InvoiceSource)) c.bind(InvoiceChaser, c => new InvoiceChaser({ ...this.chaserDeps(c), invoices: c.get(InvoiceSource) }))
    if (c.has(QuoteSource)) c.bind(QuoteChaser, c => new QuoteChaser({ ...this.chaserDeps(c), quotes: c.get(QuoteSource) }))
    if (c.has(JobCardSink)) {
      c.bind(EnquiryIntake, c => new EnquiryIntake({ jobs: c.get(JobCardSink), model: c.get(LanguageModel), owner: c.get(OWNER_NOTIFIER), audit: c.get(AuditLog), logger: c.get(Logger) }))
    }
    if (c.has(BillSink)) {
      c.bind(BillCapture, c => new BillCapture({ reader: c.get(DocumentReader), model: c.get(LanguageModel), gate: c.get(ApprovalGate), clock: c.get(Clock) }))
    }
  }

  /** Everything on a schedule. A client override adds its own automations to the list. */
  protected scheduled(c: Registry): Automation[] {
    const out: Automation[] = []
    if (c.has(InvoiceChaser)) out.push(c.get(InvoiceChaser))
    if (c.has(QuoteChaser)) out.push(c.get(QuoteChaser))
    return out
  }

  /** OAuth connections cron keeps fresh. A client adding one (MYOB, say) adds it here. */
  protected tokenProviders(c: Registry): OAuthTokenProvider[] {
    return c.has(XERO_TOKENS) ? [c.get(XERO_TOKENS)] : []
  }

  protected lookedAfter(c: Registry) {
    c.bind(AUTOMATIONS, c => this.scheduled(c))
    c.bind(TOKEN_PROVIDERS, c => this.tokenProviders(c))
    c.bind(HealthMonitor, c => new HealthMonitor({ automations: c.get(AUTOMATIONS), runs: c.get(RunLog), clock: c.get(Clock), ops: c.get(OPS_NOTIFIER) }))
    c.bind(MonthlyNote, c => new MonthlyNote({
      runs: c.get(RunLog), approvals: c.get(ApprovalStore), clock: c.get(Clock), owner: c.get(OWNER_NOTIFIER),
      labels: { 'invoice-chaser': 'Invoice reminders', 'quote-chaser': 'Quote follow-ups' },
    }))
  }
}
