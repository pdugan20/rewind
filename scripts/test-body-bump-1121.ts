/**
 * One-off validation: bump body_excerpt for article 1121 from 3000 -> 10000
 * chars, refresh the FTS row, and emit the offset needed to call
 * /admin/reembed-reading for that single row.
 *
 * Steps (all against the remote D1 via wrangler):
 *   1. SELECT content for id=1121.
 *   2. Run htmlToText(content, { maxChars: 10000 }) locally.
 *   3. UPDATE reading_items.body_excerpt for id=1121.
 *   4. DELETE+INSERT the matching search_index FTS row.
 *   5. Print the offset of id=1121 in `WHERE user_id=1 ORDER BY id`
 *      (needed for /admin/reembed-reading offset+limit:1).
 *
 * Run: npx tsx scripts/test-body-bump-1121.ts
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { htmlToText } from '../src/lib/html-to-text.js';

const ARTICLE_ID = 1121;
const NEW_MAX_CHARS = 10000;

function d1(commandOrFile: { command?: string; file?: string }): unknown {
  const args = ['wrangler', 'd1', 'execute', 'rewind-db', '--remote', '--json'];
  if (commandOrFile.command) args.push('--command', commandOrFile.command);
  if (commandOrFile.file) args.push('--file', commandOrFile.file);
  const out = execFileSync('npx', args, {
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(out);
}

function sqlEscape(s: string): string {
  return s.replace(/'/g, "''");
}

async function main() {
  console.log(`[test-bump] article ${ARTICLE_ID} — fetching content...`);
  const selectRes = d1({
    command: `SELECT id, length(content) as content_len, length(body_excerpt) as old_excerpt_len, content FROM reading_items WHERE id = ${ARTICLE_ID}`,
  }) as Array<{
    results: Array<{
      id: number;
      content: string;
      content_len: number;
      old_excerpt_len: number;
    }>;
  }>;

  const row = selectRes[0]?.results?.[0];
  if (!row) {
    throw new Error(`Article ${ARTICLE_ID} not found`);
  }
  console.log(
    `[test-bump]   content_len=${row.content_len}, old body_excerpt_len=${row.old_excerpt_len}`
  );

  const newExcerpt = htmlToText(row.content, { maxChars: NEW_MAX_CHARS });
  console.log(`[test-bump]   new body_excerpt length: ${newExcerpt.length}`);
  for (const probe of ['batting cage', 'training', 'japan', 'work ethic']) {
    const found = newExcerpt.toLowerCase().includes(probe);
    console.log(`[test-bump]     "${probe}": ${found ? 'YES' : 'no'}`);
  }

  // Write UPDATE + FTS DELETE/INSERT to a single SQL file. search_index is
  // an FTS5 contentless table — DELETE then INSERT to refresh the row.
  // (FTS5 supports UPDATE on contentless tables but DELETE+INSERT is
  // simpler and matches what the reindex code does.)
  const dir = mkdtempSync(join(tmpdir(), 'bump-1121-'));
  const sqlPath = join(dir, 'update.sql');
  const titleRes = d1({
    command: `SELECT title, description FROM reading_items WHERE id = ${ARTICLE_ID}`,
  }) as Array<{
    results: Array<{ title: string | null; description: string | null }>;
  }>;
  const meta = titleRes[0]?.results?.[0];
  if (!meta) throw new Error('failed to fetch title/description');

  const sql = `
UPDATE reading_items
SET body_excerpt = '${sqlEscape(newExcerpt)}',
    updated_at = '${new Date().toISOString()}'
WHERE id = ${ARTICLE_ID};

DELETE FROM search_index
WHERE domain = 'reading' AND entity_type = 'article' AND entity_id = '${ARTICLE_ID}';

INSERT INTO search_index (domain, entity_type, entity_id, title, subtitle, body, image_key)
VALUES (
  'reading',
  'article',
  '${ARTICLE_ID}',
  '${sqlEscape(meta.title ?? '')}',
  '${sqlEscape(meta.description ?? '')}',
  '${sqlEscape(newExcerpt)}',
  NULL
);
`.trim();
  writeFileSync(sqlPath, sql, 'utf-8');
  console.log(`[test-bump] wrote SQL to ${sqlPath} (${sql.length} bytes)`);

  console.log(`[test-bump] applying UPDATE + FTS refresh...`);
  d1({ file: sqlPath });
  console.log(`[test-bump]   done.`);

  // Compute offset for /admin/reembed-reading: route is ORDER BY id with
  // WHERE user_id=1, so offset = count of user_id=1 rows with id < 1121.
  const offsetRes = d1({
    command: `SELECT COUNT(*) as offset FROM reading_items WHERE user_id = 1 AND id < ${ARTICLE_ID}`,
  }) as Array<{ results: Array<{ offset: number }> }>;
  const offset = offsetRes[0]?.results?.[0]?.offset ?? 0;
  console.log(`[test-bump] offset for /admin/reembed-reading: ${offset}`);
  console.log(
    `[test-bump] next: POST /v1/admin/reembed-reading with { "offset": ${offset}, "limit": 1 }`
  );
}

main().catch((err) => {
  console.error('[test-bump] FAILED:', err);
  process.exit(1);
});
