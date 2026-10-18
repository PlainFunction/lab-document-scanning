import { UpstreamError } from '../kernel/errors'
import { Mailer, Notifier, type EmailAddress, type Notice, type OutboundEmail } from './channel'

/**
 * Cloudflare Email Service (the `send_email` binding). Sends from the client's
 * own domain, so SPF/DKIM line up and replies go where they should.
 *
 * Lock the binding down in wrangler config where the options allow it
 * (allowed senders and destinations), so a bug can only send as the client and only where it should.
 */
export class CloudflareEmailMailer extends Mailer {
  readonly #binding: SendEmail
  readonly #from: EmailAddress
  constructor(binding: SendEmail, from: EmailAddress) {
    super()
    this.#binding = binding
    this.#from = from
  }

  async send(e: OutboundEmail) {
    try {
      const res = await this.#binding.send({
        from: this.#from.name ? { email: this.#from.email, name: this.#from.name } : this.#from.email,
        to: e.to.name ? { email: e.to.email, name: e.to.name } : e.to.email,
        subject: e.subject,
        text: e.text,
        ...(e.html ? { html: e.html } : {}),
        ...(e.replyTo ? { replyTo: e.replyTo.name ? { email: e.replyTo.email, name: e.replyTo.name } : e.replyTo.email } : {}),
        ...(e.reference ? { headers: { 'X-Reference': e.reference } } : {}),
      })
      return { id: (res as { messageId?: string } | undefined)?.messageId }
    } catch (err) {
      // The binding's errors can echo addresses; keep only the reason.
      throw new UpstreamError('Cloudflare Email', 0, err instanceof Error ? err.message.replace(/\S+@\S+/g, '[email]') : '')
    }
  }

  describe() {
    return { name: 'Cloudflare Email Service', use: 'Sending emails the owner has approved', personalInfo: ['name', 'email', 'message'], storesIn: 'Not stored; delivered to the recipient' }
  }
}

/** A notice to the owner, by email. The fallback channel: everyone has email. */
export class EmailNotifier extends Notifier {
  readonly #mailer: Mailer
  readonly #to: EmailAddress
  constructor(mailer: Mailer, to: EmailAddress) {
    super()
    this.#mailer = mailer
    this.#to = to
  }

  async notify(n: Notice) {
    await this.#mailer.send({
      to: this.#to,
      subject: n.title,
      text: n.url ? `${n.body}\n\n${n.url}\n` : `${n.body}\n`,
    })
  }

  describe() {
    return { ...this.#mailer.describe(), name: `Email to owner via ${this.#mailer.describe().name}`, use: 'Telling the owner something needs them', personalInfo: ['owner email'] }
  }
}
