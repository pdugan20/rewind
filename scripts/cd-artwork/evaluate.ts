/** Offline geometry calibration. Never calls a provider, DB, or publication API.
 * Run: npx tsx scripts/cd-artwork/evaluate.ts <private-manifest.json> <output-dir>
 * Keep real artwork/manifests/results outside version control.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import { readPixels, png, checkGeometry } from './pixels.mjs';
import { inspectRegistration } from '../../src/services/cd-artwork/geometry-inspection.js';

const manifestSchema = z
  .array(
    z.object({
      id: z.string().min(1).max(100),
      group: z.string().min(1).max(100),
      path: z.string().min(1),
      stage: z.enum(['raw', 'final', 'source']),
      sourceKind: z.enum(['retail', 'cover']).optional(),
      geometryBasis: z
        .enum(['photograph', 'constructed'])
        .default('photograph'),
      split: z.enum(['tuning', 'held-out']),
      expectedGeometry: z.enum(['accept', 'reject', 'unrated']),
      rationale: z.string().min(1),
    })
  )
  .min(1)
  .max(100);
const [manifestPath, outputDir] = process.argv.slice(2);
if (!manifestPath || !outputDir)
  throw Error('Usage: evaluate.ts <manifest.json> <output-dir>');
const manifest = manifestSchema.parse(
  JSON.parse(await fs.readFile(manifestPath, 'utf8'))
);
if (new Set(manifest.map((x) => x.id)).size !== manifest.length)
  throw Error('Duplicate evaluation IDs');
const groupSplits = new Map<string, string>();
for (const entry of manifest) {
  if (
    groupSplits.has(entry.group) &&
    groupSplits.get(entry.group) !== entry.split
  )
    throw Error(
      'An artwork group cannot appear in both tuning and held-out sets'
    );
  groupSplits.set(entry.group, entry.split);
}
const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ]!
  );
const reports = [],
  cards = [];
for (const entry of manifest) {
  const imagePath = path.resolve(path.dirname(manifestPath), entry.path);
  if ((await fs.stat(imagePath)).size > 12 * 1024 * 1024)
    throw Error('image_bytes_limit');
  const bytes = await fs.readFile(imagePath);
  const p = readPixels(bytes);
  // White compositing is only a measurement view for the opaque detector. It
  // does not change the original, its preview, or authorize a repaired asset.
  const white = { ...p, data: new Uint8Array(p.data) };
  let partialAlpha = 0,
    transparent = 0;
  for (let i = 0; i < p.data.length; i += 4) {
    const alpha = p.data[i + 3] / 255;
    if (!alpha) transparent++;
    else if (alpha < 1) partialAlpha++;
    for (let c = 0; c < 3; c++)
      white.data[i + c] = Math.round(p.data[i + c] * alpha + 255 * (1 - alpha));
    white.data[i + 3] = 255;
  }
  let geometry;
  try {
    geometry = { measurable: true, ...inspectRegistration(png(white)) };
  } catch (e) {
    geometry = {
      measurable: false,
      pass: false,
      failures: [e instanceof Error ? e.message : 'measurement_unavailable'],
    };
  }
  const report = {
    id: entry.id,
    group: entry.group,
    stage: entry.stage,
    split: entry.split,
    expectedGeometry: entry.expectedGeometry,
    rationale: entry.rationale,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    dimensions: [p.width, p.height],
    geometry,
    retailGeometryReady:
      entry.sourceKind === 'retail'
        ? geometry.measurable && geometry.pass && geometry.printedHub.detected
        : null,
    alpha: {
      transparent,
      partialAlpha,
      finalContract: entry.stage === 'final' ? checkGeometry(p) : null,
    },
  };
  reports.push(report);
  const type = bytes[0] === 255 ? 'image/jpeg' : 'image/png';
  const status =
    entry.stage === 'source'
      ? 'Source reference, not a CD candidate'
      : entry.geometryBasis === 'constructed'
        ? `Prototype · constructed alpha ${checkGeometry(p).pass ? 'valid' : 'invalid'} · cropping not approved`
        : `${entry.stage} · ${entry.split} · numeric checks ${geometry.pass ? 'pass; visual check required' : 'hold'}${report.retailGeometryReady === false ? ' · retail geometry gate holds' : ''}`;
  cards.push(
    `<article><h2>${escape(entry.id)}</h2><p>${escape(status)}</p><div class="frame"><img alt="${escape(entry.id)} unchanged original" src="data:${type};base64,${bytes.toString('base64')}"><div class="axes"></div></div><details><summary>Measurements and label</summary><pre>${escape(JSON.stringify(report, null, 2))}</pre></details></article>`
  );
}
const counts = (split: string) => {
  const rows = reports.filter(
    (r) => r.split === split && r.expectedGeometry !== 'unrated'
  );
  return {
    labelled: rows.length,
    falseAccepts: rows.filter(
      (r) => r.expectedGeometry === 'reject' && r.geometry.pass
    ).length,
    falseRejects: rows.filter(
      (r) => r.expectedGeometry === 'accept' && !r.geometry.pass
    ).length,
  };
};
const result = {
  publicationAuthorized: false,
  limitation:
    'Numeric false accepts/rejects below describe this detector alone, not the full publication pipeline. Geometry measurements alone do not establish identity, lettering fidelity or visual acceptance. Unrated examples do not calibrate thresholds.',
  tuning: counts('tuning'),
  heldOut: counts('held-out'),
  reports,
};
await fs.mkdir(outputDir, { recursive: true });
await fs.writeFile(
  path.join(outputDir, 'results.json'),
  JSON.stringify(result, null, 2) + '\n',
  { mode: 0o600 }
);
await fs.writeFile(
  path.join(outputDir, 'index.html'),
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>CD geometry calibration</title><style>body{font:15px system-ui;background:#eee;color:#222;margin:24px}header{position:sticky;top:0;background:#eeef;padding:16px;z-index:2}h1{font-size:22px;margin:0 0 8px}h2{font-size:16px}main{display:flex;gap:24px;flex-wrap:wrap}article{width:320px}p{font-size:13px}.frame{position:relative;width:var(--size,240px);height:var(--size,240px);margin:24px auto;background:var(--back,#fff)}img{width:100%;height:100%;object-fit:contain;transform:rotate(var(--angle,0deg))}body.spin img{animation:turn 12s linear infinite}.axes{display:none;position:absolute;inset:0;background:linear-gradient(90deg,transparent calc(50% - .5px),#e24 50%,transparent calc(50% + .5px)),linear-gradient(transparent calc(50% - .5px),#e24 50%,transparent calc(50% + .5px));pointer-events:none}body.guides .axes{display:block}pre{font-size:11px;white-space:pre-wrap;overflow-wrap:anywhere}label,button,select{margin:0 12px 8px 0}button,select{padding:8px}small{display:block;margin:8px 0}@keyframes turn{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){body.spin img{animation:none}}</style><header><h1>CD geometry calibration</h1><small>Original images, unchanged. Diagnostic surface only; nothing here publishes artwork.</small><button id="spin">Rotate</button><button id="guides">Center guides</button><label>Canvas width <select id="size"><option>160</option><option selected>240</option><option>320</option></select></label><label>Backdrop <select id="back"><option value="#fff">White</option><option value="#181818">Dark</option><option value="#8b8b8b">Gray</option></select></label><label>Angle <input id="angle" type="range" min="0" max="360" value="0"></label></header><main>${cards.join('')}</main><script>const by=id=>document.getElementById(id);by('spin').onclick=()=>{document.body.classList.toggle('spin');by('spin').textContent=document.body.classList.contains('spin')?'Stop':'Rotate'};by('guides').onclick=()=>document.body.classList.toggle('guides');by('size').onchange=e=>document.body.style.setProperty('--size',e.target.value+'px');by('back').onchange=e=>document.body.style.setProperty('--back',e.target.value);by('angle').oninput=e=>{document.body.classList.remove('spin');by('spin').textContent='Rotate';document.body.style.setProperty('--angle',e.target.value+'deg')}</script>`,
  { mode: 0o600 }
);
console.log(
  JSON.stringify(
    {
      samples: reports.length,
      tuning: result.tuning,
      heldOut: result.heldOut,
      outputDir,
    },
    null,
    2
  )
);
