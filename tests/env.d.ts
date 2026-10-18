declare namespace Cloudflare {
  interface Env {
    KV: KVNamespace
    DB: D1Database
    SCANS: R2Bucket
  }
}
