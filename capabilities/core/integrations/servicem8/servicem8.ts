import { HttpClient, type Fetch } from '../../security/egress'
import { UpstreamError } from '../../kernel/errors'
import type { SecretRef } from '../../secrets/secrets'
import { JobCardSink, type JobCardDraft } from '../job-system'
import { QuoteSource, type Quote } from '../accounting'

// ServiceM8 REST API (api_1.0). Authenticates with a private-app API key,
// which belongs to the client's ServiceM8 account and can be revoked there.
// Uses only: company (create), job (create, read quotes), jobcontact (create).

export const SERVICEM8_HOSTS = ['api.servicem8.com']

export class ServiceM8Client {
  readonly http: HttpClient
  readonly #key: SecretRef

  constructor(opts: { apiKey: SecretRef; fetch?: Fetch }) {
    this.http = new HttpClient({ service: 'ServiceM8', allow: SERVICEM8_HOSTS, fetch: opts.fetch })
    this.#key = opts.apiKey
  }

  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const res = await this.http.request(`https://api.servicem8.com/api_1.0${path}`, {
      ...init,
      headers: { ...init.headers, 'x-api-key': (await this.#key.get()).reveal(), accept: 'application/json' },
    })
    if (!res.ok) throw new UpstreamError('ServiceM8', res.status, await res.text().catch(() => ''))
    return res
  }

  /** Creates a record and returns its uuid (ServiceM8 sends it back in a header). */
  async create(path: string, body: Record<string, unknown>): Promise<string> {
    const res = await this.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const uuid = res.headers.get('x-record-uuid')
    if (!uuid) throw new UpstreamError('ServiceM8', res.status, 'no record uuid returned')
    return uuid
  }
}

const splitName = (name: string) => {
  const parts = name.trim().split(/\s+/)
  return { first: parts[0] ?? '', last: parts.slice(1).join(' ') }
}

export class ServiceM8JobCards extends JobCardSink {
  readonly #sm8: ServiceM8Client
  constructor(sm8: ServiceM8Client) { super(); this.#sm8 = sm8 }

  async createJobCard(card: JobCardDraft) {
    const companyUuid = await this.#sm8.create('/company.json', { name: card.customer.name, ...(card.customer.email ? { email: card.customer.email } : {}) })
    const jobUuid = await this.#sm8.create('/job.json', {
      status: 'Quote',
      company_uuid: companyUuid,
      job_address: card.address ?? '',
      job_description: `${card.urgent ? '[URGENT] ' : ''}${card.description}\n\n(From ${card.source})`,
    })
    await this.#sm8.create('/jobcontact.json', {
      job_uuid: jobUuid,
      type: 'JOB',
      ...splitName(card.customer.name),
      ...(card.customer.email ? { email: card.customer.email } : {}),
      ...(card.customer.phone ? { mobile: card.customer.phone } : {}),
    })
    return { id: jobUuid }
  }

  describe() {
    return { name: 'ServiceM8 (job cards)', use: 'Turning enquiries into job cards', personalInfo: ['name', 'email', 'phone', 'address'], storesIn: "ServiceM8 (the client's own account)", egress: SERVICEM8_HOSTS }
  }
}

interface Sm8Job { uuid: string; generated_job_id: string; company_uuid: string; status: string; quote_date?: string; quote_sent?: string; total_invoice_amount?: string; job_description?: string; active: number }
interface Sm8Contact { job_uuid: string; first?: string; last?: string; email?: string; type?: string; active: number }

/** Jobs sitting in the Quote state with a quote sent. */
export class ServiceM8Quotes extends QuoteSource {
  readonly #sm8: ServiceM8Client
  constructor(sm8: ServiceM8Client) { super(); this.#sm8 = sm8 }

  async open(): Promise<Quote[]> {
    const filter = encodeURIComponent("status eq 'Quote'")
    const jobs = (await (await this.#sm8.request(`/job.json?$filter=${filter}`)).json() as Sm8Job[])
      .filter(j => j.active === 1 && j.quote_sent && j.quote_sent !== '0000-00-00 00:00:00')
    return Promise.all(jobs.map(async j => {
      const byJob = encodeURIComponent(`job_uuid eq '${j.uuid.replace(/[^0-9a-f-]/gi, '')}'`)
      const contacts = (await (await this.#sm8.request(`/jobcontact.json?$filter=${byJob}`)).json() as Sm8Contact[]).filter(c => c.active === 1)
      const c = contacts.find(x => x.type === 'JOB') ?? contacts[0]
      const name = [c?.first, c?.last].filter(Boolean).join(' ') || 'there'
      return {
        id: j.uuid, number: j.generated_job_id, contact: { id: j.company_uuid, name, email: c?.email || undefined },
        total: Number(j.total_invoice_amount ?? 0), currency: 'AUD', sentOn: (j.quote_sent ?? '').slice(0, 10),
        title: j.job_description?.split('\n')[0]?.slice(0, 80),
      }
    }))
  }

  describe() {
    return { name: 'ServiceM8 (quotes)', use: 'Finding quotes with no reply to follow up', personalInfo: ['name', 'email'], storesIn: "ServiceM8 (the client's own account)", egress: SERVICEM8_HOSTS }
  }
}
