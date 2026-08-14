import {
  cloudflareTest,
  readD1Migrations,
} from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => {
  const migrationsPath = `${import.meta.dirname}/migrations`;
  let migrations: unknown[] = [];

  try {
    migrations = await readD1Migrations(migrationsPath);
  } catch {
    // No migrations yet
  }

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          d1Databases: ['DB'],
          bindings: {
            TEST_MIGRATIONS: migrations,
          },
        },
      }),
    ],
    test: {
      clearMocks: true,
      testTimeout: 15000,
      exclude: [
        '**/node_modules/**',
        '**/.claude/**',
        'mcp-server/**',
        'scripts/automation-policy.test.mjs',
        'scripts/deploy-checkpoint.test.mjs',
        'scripts/deploy-impact.test.mjs',
        'scripts/deploy-range.test.mjs',
      ],
    },
  };
});
