# Lab 005: scanning paperwork from a phone

The code behind our lab [We Scanned a Power Bill for About a Tenth of a Cent](https://plainfunction.com.au/labs/document-scanning).
Someone photographs a receipt, bill, delivery docket or signed job sheet. The
Worker reads it with Workers AI, works out what it is, keeps the original in
R2, and sends bills on for the owner to approve before they land in Xero as
drafts.

```bash
npm install
npm test          # this Worker's tests (in workerd)
npm run typecheck
npm run dev       # wrangler dev on http://localhost:8788
npm run deploy    # wrangler deploy, once wrangler.toml is filled in
```

## Running it locally

1. `npx wrangler login`. Workers AI reads the photos and always runs on
   Cloudflare, even in `wrangler dev`. Every call goes through AI Gateway
   (`AI_GATEWAY_ID`, or "default", which Cloudflare makes on the first call).
2. `npm run dev:secrets` writes `.dev.vars` with a `KEYRING`, a
   `SIGNING_KEY` and `ENVIRONMENT=development`. It never replaces a value
   that's there.
3. `npm run db:local` applies the schema to wrangler dev's local D1.
4. `npm run dev` and open http://localhost:8788.

With `ENVIRONMENT=development` the parts that need a real account get
stand-ins (`src/dev.ts`): you're signed in as `OWNER_EMAIL` with no Access
app, and only on localhost; notices, including the approval link, go to the
terminal; and with no Xero, an approved bill goes to the terminal too. So the
whole path runs on a laptop: photo, read, sorted, filed in (local) R2, bill
waiting for approval, approve, bill created. D1, KV and R2 are wrangler's
local copies, in `.wrangler/`.

## Deploying it

1. Make the storage, then put the KV and D1 ids in `wrangler.toml`:
   ```bash
   npx wrangler kv namespace create lab-document-scanning
   npx wrangler d1 create lab-document-scanning --location oc
   npx wrangler r2 bucket create lab-document-scanning-scans --location oc
   npm run db:remote
   ```
2. Pick the address (`routes` and `PUBLIC_URL`) and put a Cloudflare Access
   application in front of it (Zero Trust, Access, Applications). Its team name
   and AUD tag go in `ACCESS_TEAM` and `ACCESS_AUD`. There are no workers.dev
   or preview URLs, so Access is the only way in.
3. Set `APPROVERS`, `OWNER_EMAIL` and `FROM_EMAIL`. The owner hears by
   email (Cloudflare Email Service, the `send_email` binding), so `FROM_EMAIL`
   must be on a domain set up for sending in your Cloudflare account.
4. Secrets: `npx wrangler secret put <NAME>` for `KEYRING` and
   `SIGNING_KEY` (new ones, not the dev ones) and `OPS_SLACK_WEBHOOK_URL`.
   For bills into Xero, also `XERO_CLIENT_ID` and `XERO_CLIENT_SECRET`, with
   `XERO_TENANT_ID` in `wrangler.toml`.
5. `npm run deploy`.

`ENVIRONMENT` stays `production` in `wrangler.toml`. Even if it were set to
`development` there, the dev sign-in refuses anything that isn't localhost.

## What it uses from capabilities

`capabilities/` holds copies of the parts of our capabilities it uses, so it
runs on its own. `capabilities/index.ts` says which parts, and the copies are kept in step
with ours automatically. **Don't
edit the copies**: they're overwritten from the source on every sync.

The lab is one client's Worker with scanning added, so it uses most of the
core: the default wiring (`CoreModule`) and runtime (`createWorker`), Cloudflare
Access, `DocumentReader` (`env.AI.toMarkdown`), `LanguageModel` with redaction,
metering and caching, `BillCapture`, `ApprovalGate`, the encrypted cache, the
audit log and telemetry. `capabilities/core/schema.sql` has the D1 tables the
approvals and audit log need. Each module's `README.spec.md` describes its
ports and adapters; their own tests stay with the source, so they aren't in
this copy.

Scanning itself is our `scanning` capability (`capabilities/core/scanning`):

- `DocumentScanner`: checks the type and size, skips a file it has already
  filed (by hash), reads, sorts, files, sends bills on, and records it in the
  audit log. A model reply that doesn't fit is filed as "Unsorted scan".
- `ScanStore` with `R2ScanStore`: originals keyed by SHA-256, the record in R2
  custom metadata, so one list call gives the recent scans.
- `CachedDocumentReader`: the sorting step and `BillCapture` share one
  `toMarkdown` call per file.
- `scanTools()`: the same thing as tools, for our app and our Slack agent.

## What this lab adds

| Piece | What it is |
|---|---|
| `ScanningModule` (`src/module.ts`) | `CoreModule` with scanning bound in: R2 for the originals, the read-once cache in front of the reader, and bills to `BillCapture` only when Xero is connected. |
| `createScanningWorker` (`src/worker.ts`) | The core Worker plus `GET/POST /scan` and `GET /scans/:id`, behind Access. |
| `src/pages.ts` | The form and result pages. Server-rendered, no scripts, strict CSP. Takes PDFs as well as photos. |

`wrangler.toml` is the config for one client's Worker, with the `SCANS`
bucket added. `src/dev.ts` holds the stand-ins `npm run dev` uses.

## Checked, and not yet checked

Tested against stand-ins: here, the pages, escaping, the CSP, Access,
cross-site posts and the wiring; with the scanning capability, the whole path
from a photo to approval, duplicates, unreadable photos, a model reply that
doesn't fit, bill capture failing, and R2 storage (including R2 refusing bytes
that don't match the hash).

Not yet run against the real thing:
- **`toMarkdown` on phone photos** of real receipts, crumpled dockets and
  handwriting. This is the experiment. The 40-character "too blurry" threshold
  is a guess until then.
- **Classification accuracy** with the default Llama 3.3 model.
- **Cost per scan** (`toMarkdown` on images runs a vision model, plus one
  classification and, for bills, one extraction).
- **iOS and Android uploads.** We expect JPEG, not HEIC, because the form's
  `accept` doesn't list HEIC. Check on a real iPhone.
- **Large PDFs.** Text is cut at 20,000 characters before the model sees it.

## Ideas for later

- Put `CachedDocumentReader` in front of bills that arrive by email too.
- Attach job sheets to the ServiceM8 job (needs a port for job attachments).
- An index in D1 once a client has more than a few thousand scans.

## About this repo

This repo is synced automatically from another source, so it's read-only: pull requests and pushes aren't accepted here. If you spot a problem, tell us through [plainfunction.com.au/contact](https://plainfunction.com.au/contact).
