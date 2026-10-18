import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

// Tests run inside workerd, like the capabilities they build on, so R2, KV and
// Web Crypto behave as they do in production.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.test.toml' },
    }),
  ],
  test: {
    include: ['tests/**/*.test.ts'],
  },
})
