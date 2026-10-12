import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);
const result = await run(
  process.execPath,
  [
    'node_modules/vitest/vitest.mjs',
    'run',
    '-c',
    'vitest.cd-artwork.config.ts',
    'src/services/cd-artwork/artwork.test.ts',
    '-t',
    'advertises and serves only the verified optional WebP',
    '--reporter=verbose',
  ],
  {
    cwd: process.cwd(),
    env: { ...process.env, VITE_CD_ARTWORK_EXPORT_FIXTURE: '1' },
    maxBuffer: 2 * 1024 * 1024,
  }
);
const marker = result.stdout
  .split(/\r?\n/)
  .find((line) => line.includes('DISC_DELIVERY_FIXTURE:'));
if (!marker) throw new Error('Synthetic local Worker fixture was not emitted');
const payload = JSON.parse(
  marker.slice(marker.indexOf('DISC_DELIVERY_FIXTURE:') + 22)
);
const output = '.codex/discman-delivery-integration';
await mkdir(output, { recursive: true });
await Promise.all([
  writeFile(
    `${output}/revision-1.json`,
    `${JSON.stringify(payload.revisionOne, null, 2)}\n`
  ),
  writeFile(
    `${output}/revision-2.json`,
    `${JSON.stringify(payload.revisionTwo, null, 2)}\n`
  ),
  writeFile(
    `${output}/canonical.png`,
    Buffer.from(payload.canonicalPng, 'base64')
  ),
  writeFile(
    `${output}/variant.webp`,
    Buffer.from(payload.variantWebp, 'base64')
  ),
]);
console.log(`Wrote synthetic Worker responses and image bytes to ${output}/`);
