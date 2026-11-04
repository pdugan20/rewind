/** Apply or verify the pinned Zod 3 backport; unknown sources always fail closed. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  lstat,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { patchRuntime, sha256 } from './build-zod3-backport.mjs';

export const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const consumers = ['@mintlify/validation', '@mintlify/scraping'];
const source = JSON.parse(
  await readFile(join(repository, 'vendor/zod3-backport.json'), 'utf8')
);

async function zodPackages(modules, found = []) {
  let entries;
  try {
    entries = await readdir(modules, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return found;
    throw error;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const path = join(modules, entry.name);
    if (entry.isSymbolicLink())
      throw new Error(
        `Linked dependency needs explicit backport verification: ${path}`
      );
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('@')) {
      for (const item of await readdir(path, { withFileTypes: true })) {
        assert.ok(
          item.isDirectory() && !item.isSymbolicLink(),
          `Unexpected scoped dependency ${path}/${item.name}`
        );
        await inspect(join(path, item.name));
      }
    } else await inspect(path);
  }
  async function inspect(path) {
    // Match the package identity, not its folder name: npm aliases may place
    // the same vulnerable Zod package in a differently named directory.
    const manifest = JSON.parse(
      await readFile(join(path, 'package.json'), 'utf8')
    );
    if (manifest.name === 'zod' && manifest.version.startsWith('3.'))
      found.push({ path, manifest });
    await zodPackages(join(path, 'node_modules'), found);
  }

  return found;
}

export async function inspectBackport(
  project = repository,
  { allowMissingDev = false } = {}
) {
  project = await realpath(project);
  const packages = await zodPackages(join(project, 'node_modules'));
  const installedConsumers = await Promise.all(
    consumers.map(async (consumer) => {
      try {
        await stat(join(project, 'node_modules', consumer, 'package.json'));
        return true;
      } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
      }
    })
  );
  // A production-only install has no documentation tooling to patch. This is
  // allowed only by the apply entry point during an explicit dev omission;
  // documentation checks remain strict, and partial installs never qualify.
  if (
    allowMissingDev &&
    packages.length === 0 &&
    installedConsumers.every((installed) => !installed)
  )
    return { packages, files: [], omitted: true };
  assert.ok(
    packages.length > 0,
    'Missing Zod 3 development dependencies; run npm ci'
  );
  const roots = new Set(packages.map((pkg) => pkg.path));
  for (const consumer of consumers) {
    const manifest = join(project, 'node_modules', consumer, 'package.json');
    await stat(manifest);
    const require = createRequire(manifest);
    assert.ok(
      roots.has(dirname(require.resolve('zod/package.json'))),
      `Missing ${consumer} Zod 3 instance`
    );
  }
  const files = [];
  for (const pkg of packages) {
    assert.equal(
      pkg.manifest.name,
      source.name,
      `Unexpected Zod package identity at ${pkg.path}`
    );
    assert.equal(
      pkg.manifest.version,
      source.version,
      `Unreviewed Zod 3 version at ${pkg.path}; rebuild the backport before updating`
    );
    for (const [relative, hashes] of Object.entries(source.files)) {
      const path = join(pkg.path, relative);
      const metadata = await lstat(path);
      assert.ok(
        metadata.isFile() && !metadata.isSymbolicLink(),
        `Runtime file is not a regular file: ${path}`
      );
      const text = await readFile(path, 'utf8');
      const hash = sha256(text);
      assert.ok(
        hash === hashes.upstreamSHA256 || hash === hashes.patchedSHA256,
        `Unrecognized Zod source at ${path}; refusing to overwrite`
      );
      files.push({ path, text, hash, hashes, mode: metadata.mode });
    }
  }
  return { packages, files };
}

export async function checkBackport(project = repository) {
  const result = await inspectBackport(project);
  for (const file of result.files)
    assert.equal(
      file.hash,
      file.hashes.patchedSHA256,
      `Zod 3 bounds patch is missing at ${file.path}; run npm run deps:patch`
    );
  return result.packages;
}

export async function applyBackport(project = repository, options = {}) {
  // Validate every copy before touching any. Interrupted runs can resume: each
  // individual file must be exactly the upstream or exact patched contents.
  const result = await inspectBackport(project, options);
  for (const file of result.files) {
    if (file.hash === file.hashes.patchedSHA256) continue;
    const invalid =
      basename(file.path) === 'types.js' ? 'parseUtil_1.INVALID' : 'INVALID';
    const patched = patchRuntime(file.text, invalid);
    assert.equal(
      sha256(patched),
      file.hashes.patchedSHA256,
      `Backport output digest mismatch: ${file.path}`
    );
    const temporary = `${file.path}.rewind-backport-${process.pid}`;
    const handle = await open(temporary, 'wx', file.mode & 0o777);
    try {
      await handle.writeFile(patched);
      await handle.close();
      await rename(temporary, file.path);
    } finally {
      await handle.close().catch(() => {});
      await rm(temporary, { force: true }).catch(() => {});
    }
  }
  if (!result.omitted) await checkBackport(project);
  return result.packages;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const mode = process.argv[2];
  assert.ok(['--apply', '--check'].includes(mode), 'Use --apply or --check');
  const packages = await (mode === '--apply'
    ? applyBackport(repository, {
        allowMissingDev:
          process.env.npm_config_omit?.split(/[\s,]+/).includes('dev') ||
          process.env.NODE_ENV === 'production',
      })
    : checkBackport());
  console.log(
    packages.length === 0
      ? 'Documentation dependencies omitted; no Zod 3 runtime installed.'
      : `Zod 3 constrained-collection backport ${mode === '--apply' ? 'applied' : 'verified'} in ${packages.length} package copies; upstream version/advisory metadata retained.`
  );
}
