import {
  AuditLog, BillCapture, BillSink, Cache, CachedDocumentReader, Cipher, Clock, CoreModule, DocumentReader, DocumentScanner, IdentityVerifier,
  LanguageModel, Logger, OPS_NOTIFIER, OWNER_NOTIFIER, R2ScanStore, ScanStore, type CoreEnv, type Registry,
} from '#capabilities'
import { DevIdentityVerifier, LogBillSink, LogNotifier } from './dev'

// The scanner as one more piece of a client's Worker. Everything else (Access,
// the approval gate, Xero, Workers AI with redaction and metering, telemetry)
// is the core wiring, unchanged.
//
// With ENVIRONMENT = "development" (.dev.vars, for wrangler dev) the parts that
// need a real account get stand-ins from ./dev: sign-in as the owner on
// localhost, notices in the terminal, and a Xero that logs the bill. Workers AI
// and R2 stay real (R2 is wrangler's local copy).

export interface ScanningEnv extends CoreEnv {
  SCANS: R2Bucket
}

export class ScanningModule extends CoreModule {
  protected declare readonly env: ScanningEnv

  get dev() { return this.env.ENVIRONMENT === 'development' }

  protected security(c: Registry) {
    super.security(c)
    if (this.dev) c.bind(IdentityVerifier, () => new DevIdentityVerifier(this.env.OWNER_EMAIL))
  }

  protected records(c: Registry) {
    super.records(c)
    c.bind(ScanStore, () => new R2ScanStore(this.env.SCANS))
  }

  protected ai(c: Registry) {
    super.ai(c)
    // One read per file, shared by the scanner and BillCapture.
    c.decorate(DocumentReader, (inner, c) => new CachedDocumentReader(inner, c.get(Cache).scoped('doc-text').encrypted(c.get(Cipher), 'doc-text')))
  }

  protected channels(c: Registry) {
    super.channels(c)
    if (!this.dev) return
    c.bind(OWNER_NOTIFIER, c => new LogNotifier(c.get(Logger), 'owner'))
    if (!this.env.OPS_SLACK_WEBHOOK_URL) c.bind(OPS_NOTIFIER, c => new LogNotifier(c.get(Logger), 'ops'))
  }

  protected integrations(c: Registry) {
    super.integrations(c)
    // No Xero in dev: bills still go through approval, then to the terminal.
    if (this.dev && !c.has(BillSink)) c.bind(BillSink, c => new LogBillSink(c.get(Logger)))
  }

  protected workflows(c: Registry) {
    super.workflows(c)
    c.bind(DocumentScanner, c => new DocumentScanner({
      reader: c.get(DocumentReader), model: c.get(LanguageModel), store: c.get(ScanStore), audit: c.get(AuditLog),
      clock: c.get(Clock), logger: c.get(Logger),
      // Bound only when Xero is connected. Without it, bills are filed like everything else.
      bills: c.has(BillCapture) ? c.get(BillCapture) : undefined,
    }))
  }
}
