import { HttpClient, type Fetch } from '../../security/egress'
import { UpstreamError } from '../../kernel/errors'
import type { Cache } from '../../cache/cache'
import type { OAuthTokenProvider } from '../oauth'
import { BillSink, InvoiceSource, QuoteSource, type BillDraft, type Contact, type Invoice, type Quote } from '../accounting'

// Xero Accounting API. One XeroClient per connected organisation, shared by the
// small adapters below, so each port gets only what it needs.
//
// Scopes: accounting.transactions (invoices, quotes, bills) and
// accounting.contacts.read (emails for reminders). Nothing broader.

export const XERO_HOSTS = ['api.xero.com', 'identity.xero.com']

export class XeroClient {
  readonly http: HttpClient
  readonly #tokens: OAuthTokenProvider
  readonly #tenantId: string
  readonly #contacts: Cache

  constructor(opts: { tokens: OAuthTokenProvider; tenantId: string; contactCache: Cache; fetch?: Fetch }) {
    this.http = new HttpClient({ service: 'Xero', allow: XERO_HOSTS, fetch: opts.fetch })
    this.#tokens = opts.tokens
    this.#tenantId = opts.tenantId
    this.#contacts = opts.contactCache
  }

  async call<T>(path: string, init: RequestInit = {}, retried = false): Promise<T> {
    const res = await this.http.request(`https://api.xero.com/api.xro/2.0${path}`, {
      ...init,
      headers: {
        ...init.headers,
        authorization: `Bearer ${await this.#tokens.accessToken()}`,
        'xero-tenant-id': this.#tenantId,
        accept: 'application/json',
      },
    })
    if (res.status === 401 && !retried) {
      await this.#tokens.reset()
      return this.call<T>(path, init, true)
    }
    if (!res.ok) throw new UpstreamError('Xero', res.status, await res.text().catch(() => ''))
    return res.json() as Promise<T>
  }

  /** Every page of a list endpoint. Xero pages are 100 long. */
  async all<K extends string, T>(path: string, key: K): Promise<T[]> {
    const out: T[] = []
    for (let page = 1; page < 50; page++) {
      const sep = path.includes('?') ? '&' : '?'
      const batch = (await this.call<Record<K, T[]>>(`${path}${sep}page=${page}`))[key] ?? []
      out.push(...batch)
      if (batch.length < 100) break
    }
    return out
  }

  /** Fills in contact emails, which list endpoints leave out. Cached (encrypted) for a day. */
  async withEmails(contacts: Contact[]): Promise<Map<string, Contact>> {
    const result = new Map<string, Contact>()
    const missing: string[] = []
    for (const c of contacts) {
      if (result.has(c.id)) continue
      const hit = await this.#contacts.get<Contact>(c.id)
      if (hit) result.set(c.id, hit)
      else if (!missing.includes(c.id)) missing.push(c.id)
    }
    for (let i = 0; i < missing.length; i += 50) {
      const ids = missing.slice(i, i + 50).join(',')
      const { Contacts } = await this.call<{ Contacts: XeroContact[] }>(`/Contacts?IDs=${ids}`)
      for (const x of Contacts ?? []) {
        const c = toContact(x)
        result.set(c.id, c)
        await this.#contacts.set(c.id, c, 24 * 3600)
      }
    }
    return result
  }
}

interface XeroContact { ContactID: string; Name: string; EmailAddress?: string }
const toContact = (x: XeroContact): Contact => ({ id: x.ContactID, name: x.Name, email: x.EmailAddress || undefined })
const day = (s?: string) => (s ? s.slice(0, 10) : '')

const XERO_MANIFEST = { personalInfo: ['customer name', 'customer email'], storesIn: "Xero (the client's own account)", egress: XERO_HOSTS }

interface XeroInvoice {
  InvoiceID: string; InvoiceNumber: string; Contact: XeroContact; Total: number; AmountDue: number
  CurrencyCode: string; DateString: string; DueDateString: string
}

export class XeroInvoices extends InvoiceSource {
  readonly #xero: XeroClient
  constructor(xero: XeroClient) { super(); this.#xero = xero }

  async outstanding(): Promise<Invoice[]> {
    const where = encodeURIComponent('Type=="ACCREC" AND AmountDue>0')
    const rows = await this.#xero.all<'Invoices', XeroInvoice>(`/Invoices?Statuses=AUTHORISED&where=${where}&summaryOnly=true`, 'Invoices')
    const contacts = await this.#xero.withEmails(rows.map(r => toContact(r.Contact)))
    return rows.map(r => ({
      id: r.InvoiceID, number: r.InvoiceNumber, contact: contacts.get(r.Contact.ContactID) ?? toContact(r.Contact),
      total: r.Total, amountDue: r.AmountDue, currency: r.CurrencyCode, issuedOn: day(r.DateString), dueOn: day(r.DueDateString),
    }))
  }

  describe() { return { name: 'Xero (invoices)', use: 'Finding unpaid invoices to follow up', ...XERO_MANIFEST } }
}

interface XeroQuote {
  QuoteID: string; QuoteNumber: string; Contact: XeroContact; Total: number; CurrencyCode: string
  DateString: string; ExpiryDateString?: string; Title?: string
}

export class XeroQuotes extends QuoteSource {
  readonly #xero: XeroClient
  constructor(xero: XeroClient) { super(); this.#xero = xero }

  async open(): Promise<Quote[]> {
    const rows = await this.#xero.all<'Quotes', XeroQuote>('/Quotes?Status=SENT', 'Quotes')
    const contacts = await this.#xero.withEmails(rows.map(r => toContact(r.Contact)))
    return rows.map(r => ({
      id: r.QuoteID, number: r.QuoteNumber, contact: contacts.get(r.Contact.ContactID) ?? toContact(r.Contact),
      total: r.Total, currency: r.CurrencyCode, sentOn: day(r.DateString), expiresOn: day(r.ExpiryDateString) || undefined, title: r.Title,
    }))
  }

  describe() { return { name: 'Xero (quotes)', use: 'Finding quotes with no reply to follow up', ...XERO_MANIFEST } }
}

export class XeroBills extends BillSink {
  readonly #xero: XeroClient
  constructor(xero: XeroClient) { super(); this.#xero = xero }

  async createDraftBill(b: BillDraft, opts: { idempotencyKey?: string } = {}) {
    const body = {
      Invoices: [{
        Type: 'ACCPAY',
        Status: 'DRAFT',
        Contact: { Name: b.supplierName },
        Date: b.issuedOn,
        ...(b.dueOn ? { DueDate: b.dueOn } : {}),
        ...(b.reference ? { InvoiceNumber: b.reference } : {}),
        CurrencyCode: b.currency,
        LineAmountTypes: b.taxInclusive ? 'Inclusive' : 'Exclusive',
        LineItems: b.lines.map(l => ({ Description: l.description, Quantity: l.quantity, UnitAmount: l.unitAmount, ...(l.accountCode ? { AccountCode: l.accountCode } : {}) })),
      }],
    }
    const res = await this.#xero.call<{ Invoices: { InvoiceID: string }[] }>('/Invoices', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(opts.idempotencyKey ? { 'idempotency-key': opts.idempotencyKey } : {}) },
      body: JSON.stringify(body),
    })
    return { id: res.Invoices[0].InvoiceID }
  }

  describe() { return { name: 'Xero (bills)', use: 'Adding supplier bills as drafts', personalInfo: [], storesIn: "Xero (the client's own account)", checkedBy: 'Owner approves each bill, then it lands as a draft', egress: XERO_HOSTS } }
}
