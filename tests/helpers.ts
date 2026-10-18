import {
  ApprovalGate, BillCapture, BillSink, CreateBillAction, DocumentScanner, FixedClock, HmacSigner, MemoryApprovalStore, MemoryAuditLog,
  MemoryLogger, MemoryNotifier, MemoryScanStore, PlainTextReader, ScriptedLanguageModel, TokenIssuer, utf8,
  type BillDraft, type CompletionRequest, type DocumentReader, type InboundFile, type Principal,
} from '#capabilities'

export const OWNER: Principal = { id: 'dan@harbour.example', email: 'dan@harbour.example', kind: 'person', via: 'test' }

export class FakeBills extends BillSink {
  bills: BillDraft[] = []
  async createDraftBill(bill: BillDraft) { this.bills.push(bill); return { id: `bill-${this.bills.length}` } }
  describe() { return { name: 'fake', use: '', personalInfo: [], storesIn: '' } }
}

export const RECEIPT = [
  'REECE PLUMBING  Brookvale', 'TAX INVOICE  ABN 12 345 678 901', 'Date: 14/10/2026',
  '2 x PEX 20mm elbow   $11.00', '1 x Tempering valve 15mm   $89.50', 'TOTAL (inc GST)  $111.50',
].join('\n')

export const JOB_SHEET = [
  'HARBOUR PLUMBING - JOB SHEET', 'Customer: Jane Citizen, 12 Example St, Manly', 'Work: replaced kitchen mixer',
  'Hours: 1.5', 'Signed: J. Citizen   Date: 13/10/2026',
].join('\n')

export const BILL: BillDraft = {
  supplierName: 'Reece Plumbing', issuedOn: '2026-10-14', currency: 'AUD', taxInclusive: true, total: 111.5,
  lines: [{ description: 'PEX 20mm elbow', quantity: 2, unitAmount: 11 }, { description: 'Tempering valve 15mm', quantity: 1, unitAmount: 89.5 }],
}

export const photo = (text: string, name = 'IMG_0412.jpg', type = 'image/jpeg'): InboundFile => ({ name, type, bytes: utf8(text) })

/** Reads "photos" as their text, and counts how often it was asked. */
export class CountingReader extends PlainTextReader {
  reads = 0
  async toText(file: InboundFile) { this.reads++; return super.toText(file) }
}

/** Answers the scanner's question and BillCapture's from one script, by feature. */
export const model = (classify: object | string, bill: object = BILL) => new ScriptedLanguageModel((req: CompletionRequest) =>
  req.feature === 'bill-capture' ? JSON.stringify(bill) : typeof classify === 'string' ? classify : JSON.stringify(classify))

export function scanner(opts: { reader?: DocumentReader; model?: ScriptedLanguageModel; withBills?: boolean } = {}) {
  const clock = new FixedClock('2026-10-15T00:00:00Z')
  const audit = new MemoryAuditLog(clock)
  const logger = new MemoryLogger()
  const owner = new MemoryNotifier()
  const store = new MemoryScanStore()
  const sink = new FakeBills()
  const reader = opts.reader ?? new CountingReader()
  const m = opts.model ?? model({ kind: 'bill', title: 'Reece receipt, PEX fittings', date: '2026-10-14' })
  const gate = new ApprovalGate({
    store: new MemoryApprovalStore(), tokens: new TokenIssuer(new HmacSigner('x'.repeat(32)), clock), owner, ops: new MemoryNotifier(),
    audit, clock, logger, baseUrl: 'https://ops.example', approvers: [OWNER.email!],
  })
  gate.register(new CreateBillAction(sink, audit))
  const bills = opts.withBills === false ? undefined : new BillCapture({ reader, model: m, gate, clock })
  const scan = new DocumentScanner({ reader, model: m, store, audit, clock, logger, bills })
  return { scan, store, audit, logger, owner, sink, gate, reader, model: m }
}
