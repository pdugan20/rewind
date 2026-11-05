import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  snapshotDatabase,
  assertCatalogRead,
  writePrivate,
  catalogReader,
} from './compare-identity.ts';
import { mkdtemp, writeFile, chmod, stat, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('baseline and candidate replay the same transport failure without another live request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rewind-identity-'));
  let calls = 0;
  const reader = catalogReader(root, 'synthetic', async () => {
    calls++;
    throw new Error('synthetic transport failure');
  });
  try {
    const url =
      'https://api.music.apple.com/v1/catalog/us/albums/123?include=tracks';
    assert.equal((await reader.fetch(url)).status, 503);
    assert.equal((await reader.fetch(url)).status, 503);
    assert.equal(calls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('private evidence writes restrict existing files and reject symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rewind-identity-'));
  try {
    const path = join(root, 'output.json');
    await writeFile(path, 'old');
    await chmod(path, 0o644);
    await writePrivate(path, 'new');
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    const link = join(root, 'link.json');
    await symlink(path, link);
    await assert.rejects(writePrivate(link, 'bad'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('comparison database exposes snapshot tracks and a local throttle reservation only', async () => {
  const db = snapshotDatabase({
    recorded_tracks: ['Synthetic song'],
    legacy_tracks: [],
  });
  assert.deepEqual(
    await db
      .prepare('SELECT t.name FROM lastfm_scrobbles s WHERE s.album_recorded=1')
      .bind(1, 1)
      .all(),
    { results: [{ name: 'Synthetic song' }] }
  );
  assert.throws(
    () => db.prepare('INSERT INTO cd_artwork_jobs VALUES(1)'),
    /denied/
  );
  assert.throws(() => db.prepare('SELECT * FROM api_keys'), /denied/);
  const throttle = db.prepare(
    'UPDATE cd_artwork_control SET provider_next_ms=0'
  );
  assert.deepEqual(await throttle.bind().first(), { provider_next_ms: 0 });
  assert.equal(throttle.run, undefined);
  assert.equal(db.batch, undefined);
});
test('comparison fetch allowlist rejects generation, artwork, writes and redirects to other hosts', () => {
  for (const url of [
    'https://api.music.apple.com/v1/catalog/us/albums/123?include=tracks',
    'https://itunes.apple.com/search?term=synthetic',
    'https://musicbrainz.org/ws/2/release/11111111-1111-4111-8111-111111111111?fmt=json',
  ])
    assert.doesNotThrow(() => assertCatalogRead(url));
  for (const url of [
    'https://api.openai.com/v1/images/edits',
    'https://api.rewind.rest/v1/admin/cd-artwork/jobs',
    'https://is1-ssl.mzstatic.com/source.jpg',
    'https://api.music.apple.com.evil.invalid/v1/catalog/us/albums/123',
    'http://itunes.apple.com/search',
  ])
    assert.throws(() => assertCatalogRead(url), /denied/);
  assert.throws(
    () =>
      assertCatalogRead('https://itunes.apple.com/search', { method: 'POST' }),
    /denied/
  );
  assert.throws(
    () =>
      assertCatalogRead('https://itunes.apple.com/search', { body: 'data' }),
    /denied/
  );
});
