// The parts of Plain Function's capabilities this lab uses. Everything under
// ./core is a copy of capabilities/core in the monorepo, kept in step
// with it automatically, from what this file reaches. Don't edit the
// copies; change capabilities/ and sync. Add a line here to use another part.

// The client Worker this lab extends: default wiring, the HTTP/cron/email runtime, the register.
export { CoreModule, OPS_NOTIFIER, OWNER_NOTIFIER, type CoreEnv } from './core/core-module'
export { createWorker } from './core/runtime/worker'
export { aiUseRegister } from './core/governance/ai-register'

// Scanning: the scanner, where originals go, and reading each file once.
export {
  DocumentScanner, ScanStore, R2ScanStore, MemoryScanStore, CachedDocumentReader, MAX_SCAN_BYTES, SCAN_TYPES, KIND_LABELS,
  type ScanRecord, type ScanResult,
} from './core/scanning/index'

// Kernel
export { Port, mergeManifest, type Manifest } from './core/kernel/port'
export { Module, Registry } from './core/kernel/registry'
export { CapabilityError, NotAllowedError, ValidationError } from './core/kernel/errors'
export { Clock, FixedClock } from './core/kernel/clock'
export { Logger, MemoryLogger } from './core/kernel/logger'
export { sha256Hex, utf8 } from './core/kernel/encoding'

// Reading and AI
export { DocumentReader, PlainTextReader, type InboundFile } from './core/ai/document-reader'
export { LanguageModel, ScriptedLanguageModel, type CompletionRequest } from './core/ai/language-model'

// Bills and approval
export { BillCapture } from './core/workflows/bill-capture'
export { BillSink, type BillDraft } from './core/integrations/accounting'
export { ApprovalGate } from './core/approvals/approval-gate'
export { MemoryApprovalStore } from './core/approvals/approval-store'
export { CreateBillAction } from './core/approvals/actions'

// Security, caching, records
export { IdentityVerifier, FixedIdentityVerifier, type Principal } from './core/security/identity'
export { HmacSigner, TokenIssuer } from './core/security/signer'
export { Cipher } from './core/security/cipher'
export { Cache } from './core/cache/cache'
export { MemoryCache } from './core/cache/adapters'
export { AuditLog, MemoryAuditLog } from './core/audit/audit-log'
export { MemoryNotifier, Notifier, type Notice } from './core/channels/channel'
export { Telemetry } from './core/telemetry/telemetry'
