// The approval page. Server-rendered, no scripts, no third-party anything.
// Every value is escaped; the CSP below forbids scripts outright.

export const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

export const SECURE_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  // Not no-referrer: with it, a browser posts the form with "Origin: null" and the cross-site check refuses it.
  'referrer-policy': 'same-origin',
  'x-content-type-options': 'nosniff',
}

const shell = (title: string, body: string) => `<!doctype html>
<html lang="en-AU"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root { color-scheme: light dark; --bg:#F7F7FF; --ink:#131112; --body:#60656F; --line:#d9dae3; --accent:#279AF1; }
  @media (prefers-color-scheme: dark) { :root { --bg:#131112; --ink:#F7F7FF; --body:#a9adb6; --line:#33313a; } }
  body { margin:0; background:var(--bg); color:var(--ink); font:16px/1.5 system-ui, sans-serif; }
  main { max-width:40rem; margin:0 auto; padding:24px 16px 48px; }
  h1 { font-size:1.4rem; margin:0 0 4px; } p, dt { color:var(--body); }
  dl { display:grid; grid-template-columns:max-content 1fr; gap:4px 16px; margin:20px 0; } dd { margin:0; overflow-wrap:anywhere; }
  textarea { width:100%; box-sizing:border-box; min-height:14rem; font:inherit; padding:12px; border:1px solid var(--line); border-radius:8px; background:transparent; color:inherit; }
  .row { display:flex; gap:12px; margin-top:16px; flex-wrap:wrap; }
  button { font:inherit; padding:10px 18px; border-radius:8px; border:1px solid var(--line); background:transparent; color:inherit; cursor:pointer; }
  button.yes { background:var(--accent); border-color:var(--accent); color:#fff; }
  .note { font-size:.9rem; }
</style></head><body><main>${body}</main></body></html>`

export function approvalPage(opts: {
  id: string; token: string; summary: string; ai: boolean; status: string; expiresAt: string
  preview: { heading: string; fields: [string, string][]; body?: string }
}) {
  const { preview: p } = opts
  const fields = p.fields.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')
  const pending = opts.status === 'pending'
  const body = pending && p.body !== undefined
    ? `<label for="body" class="note">You can change the wording before it goes.</label><textarea id="body" name="body">${esc(p.body)}</textarea>`
    : p.body !== undefined ? `<pre style="white-space:pre-wrap">${esc(p.body)}</pre>` : ''
  const expires = new Date(opts.expiresAt).toLocaleString('en-AU', { timeZone: 'Australia/Sydney', dateStyle: 'medium', timeStyle: 'short' })

  return shell(p.heading, `
<p class="note">${esc(opts.summary)}</p>
<h1>${esc(p.heading)}</h1>
${opts.ai ? '<p class="note">Drafted by AI from your records. Check it reads right.</p>' : ''}
<dl>${fields}</dl>
${pending ? `<form method="post" action="/approvals/${esc(opts.id)}">
  <input type="hidden" name="t" value="${esc(opts.token)}">
  ${body}
  <div class="row"><button class="yes" name="decision" value="approve">Yes, go ahead</button><button name="decision" value="reject">No, leave it</button></div>
  <p class="note">Waits for you until ${esc(expires)}.</p>
</form>` : `${body}<p><strong>Already ${esc(opts.status)}.</strong></p>`}`)
}

export function messagePage(title: string, message: string) {
  return shell(title, `<h1>${esc(title)}</h1><p>${esc(message)}</p>`)
}
