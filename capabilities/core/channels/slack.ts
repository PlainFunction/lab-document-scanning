import { UpstreamError } from '../kernel/errors'
import { HttpClient, type Fetch } from '../security/egress'
import type { SecretRef } from '../secrets/secrets'
import { Notifier, type Notice } from './channel'

// Slack reads <...> as links and mentions, so text from anywhere else is escaped.
const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * A Slack incoming webhook. The URL is the credential, so it's a secret and
 * never logged. Notices should say *that* something needs doing and link to
 * it; customer details stay out of Slack.
 */
export class SlackNotifier extends Notifier {
  readonly #webhook: SecretRef
  readonly #http: HttpClient

  constructor(webhook: SecretRef, opts: { fetch?: Fetch } = {}) {
    super()
    this.#webhook = webhook
    this.#http = new HttpClient({ service: 'Slack', allow: ['hooks.slack.com'], fetch: opts.fetch })
  }

  async notify(n: Notice) {
    const text = `*${escape(n.title)}*\n${escape(n.body)}`
    const blocks: Record<string, unknown>[] = [{ type: 'section', text: { type: 'mrkdwn', text } }]
    if (n.url) {
      blocks.push({
        type: 'actions',
        elements: [{ type: 'button', style: 'primary', text: { type: 'plain_text', text: 'Open' }, url: n.url }],
      })
    }
    const res = await this.#http.request((await this.#webhook.get()).reveal(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, blocks }),
    })
    if (!res.ok) throw new UpstreamError('Slack', res.status, await res.text().catch(() => ''))
  }

  describe() {
    return { name: 'Slack', use: 'Telling the owner something needs them', personalInfo: [], storesIn: 'Slack workspace (notice text only)', egress: ['hooks.slack.com'] }
  }
}
