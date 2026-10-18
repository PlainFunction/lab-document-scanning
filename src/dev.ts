import { BillSink, IdentityVerifier, Logger, NotAllowedError, Notifier, type BillDraft, type Notice, type Principal } from '#capabilities'

// Stand-ins for `wrangler dev` (ENVIRONMENT = "development"), so the lab runs
// on a laptop with no Access app, Slack or Xero. Workers AI is still real:
// reading photos is the experiment. None of this is in core, which has no dev
// bypass, and each one refuses anything that isn't localhost.

const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]'])

/** Signs everyone in as the owner, but only on localhost. Deployed, it refuses every request. */
export class DevIdentityVerifier extends IdentityVerifier {
  readonly #who: Principal
  constructor(email: string) {
    super()
    this.#who = { id: email, email, kind: 'person', via: 'dev' }
  }
  async verify(request: Request): Promise<Principal> {
    if (!LOCAL.has(new URL(request.url).hostname)) throw new NotAllowedError('The dev sign-in only works on localhost')
    return this.#who
  }
  describe() {
    return { name: 'Dev sign-in (localhost only)', use: 'Trying the lab with wrangler dev', personalInfo: [], storesIn: 'Nowhere' }
  }
}

/** Notices to the terminal, so the approval link shows up where you're watching. */
export class LogNotifier extends Notifier {
  readonly #logger: Logger
  readonly #who: string
  constructor(logger: Logger, who: string) {
    super()
    this.#logger = logger
    this.#who = who
  }
  async notify(n: Notice) {
    this.#logger.info('dev.notice', { to: this.#who, title: n.title, body: n.body, url: n.url })
  }
  describe() { return { name: `Terminal (${this.#who}, dev only)`, use: 'Showing notices in wrangler dev', personalInfo: [], storesIn: 'Terminal' } }
}

/** Stands in for Xero: an approved bill goes to the terminal, not the accounts. */
export class LogBillSink extends BillSink {
  readonly #logger: Logger
  #n = 0
  constructor(logger: Logger) {
    super()
    this.#logger = logger
  }
  async createDraftBill(bill: BillDraft) {
    const id = `dev-bill-${++this.#n}`
    this.#logger.info('dev.bill', { id, supplier: bill.supplierName, total: bill.total, issuedOn: bill.issuedOn, lines: bill.lines.length })
    return { id }
  }
  describe() { return { name: 'Xero stand-in (dev only)', use: 'Trying bill approval without Xero', personalInfo: ['supplier details'], storesIn: 'Terminal' } }
}
