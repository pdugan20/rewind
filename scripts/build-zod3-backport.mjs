/** Build the local Zod 3 security backport from one authenticated upstream archive. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SOURCE_SHA256 =
  '341676f329d264f43a8c2efeb25ccf7f0f880e2fe7a9d9f1c176c71bd9d66e31';
export const UPSTREAM_FIX =
  'https://github.com/colinhacks/zod/commit/a0ebf970f2d752e5f58527cd2942ff48be4f46bd';
export const sha256 = (bytes) =>
  createHash('sha256').update(bytes).digest('hex');

export async function fileHashes(directory, relative = '') {
  const hashes = {};
  for (const entry of (
    await readdir(join(directory, relative), { withFileTypes: true })
  ).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const file = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory())
      Object.assign(hashes, await fileHashes(directory, file));
    else {
      assert.ok(
        entry.isFile(),
        `Unexpected nonregular package member: ${file}`
      );
      hashes[file] = sha256(await readFile(join(directory, file)));
    }
  }
  return hashes;
}

export function patchRuntime(source, invalid) {
  let text = source;
  // Preserve issue shape/messages and Zod 3's public AST. Only oversized upper
  // bounds become aborting failures; undersized and unconstrained inputs retain
  // their original behavior. This also prevents enclosing refinements from
  // walking a value already rejected for its size.
  for (const [start, end, exact] of [
    ['if (def.exactLength !== null)', 'if (def.minLength !== null)', true],
    ['if (def.maxLength !== null)', 'if (ctx.common.async)', false],
    [
      'if (!rest && ctx.data.length > this._def.items.length)',
      'const items =',
      false,
    ],
    ['if (def.maxSize !== null)', 'const valueType =', false],
  ]) {
    assert.equal(
      text.split(start).length,
      2,
      `Patch anchor must occur once: ${start}`
    );
    const first = text.indexOf(start),
      last = text.indexOf(end, first);
    assert.ok(last > first, `Missing patch end: ${end}`);
    const block = text.slice(first, last);
    assert.equal(
      block.split('status.dirty();').length,
      2,
      `Unexpected bound body: ${start}`
    );
    const indent = block.match(/\n([ \t]*)status\.dirty/)[1];
    const replacement = exact
      ? `if (tooBig) return ${invalid};\n${indent}status.dirty();`
      : `return ${invalid};`;
    text =
      text.slice(0, first) +
      block.replace('status.dirty();', replacement) +
      text.slice(last);
  }
  return text;
}

export async function buildBackport(archive, destination) {
  const original = await readFile(archive);
  assert.equal(
    sha256(original),
    SOURCE_SHA256,
    'Upstream archive digest mismatch; refusing to patch'
  );
  const temporary = await mkdtemp(join(tmpdir(), 'rewind-zod3-'));
  try {
    // The digest above authenticates this exact, known upstream package before
    // extraction. Never extract a user-selected archive without that check.
    execFileSync('tar', ['-xzf', resolve(archive), '-C', temporary]);
    const root = join(temporary, 'package');
    const before = await fileHashes(root);
    const manifest = JSON.parse(
      await readFile(join(root, 'package.json'), 'utf8')
    );
    assert.equal(manifest.name, 'zod');
    assert.equal(manifest.version, '3.24.0');
    let patch = '';
    for (const [file, invalid] of [
      ['lib/types.js', 'parseUtil_1.INVALID'],
      ['lib/index.mjs', 'INVALID'],
      ['lib/index.umd.js', 'INVALID'],
    ]) {
      const path = join(root, file),
        source = await readFile(path, 'utf8');
      const baseline = join(temporary, file.replaceAll('/', '-'));
      await writeFile(baseline, source);
      await writeFile(path, patchRuntime(source, invalid));
      const diff = spawnSync(
        'diff',
        ['-u', '-L', `a/${file}`, '-L', `b/${file}`, baseline, path],
        { encoding: 'utf8' }
      );
      assert.equal(
        diff.status,
        1,
        'Every runtime entry must receive its expected patch'
      );
      patch += diff.stdout;
    }
    const after = await fileHashes(root);
    const changed = ['lib/index.mjs', 'lib/index.umd.js', 'lib/types.js'];
    assert.deepEqual(
      Object.keys(after),
      Object.keys(before),
      'Do not drop upstream files or licenses'
    );
    assert.deepEqual(
      Object.keys(before)
        .filter((file) => before[file] !== after[file])
        .sort(),
      changed
    );
    const provenance = {
      name: 'zod',
      version: '3.24.0',
      upstreamTarball: 'https://registry.npmjs.org/zod/-/zod-3.24.0.tgz',
      upstreamSHA256: SOURCE_SHA256,
      upstreamFix: UPSTREAM_FIX,
      advisory: 'https://github.com/advisories/GHSA-mrhx-c7xc-m3w5',
      files: Object.fromEntries(
        changed.map((file) => [
          file,
          { upstreamSHA256: before[file], patchedSHA256: after[file] },
        ])
      ),
    };
    await mkdir(destination, { recursive: true });
    await writeFile(join(destination, 'zod3-bounds.patch'), patch);
    await writeFile(
      join(destination, 'zod3-backport.json'),
      JSON.stringify(provenance, null, 2) + '\n'
    );
    return provenance;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const source = process.argv[2];
  assert.ok(source, 'Supply the verified upstream zod-3.24.0.tgz');
  const repository = dirname(dirname(fileURLToPath(import.meta.url)));
  const result = await buildBackport(source, join(repository, 'vendor'));
  console.log(
    `Built ${result.name}@${result.version} source-checked bounds patch`
  );
}
