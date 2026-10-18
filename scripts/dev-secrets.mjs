// Writes what `wrangler dev` needs into .dev.vars.
//
//   npm run dev:secrets
//
// Generates KEYRING and SIGNING_KEY, and turns on the dev stand-ins
// (ENVIRONMENT=development, PUBLIC_URL on localhost). Never replaces a value
// that's already there: a new KEYRING would lose everything sealed with the
// old one. Prints names, never values.
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const file = fileURLToPath(new URL('../.dev.vars', import.meta.url))
const text = existsSync(file) ? readFileSync(file, 'utf8') : ''
const have = new Set(text.split(/\r?\n/).map(line => line.match(/^\s*([A-Z0-9_]+)\s*=\s*\S/)?.[1]).filter(Boolean))

const wanted = {
  // Same shape as core's AesGcmCipher expects. To rotate, add k2 and point current at it.
  KEYRING: () => JSON.stringify({ current: 'k1', keys: { k1: randomBytes(32).toString('base64') } }),
  // Signs approval links.
  SIGNING_KEY: () => randomBytes(32).toString('base64url'),
  // Sign-in as the owner on localhost, notices and bills to the terminal. See src/dev.ts.
  ENVIRONMENT: () => 'development',
  PUBLIC_URL: () => 'http://localhost:8788',
}
const lines = Object.entries(wanted).filter(([name]) => !have.has(name)).map(([name, make]) => `${name}=${make()}`)

// Drop empty placeholders for anything we're about to write, so .dev.vars doesn't end up with both.
const writing = new Set(lines.map(l => l.split('=')[0]))
const kept = text.split(/\r?\n/).filter(line => !writing.has(line.match(/^\s*([A-Z0-9_]+)\s*=\s*$/)?.[1])).join('\n')

if (!lines.length) {
  console.log('✓ .dev.vars already has everything. Nothing changed.')
} else {
  const sep = kept && !kept.endsWith('\n') ? '\n' : ''
  writeFileSync(file, kept + sep + lines.join('\n') + '\n')
  console.log(`✓ Added to .dev.vars: ${[...writing].join(', ')}`)
}
