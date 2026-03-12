import {
  defineWorkersConfig,
  readD1Migrations,
} from '@cloudflare/vitest-pool-workers/config';
import path from 'node:path';

export default defineWorkersConfig(async () => {
  const migrationsPath = path.join(__dirname, 'migrations');
  let migrations: unknown[] = [];

  try {
    migrations = await readD1Migrations(migrationsPath);
  } catch {
    // No migrations yet
  }

  return {
    test: {
      testTimeout: 15000,
      exclude: ['**/node_modules/**', '**/.claude/**'],
      poolOptions: {
        workers: {
          wrangler: { configPath: './wrangler.toml' },
          miniflare: {
            d1Databases: ['DB'],
            bindings: {
              TEST_MIGRATIONS: migrations,
            },
          },
        },
      },
    },
  };
});
