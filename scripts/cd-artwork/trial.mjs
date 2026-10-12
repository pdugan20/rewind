import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { registry } from './registry.mjs';
const [manifestPath, storePath, exportPath] = process.argv.slice(2);
if (!exportPath)
  throw Error(
    'Usage: trial.mjs <manifest.json> <local-store> <review-export-directory>'
  );
const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
const dir = path.dirname(path.resolve(manifestPath));
const template = await fs.readFile(path.resolve(dir, manifest.template));
const store = await registry(storePath);
const results = [];
await fs.mkdir(exportPath, { recursive: true });
try {
  for (const item of manifest.inputs) {
    const input = { ...item };
    for (const key of ['sourcePath', 'masterPath', 'patchPath'])
      if (input[key]) input[key] = path.resolve(dir, input[key]);
    const first = await store.ingest(input, template);
    const second = await store.ingest(input, template);
    assert.equal(second.cacheHit, true);
    assert.equal(first.id, second.id);
    if (first.object_hash)
      await fs.copyFile(
        store.objectPath(first.object_hash),
        path.join(exportPath, item.id + '.png')
      );
    results.push({
      id: item.id,
      artist: item.artist,
      title: item.title,
      origin: item.origin,
      state: first.state,
      reusedOnRepeat: true,
      objectHash: first.object_hash,
      provenance: JSON.parse(first.provenance),
      requiresManualMaterialInput:
        !!item.patchPath || item.origin === 'retail_cd_face',
    });
  }
  const snap = store.snapshot();
  assert.ok(snap.albums.every((a) => !a.active));
  const report = {
    inputs: results.length,
    candidates: results.filter((r) => r.state === 'pending').length,
    gated: results.filter((r) => r.state !== 'pending').length,
    repeatedCacheHits: results.length,
    coverMaterialCandidatesUsingExistingCompositions: results.filter(
      (r) => r.origin === 'album_cover' && r.state === 'pending'
    ).length,
    retailCandidatesUsingPriorManualBoundaries: results.filter(
      (r) => r.origin === 'retail_cd_face' && r.state === 'pending'
    ).length,
    automaticallyInferredRetailMaterialBoundaries: 0,
    activeAssets: 0,
    note: 'Geometry/material candidates only. No auto visual acceptance; no model calls in this trial. Explicit unresolved retail gates are retained.',
    results,
  };
  await fs.writeFile(
    path.join(exportPath, 'trial-report.json'),
    JSON.stringify(report, null, 2) + '\n'
  );
  console.log(
    JSON.stringify(
      { ...report, results: results.map(({ id, state }) => ({ id, state })) },
      null,
      2
    )
  );
} finally {
  store.close();
}
