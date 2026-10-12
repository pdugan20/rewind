import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { registry, hash } from './registry.mjs';
import { png, checkGeometry, applyTemplateHub, repairHub } from './pixels.mjs';
import { discover } from './discovery.mjs';
function disc(hub = false) {
  const data = new Uint8Array(1024 * 1024 * 4);
  for (let y = 0; y < 1024; y++)
    for (let x = 0; x < 1024; x++) {
      const r = Math.hypot(x + 0.5 - 512, y + 0.5 - 512),
        i = (y * 1024 + x) * 4;
      if (r >= 60 && r <= 480)
        data.set([190, 180, 160, hub && r > 64 && r < 86 ? 120 : 255], i);
    }
  return { width: 1024, height: 1024, data };
}
test('fixed material template preserves all protected artwork and the physical hole', () => {
  const master = disc(),
    template = disc(true),
    result = applyTemplateHub(master, template);
  assert.equal(result.verification.protectedChanges, 0);
  assert.ok(result.verification.partialHubPixels > 1000);
  assert.equal(checkGeometry(result.image).pass, true);
  const damaged = disc();
  damaged.data[(512 * 1024 + 512) * 4 + 3] = 255;
  assert.equal(checkGeometry(damaged).pass, false);
  const oversizedHole = disc();
  for (let y = 450; y < 574; y++)
    for (let x = 450; x < 574; x++)
      oversizedHole.data[(y * 1024 + x) * 4 + 3] = 0;
  assert.equal(checkGeometry(oversizedHole).pass, false);
});
test('retail boundary is required and a patch cannot alter the surrounding art', () => {
  assert.throws(
    () => repairHub(disc(), disc(true), { inner: 62, outer: 490 }),
    /Invalid/
  );
  assert.throws(
    () => repairHub(disc(), disc(), { inner: 62, outer: 88 }),
    /translucency/
  );
  assert.equal(
    repairHub(disc(), disc(true), { inner: 62, outer: 88 }).verification
      .protectedChanges,
    0
  );
});
test('persistent cache, source identity, review history, pins and discovery keep the active asset safe', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rewind-cd-test-'));
  let s = await registry(path.join(dir, 'store'));
  try {
    const sourcePath = path.join(dir, 'source.png'),
      masterPath = path.join(dir, 'master.png'),
      patchPath = path.join(dir, 'patch.png');
    await fs.writeFile(sourcePath, png(disc()));
    await fs.writeFile(masterPath, png(disc()));
    await fs.writeFile(patchPath, png(disc(true)));
    const template = png(disc(true));
    const base = {
      id: 'test-album',
      artist: 'Test',
      title: 'Test',
      origin: 'album_cover',
      sourcePath,
      masterPath,
      processing: {
        model: 'test-fixture',
        sourceHash: hash(png(disc())),
        masterHash: hash(png(disc())),
      },
    };
    await assert.rejects(
      s.ingest({ ...base, processing: { model: 'test-fixture' } }, template),
      /recorded source and master hashes/
    );
    const a = await s.ingest(base, template);
    assert.equal(a.state, 'pending');
    assert.equal((await s.ingest(base, template)).cacheHit, true);
    assert.equal(s.snapshot().albums[0].active, null);
    s.review(a.id, 'accepted', 'automated-test-only', { activate: true });
    const b = await s.ingest(
      {
        ...base,
        origin: 'retail_cd_face',
        patchPath,
        region: { inner: 62, outer: 88 },
        materialEvidence: 'test fixture',
      },
      template
    );
    assert.notEqual(a.id, b.id);
    assert.equal(s.snapshot().albums[0].active, a.id);
    s.db.prepare('UPDATE albums SET pinned=1 WHERE id=?').run(base.id);
    assert.throws(
      () => s.review(b.id, 'accepted', 'test', { activate: true }),
      /unpinned/
    );
    s.db.prepare('UPDATE albums SET pinned=0 WHERE id=?').run(base.id);
    s.review(b.id, 'accepted', 'automated-test-only', { activate: true });
    assert.equal(s.snapshot().events.length, 2);
    assert.equal(
      s.snapshot().assets.find((x) => x.id === a.id).state,
      'accepted'
    );
    assert.throws(() => s.review(b.id, 'rejected', 'test'), /replacement/);
    const d = s.recordDiscovery(
      base.id,
      { outcome: 'found', images: [{ id: 'new' }] },
      new Date('2026-10-11T00:00:00Z')
    );
    assert.equal(s.snapshot().albums[0].active, b.id);
    assert.match(d.nextCheck, /2026-11/);
    const retry = s.recordDiscovery(
      base.id,
      { outcome: 'error', retryAfterSeconds: 7200 },
      new Date('2026-10-11T00:00:00Z')
    );
    assert.equal(retry.nextCheck, '2026-10-11T02:00:00.000Z');
    assert.equal(s.due(new Date('2026-10-11T01:00:00Z')).length, 0);
    await assert.rejects(
      s.ingest({ ...base, processing: { sourceHash: 'wrong' } }, template),
      /source hash/
    );
    s.close();
    s = await registry(path.join(dir, 'store'));
    assert.equal(s.snapshot().albums[0].active, b.id);
    assert.equal((await s.ingest(base, template)).cacheHit, true);
    await fs.writeFile(s.objectPath(a.object_hash), 'corrupt');
    await assert.rejects(s.ingest(base, template), /integrity/);
  } finally {
    s.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
test('uncertain retail, unregistered scans and low-resolution sources are gated', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rewind-cd-gates-'));
  const s = await registry(path.join(dir, 'store'));
  try {
    const file = path.join(dir, 'source.png');
    await fs.writeFile(file, png(disc()));
    const input = { id: 'gates', sourcePath: file, origin: 'retail_cd_face' };
    assert.equal(
      (await s.ingest(input, png(disc(true)))).state,
      'needs_material_review'
    );
    const small = {
      width: 20,
      height: 20,
      data: new Uint8Array(1600).fill(255),
    };
    await fs.writeFile(file, png(small));
    assert.equal(
      (await s.ingest(input, png(disc(true)))).state,
      'needs_registration'
    );
    assert.equal(
      (await s.ingest({ ...input, origin: 'album_cover' }, png(disc(true))))
        .state,
      'needs_better_source'
    );
    await fs.writeFile(file, png(disc()));
    assert.equal(
      (await s.ingest({ ...input, origin: 'album_cover' }, png(disc(true))))
        .state,
      'needs_composition'
    );
  } finally {
    s.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
test('discovery distinguishes missing art, transient errors and ambiguous media', async () => {
  const identity = {
    releaseId: '51d34c4e-312e-4462-b754-9c0dc482002a',
    mediumPosition: 1,
  };
  const fake =
    (media, body, status = 200) =>
    async (url) =>
      url.includes('musicbrainz.org')
        ? new Response(JSON.stringify({ media }), { status: 200 })
        : new Response(JSON.stringify(body), { status });
  assert.equal((await discover(null)).outcome, 'identity_required');
  assert.equal(
    (
      await discover(identity, {
        fetcher: fake([{ format: 'HDCD', position: 1 }], {
          images: [{ id: 7, types: ['Medium'] }],
        }),
      })
    ).outcome,
    'found'
  );
  assert.equal(
    (
      await discover(identity, {
        fetcher: fake([{ format: 'CD', position: 1 }], { images: [] }),
      })
    ).outcome,
    'not_found'
  );
  assert.equal(
    (
      await discover(identity, {
        fetcher: fake([{ format: 'CD', position: 1 }], {}, 503),
      })
    ).outcome,
    'error'
  );
  assert.equal(
    (
      await discover(identity, {
        fetcher: fake([{ format: 'Vinyl', position: 1 }], { images: [] }),
      })
    ).outcome,
    'invalid_release'
  );
  assert.equal(
    (
      await discover(identity, {
        fetcher: fake(
          [
            { format: 'CD', position: 1 },
            { format: 'CD', position: 2 },
          ],
          { images: [{ id: 1, types: ['Medium'] }] }
        ),
      })
    ).outcome,
    'ambiguous'
  );
  assert.equal(
    (
      await discover(identity, {
        fetcher: fake([{ format: 'CD', position: 1 }], {
          images: [
            { id: 1, types: ['Front'] },
            { id: 2, types: ['Medium'] },
          ],
        }),
      })
    ).outcome,
    'found'
  );
});
