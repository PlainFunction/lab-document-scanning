import type { Clock } from '../kernel/clock'
import { SystemClock } from '../kernel/clock'
import { sha256Hex } from '../kernel/encoding'
import { Cache } from './cache'

/** Per-isolate LRU. Fastest, but each isolate has its own and they come and go. */
export class MemoryCache extends Cache {
  readonly #entries = new Map<string, { value: unknown; expires: number }>()
  readonly #max: number
  readonly #clock: Clock

  constructor(opts: { maxEntries?: number; clock?: Clock } = {}) {
    super()
    this.#max = opts.maxEntries ?? 500
    this.#clock = opts.clock ?? new SystemClock()
  }

  async get<T>(key: string) {
    const e = this.#entries.get(key)
    if (!e) return undefined
    if (e.expires <= this.#clock.now().getTime()) {
      this.#entries.delete(key)
      return undefined
    }
    // Re-insert to mark as recently used.
    this.#entries.delete(key)
    this.#entries.set(key, e)
    return structuredClone(e.value) as T
  }

  async set<T>(key: string, value: T, ttlSeconds: number) {
    this.#entries.delete(key)
    this.#entries.set(key, { value: structuredClone(value), expires: this.#clock.now().getTime() + ttlSeconds * 1000 })
    while (this.#entries.size > this.#max) this.#entries.delete(this.#entries.keys().next().value!)
  }

  async delete(key: string) { this.#entries.delete(key) }

  describe() {
    return { name: 'Memory cache', use: 'Short-lived lookups within one Worker isolate', personalInfo: [], storesIn: 'Worker memory, this isolate only' }
  }
}

/**
 * Cloudflare's Cache API. Free, per data centre, and nothing else can read it.
 * Keys become URLs on a hostname we never serve, hashed so nothing in the key
 * leaks. Note: the Cache API is a no-op on workers.dev, so this needs a custom domain.
 */
export class EdgeCache extends Cache {
  readonly #name: string
  #cache?: Promise<globalThis.Cache>

  constructor(name = 'capabilities') {
    super()
    this.#name = name
  }

  #open() {
    this.#cache ??= caches.open(this.#name)
    return this.#cache
  }
  #url = async (key: string) => `https://cache.invalid/${this.#name}/${await sha256Hex(key)}`

  async get<T>(key: string) {
    const res = await (await this.#open()).match(await this.#url(key))
    return res ? ((await res.json()) as T) : undefined
  }

  async set<T>(key: string, value: T, ttlSeconds: number) {
    await (await this.#open()).put(await this.#url(key), new Response(JSON.stringify(value), {
      headers: { 'content-type': 'application/json', 'cache-control': `max-age=${Math.max(1, Math.floor(ttlSeconds))}` },
    }))
  }

  async delete(key: string) { await (await this.#open()).delete(await this.#url(key)) }

  describe() {
    return { name: 'Edge cache', use: 'Caching lookups in the nearest Cloudflare data centre', personalInfo: [], storesIn: 'Cloudflare Cache API, per data centre' }
  }
}

/**
 * Workers KV. Global and survives deploys, but writes take up to a minute to
 * show everywhere and the shortest TTL is 60 seconds. Good for OAuth access
 * tokens and reference data. Not for anything that needs to be exactly-once.
 */
export class KvCache extends Cache {
  readonly #kv: KVNamespace
  constructor(kv: KVNamespace) {
    super()
    this.#kv = kv
  }
  async get<T>(key: string) { return (await this.#kv.get<T>(key, 'json')) ?? undefined }
  async set<T>(key: string, value: T, ttlSeconds: number) {
    await this.#kv.put(key, JSON.stringify(value), { expirationTtl: Math.max(60, Math.ceil(ttlSeconds)) })
  }
  async delete(key: string) { await this.#kv.delete(key) }
  describe() {
    return { name: 'Workers KV', use: 'Caching tokens and reference data across data centres', personalInfo: [], storesIn: 'Cloudflare Workers KV' }
  }
}

/**
 * Checks each layer in turn and copies a hit back into the faster layers above
 * it, for whatever is left of its TTL. Each layer holds `{ v, e }` (value, expiry).
 */
export class TieredCache extends Cache {
  readonly #layers: Cache[]
  readonly #clock: Clock

  constructor(layers: Cache[], clock: Clock = new SystemClock()) {
    super()
    if (layers.length === 0) throw new Error('TieredCache needs at least one layer')
    this.#layers = layers
    this.#clock = clock
  }

  async get<T>(key: string) {
    const now = this.#clock.now().getTime()
    for (let i = 0; i < this.#layers.length; i++) {
      const hit = await this.#layers[i].get<{ v: T; e: number }>(key)
      if (!hit || hit.e <= now) continue
      const remaining = (hit.e - now) / 1000
      await Promise.all(this.#layers.slice(0, i).map(l => l.set(key, hit, remaining)))
      return hit.v
    }
    return undefined
  }

  async set<T>(key: string, value: T, ttlSeconds: number) {
    const entry = { v: value, e: this.#clock.now().getTime() + ttlSeconds * 1000 }
    await Promise.all(this.#layers.map(l => l.set(key, entry, ttlSeconds)))
  }

  async delete(key: string) { await Promise.all(this.#layers.map(l => l.delete(key))) }

  describe() {
    const parts = this.#layers.map(l => l.describe())
    return { name: `Tiered (${parts.map(p => p.name).join(' → ')})`, use: 'Caching, fastest layer first', personalInfo: [], storesIn: parts.map(p => p.storesIn).join('; ') }
  }
}
