import { KIND_LABELS, type ScanRecord, type ScanResult } from '#capabilities'

// Server-rendered, no scripts. The form is a plain file input, so it works on
// any phone browser and the CSP can forbid scripts outright.

export const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

export const PAGE_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
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
  h1 { font-size:1.4rem; margin:0 0 8px; } h2 { font-size:1.1rem; margin:32px 0 8px; } p { color:var(--body); }
  input[type=file] { display:block; width:100%; box-sizing:border-box; padding:16px; border:1px dashed var(--line); border-radius:8px; font:inherit; }
  button, .button { display:inline-block; font:inherit; padding:12px 20px; margin-top:12px; border-radius:8px; border:1px solid var(--accent); background:var(--accent); color:#fff; cursor:pointer; text-decoration:none; }
  ul { list-style:none; padding:0; margin:0; } li { padding:10px 0; border-top:1px solid var(--line); }
  li a { color:inherit; } .meta { color:var(--body); font-size:.9rem; }
</style></head><body><main>${body}</main></body></html>`

const when = (iso: string) => new Date(iso).toLocaleString('en-AU', { timeZone: 'Australia/Sydney', dateStyle: 'medium', timeStyle: 'short' })

export function scanPage(recent: ScanRecord[]) {
  const rows = recent.map(r => `<li><a href="/scans/${esc(r.id)}">${esc(r.title)}</a><br><span class="meta">${esc(KIND_LABELS[r.kind])}${r.date ? `, dated ${esc(r.date)}` : ''}. Scanned ${esc(when(r.scannedAt))}${r.routedTo ? '. Waiting for approval' : ''}</span></li>`).join('')
  return shell('Scan a document', `
<h1>Scan a document</h1>
<p>Take a photo of a receipt, bill, docket or signed job sheet, or pick a PDF. Bills go to the owner to approve before anything reaches the accounts.</p>
<form method="post" action="/scan" enctype="multipart/form-data">
  <input type="file" name="file" accept="image/jpeg,image/png,image/webp,application/pdf" required>
  <button>Scan it</button>
</form>
${recent.length ? `<h2>Recent scans</h2><ul>${rows}</ul>` : ''}`)
}

export function resultPage(result: ScanResult) {
  if (result.status === 'unreadable') {
    return shell('Couldn\'t read that', `<h1>Couldn't read that</h1><p>There wasn't enough text in the photo. Try again with more light, flat on a table, with the whole page in frame.</p><a class="button" href="/scan">Try again</a>`)
  }
  const r = result.record
  const next = result.status === 'duplicate'
    ? 'This one was already scanned, so nothing new was filed.'
    : r.routedTo ? 'It\'s waiting for the owner to approve before it goes into the accounts.' : 'It\'s filed.'
  return shell('Scanned', `<h1>${esc(r.title)}</h1><p>${esc(KIND_LABELS[r.kind])}${r.date ? `, dated ${esc(r.date)}` : ''}. ${esc(next)}</p><a class="button" href="/scan">Scan another</a>`)
}

export function messagePage(title: string, message: string) {
  return shell(title, `<h1>${esc(title)}</h1><p>${esc(message)}</p><a class="button" href="/scan">Back</a>`)
}
