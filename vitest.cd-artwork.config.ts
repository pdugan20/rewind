import {
  cloudflareTest,
  readD1Migrations,
} from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';
import fs from 'node:fs/promises';

export default defineConfig(async () => ({
  plugins: [
    {
      name: 'cd-artwork-binary-fixtures',
      enforce: 'pre' as const,
      async load(id: string) {
        if (id.includes('/cd-artwork/assets/') && id.endsWith('.png'))
          return `export default Uint8Array.from(atob(${JSON.stringify((await fs.readFile(id)).toString('base64'))}), c => c.charCodeAt(0)).buffer;`;
      },
    },
    cloudflareTest({
      wrangler: { configPath: './wrangler.cd-artwork.jsonc' },
      miniflare: {
        // Match the pinned local workerd; production retains its configured date.
        compatibilityDate: '2026-07-29',
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(
            `${import.meta.dirname}/migrations`
          ),
        },
      },
    }),
  ],
  test: {
    clearMocks: true,
    include: ['src/services/cd-artwork/*.test.ts'],
    testTimeout: 20000,
  },
}));
