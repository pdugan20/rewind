import {
  cloudflareTest,
  readD1Migrations,
} from '@cloudflare/vitest-pool-workers';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const migrationsPath = path.join(import.meta.dirname, 'migrations');
      let migrations: unknown[] = [];

      try {
        migrations = await readD1Migrations(migrationsPath);
      } catch {
        // No migrations yet
      }

      return {
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          d1Databases: ['DB'],
          bindings: {
            TEST_MIGRATIONS: migrations,
          },
        },
      };
    }),
  ],
  test: {
    testTimeout: 15000,
    exclude: [
      '**/node_modules/**',
      '**/.claude/**',
      'mcp-server/**',
      'scripts/automation-policy.test.mjs',
    ],
  },
});
