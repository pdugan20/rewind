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
          serviceBindings: {
            CD_ARTWORK: {
              name: 'artwork-test-service',
              entrypoint: 'ArtworkDiscoveryService',
            },
          },
          workers: [
            {
              name: 'artwork-test-service',
              modules: true,
              compatibilityDate: '2026-03-12',
              script: `import { WorkerEntrypoint } from 'cloudflare:workers';
              export class ArtworkDiscoveryService extends WorkerEntrypoint {
                async dispatchPending() {}
              }
              export default { fetch() { return new Response(null, { status: 404 }); } };`,
            },
          ],
          bindings: {
            TEST_MIGRATIONS: migrations,
          },
        },
      }),
    ],
    test: {
      include: ['src/**/*.test.ts'],
      clearMocks: true,
      testTimeout: 15000,
      exclude: [
        '**/node_modules/**',
        '**/.claude/**',
        'mcp-server/**',
        'src/services/cd-artwork/*.test.ts',
        'scripts/automation-policy.test.mjs',
        'scripts/deploy-checkpoint.test.mjs',
        'scripts/deploy-impact.test.mjs',
        'scripts/deploy-range.test.mjs',
      ],
    },
  };
});
