import { env, applyD1Migrations } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/d1';
import { apiKeys } from './db/schema/system.js';

export async function setupTestDb() {
  const migrations = env.TEST_MIGRATIONS;
  if (Array.isArray(migrations) && migrations.length > 0) {
    await applyD1Migrations(env.DB, migrations);
  }
}

export async function setupTestDbWithFts5() {
  await setupTestDb();
  // Apply FTS5 migration manually since readD1Migrations may not pick it up
  try {
    await env.DB.exec(
      "CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(domain, entity_type, entity_id, title, subtitle, image_key, tokenize='unicode61')"
    );
  } catch {
    // Table might already exist
  }
}

export async function createTestApiKey(
  opts: {
    name?: string;
    scope?: 'read' | 'admin';
    token?: string;
  } = {}
) {
  const scope = opts.scope ?? 'admin';
  const name = opts.name ?? `test-${scope}`;
  const token = opts.token ?? `rw_test_${name}_${Date.now()}`;

  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest(
    'SHA-256',
    encoder.encode(token)
  );
  const keyHash = [...new Uint8Array(hashBuffer)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  const keyPrefix = token.slice(0, 10);
  const keyHint = token.slice(-4);

  const db = drizzle(env.DB);
  await db.insert(apiKeys).values({
    userId: 1,
    keyHash,
    keyPrefix,
    keyHint,
    name,
    scope,
    createdAt: new Date().toISOString(),
  });

  return token;
}
