// One-off: test bookmarks/add with a URL we know is in the user's
// Instapaper account. We need to know:
//   1. Does it return the existing bookmark_id (idempotent)?
//   2. Does it move the bookmark to a different folder as a side effect?
//   3. Does it touch starred/progress?
//
// Test target: the Ichiro ESPN URL — we already know its bookmark_id
// is 1026945010 (verified via getText). If add returns 1026945010
// AND the bookmark stays out of any folder list (since it was already
// orphaned), we have a viable strategy for CSV-driven enumeration.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { InstapaperClient } from '../src/services/instapaper/client.js';

function loadEnv(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (m) out[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
  }
  return out;
}
const env = loadEnv(resolve(process.cwd(), '.dev.vars'));

const client = new InstapaperClient(
  env.INSTAPAPER_CONSUMER_KEY,
  env.INSTAPAPER_CONSUMER_SECRET,
  env.INSTAPAPER_ACCESS_TOKEN,
  env.INSTAPAPER_ACCESS_TOKEN_SECRET
);

// We don't have a typed `add` method on the client, so call the
// raw OAuth path. The request shape mirrors the rest of the client.
async function rawRequest(
  path: string,
  body: Record<string, string>
): Promise<string> {
  // @ts-expect-error reaching into the private signing path for a one-off.
  return await client.request(path, body);
}

const targetUrl =
  'http://www.espn.com/espn/feature/story/_/id/22624561/ichiro-suzuki-return-seattle-mariners-resolve-internal-battle';

async function main() {
  console.log(`Calling /1/bookmarks/add for: ${targetUrl}`);
  const res = await rawRequest('/1/bookmarks/add', { url: targetUrl });
  console.log('Response:');
  console.log(res.slice(0, 1500));
  const items = JSON.parse(res);
  const bm = items.find((it: { type?: string }) => it.type === 'bookmark');
  if (bm) {
    console.log(`\nbookmark_id returned: ${bm.bookmark_id}`);
    console.log(`title: ${bm.title}`);
    console.log(`progress: ${bm.progress}`);
    console.log(`starred: ${bm.starred}`);
    console.log(
      `expected (Ichiro): 1026945010 → ${bm.bookmark_id === 1026945010 ? 'MATCH' : 'MISMATCH'}`
    );
  }

  // Check if it now appears in unread (the bookmarks/add default folder).
  console.log(`\nChecking unread folder for ${bm.bookmark_id}...`);
  const unread = await client.listBookmarks({ folderId: 'unread', limit: 500 });
  const inUnread = unread.bookmarks.find(
    (b) => b.bookmark_id === bm.bookmark_id
  );
  console.log(`In unread? ${inUnread ? 'YES (side effect)' : 'no'}`);
  console.log(`unread folder size: ${unread.bookmarks.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
