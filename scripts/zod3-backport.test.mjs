import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import { applyBackport, checkBackport, repository } from './patch-zod3.mjs';
import { buildBackport, sha256 } from './build-zod3-backport.mjs';

const provenance = JSON.parse(
  await readFile(join(repository, 'vendor/zod3-backport.json'), 'utf8')
);
const packages = await checkBackport();
const require = createRequire(import.meta.url);

for (const pkg of packages) {
  const cjs = require(join(pkg.path, 'lib/index.js'));
  const esm = await import(pathToFileURL(join(pkg.path, 'lib/index.mjs')).href);
  const module = { exports: {} };
  runInNewContext(await readFile(join(pkg.path, 'lib/index.umd.js'), 'utf8'), {
    module,
    exports: module.exports,
    Set,
    Map,
    Date,
    Promise,
    Array,
    URL,
  });
  const label = pkg.path.slice(join(repository, 'node_modules').length + 1);
  for (const [entry, z] of [
    ['CJS', cjs],
    ['ESM', esm],
    ['UMD', module.exports],
  ]) {
    test(`${label} ${entry}: upper bounds stop child and outer refinements`, async () => {
      for (const asyncMode of [false, true])
        for (const kind of ['max', 'length', 'set-max', 'set-size', 'tuple']) {
          let childCalls = 0,
            outerCalls = 0;
          const child = z.preprocess((value) => {
            childCalls++;
            return value;
          }, z.number());
          const schema =
            kind === 'max'
              ? z.array(child).max(1, 'capped')
              : kind === 'length'
                ? z.array(child).length(1, 'capped')
                : kind === 'set-max'
                  ? z.set(child).max(1, 'capped')
                  : kind === 'set-size'
                    ? z.set(child).size(1, 'capped')
                    : z.tuple([child]);
          const refined = schema.refine(() => {
            outerCalls++;
            return true;
          });
          const input = kind.startsWith('set-')
            ? new Set([1, 2, 3])
            : [1, 2, 3];
          const result = asyncMode
            ? await refined.safeParseAsync(input)
            : refined.safeParse(input);
          assert.equal(result.success, false);
          assert.equal(result.error.issues.length, 1);
          assert.equal(result.error.issues[0].code, 'too_big');
          assert.equal(result.error.issues[0].maximum, 1);
          if (kind !== 'tuple')
            assert.equal(result.error.issues[0].message, 'capped');
          assert.equal(childCalls, 0);
          assert.equal(outerCalls, 0);
        }
    });
    test(`${label} ${entry}: oversized sparse inputs never iterate`, async () => {
      const sparse = new Array(100_000_000);
      sparse[Symbol.iterator] = () => {
        throw new Error('must not iterate oversized array');
      };
      for (const schema of [
        z.array(z.number()).max(1),
        z.array(z.number()).length(1),
        z.tuple([z.number()]),
      ]) {
        assert.equal(schema.safeParse(sparse).success, false);
        assert.equal((await schema.safeParseAsync(sparse)).success, false);
      }
      const set = new Set([1, 2]);
      set.values = () => {
        throw new Error('must not iterate oversized set');
      };
      assert.equal(z.set(z.number()).max(1).safeParse(set).success, false);
      assert.equal(
        (await z.set(z.number()).size(1).safeParseAsync(set)).success,
        false
      );
    });
    test(`${label} ${entry}: valid Zod 3 transforms, records, tuples and AST stay compatible`, async () => {
      const array = z
        .array(z.string().transform((value) => value.toUpperCase()))
        .max(2);
      assert.deepEqual(Array.from(array.parse(['a', 'b'])), ['A', 'B']);
      assert.equal(array._def.type._def.typeName, 'ZodEffects');
      assert.equal(array._def.maxLength.value, 2);
      assert.deepEqual(
        { ...z.record(z.enum(['a', 'b']), z.number()).parse({ a: 1 }) },
        { a: 1 }
      );
      assert.deepEqual(
        Array.from(z.tuple([z.string()]).rest(z.number()).parse(['a', 1, 2])),
        ['a', 1, 2]
      );
      assert.deepEqual(
        Array.from(z.array(z.number()).max(1).catch([7]).parse([1, 2, 3])),
        [7]
      );
      assert.deepEqual(
        Array.from(z.array(z.number()).max(1).default([1]).parse(undefined)),
        [1]
      );
      assert.equal(
        z.union([z.array(z.number()).max(1), z.string()]).parse('fallback'),
        'fallback'
      );
      assert.deepEqual(
        Array.from(
          await z
            .array(z.number().refine(async () => true))
            .max(1)
            .parseAsync([1])
        ),
        [1]
      );
    });
    test(`${label} ${entry}: lower bounds, nested issue paths and unbounded schemas retain their contract`, () => {
      let parsed = 0;
      const child = z.preprocess((value) => {
        parsed++;
        return value;
      }, z.number());
      const short = z.array(child).length(2).safeParse([1]);
      assert.equal(short.success, false);
      assert.equal(short.error.issues[0].code, 'too_small');
      assert.equal(parsed, 1);
      const nested = z
        .object({ items: z.array(z.string()).max(1) })
        .safeParse({ items: [1, 2] });
      assert.deepEqual(Array.from(nested.error.issues[0].path), ['items']);
      assert.equal(
        z.array(z.string()).safeParse([1, 2, 3]).error.issues.length,
        3
      );
      assert.equal(
        z.map(z.string(), z.number()).safeParse(
          new Map([
            ['a', 1],
            ['b', 2],
          ])
        ).success,
        true
      );
    });
  }
}

async function fixture(work) {
  const root = await mkdtemp(join(tmpdir(), 'rewind-zod3-test-'));
  try {
    const packageRoot = join(root, 'node_modules/zod');
    await mkdir(dirname(packageRoot), { recursive: true });
    await cp(packages[0].path, packageRoot, { recursive: true });
    for (const consumer of ['validation', 'scraping']) {
      const path = join(root, 'node_modules/@mintlify', consumer);
      await mkdir(path, { recursive: true });
      await writeFile(
        join(path, 'package.json'),
        JSON.stringify({ name: `@mintlify/${consumer}`, version: '1.0.0' })
      );
    }
    // Recover the exact upstream source in an owned copy using the reviewable diff.
    execFileSync('patch', ['-R', '-p1', '-t'], {
      cwd: packageRoot,
      input: await readFile(join(repository, 'vendor/zod3-bounds.patch')),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    for (const [file, hashes] of Object.entries(provenance.files))
      assert.equal(
        sha256(await readFile(join(packageRoot, file))),
        hashes.upstreamSHA256
      );
    await work(root, packageRoot);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('clean installs are source checked, idempotent and keep original package metadata', async () =>
  fixture(async (root, pkg) => {
    const manifest = await readFile(join(pkg, 'package.json'));
    await assert.rejects(checkBackport(root), /patch is missing/);
    await applyBackport(root);
    await checkBackport(root);
    const before = await lstat(join(pkg, 'lib/types.js'));
    await applyBackport(root);
    assert.equal(
      (await lstat(join(pkg, 'lib/types.js'))).mtimeMs,
      before.mtimeMs
    );
    assert.deepEqual(await readFile(join(pkg, 'package.json')), manifest);
  }));
test('unknown source is rejected before any installed file changes', async () =>
  fixture(async (root, pkg) => {
    const untouched = await readFile(join(pkg, 'lib/index.mjs'));
    await writeFile(join(pkg, 'lib/index.umd.js'), 'unrecognized source');
    await assert.rejects(applyBackport(root), /Unrecognized Zod source/);
    assert.deepEqual(await readFile(join(pkg, 'lib/index.mjs')), untouched);
  }));
test('an interrupted partial application resumes safely', async () =>
  fixture(async (root, pkg) => {
    await cp(join(packages[0].path, 'lib/types.js'), join(pkg, 'lib/types.js'));
    await applyBackport(root);
    await checkBackport(root);
  }));
test('version changes and runtime symlinks fail closed', async () =>
  fixture(async (root, pkg) => {
    const path = join(pkg, 'package.json');
    const text = await readFile(path, 'utf8');
    await writeFile(
      path,
      JSON.stringify({ ...JSON.parse(text), version: '3.25.0' })
    );
    await assert.rejects(applyBackport(root), /Unreviewed Zod 3 version/);
    await writeFile(path, text);
    const runtime = join(pkg, 'lib/types.js'),
      outside = join(root, 'outside.js');
    await writeFile(outside, 'outside original');
    await rm(runtime);
    await symlink(outside, runtime);
    await assert.rejects(applyBackport(root), /not a regular file/);
    assert.equal(await readFile(outside, 'utf8'), 'outside original');
  }));
test('a mismatched upstream archive is rejected before extraction or output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rewind-zod3-archive-'));
  try {
    const input = join(root, 'wrong.tgz'),
      output = join(root, 'output');
    await writeFile(input, 'not upstream');
    await assert.rejects(buildBackport(input, output), /digest mismatch/);
    await assert.rejects(lstat(output), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('npm aliases cannot hide an additional Zod 3 copy', async () =>
  fixture(async (root, pkg) => {
    const alias = join(root, 'node_modules/legacy-validator');
    await cp(pkg, alias, { recursive: true });
    const patched = await applyBackport(root);
    assert.equal(patched.length, 2);
    await checkBackport(root);
    for (const [file, hashes] of Object.entries(provenance.files))
      assert.equal(
        sha256(await readFile(join(alias, file))),
        hashes.patchedSHA256
      );
  }));

test('explicit production omission permits only a complete absence of documentation dependencies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rewind-zod3-production-'));
  try {
    await mkdir(join(root, 'node_modules'));
    await assert.rejects(applyBackport(root), /Missing Zod 3/);
    assert.deepEqual(await applyBackport(root, { allowMissingDev: true }), []);
    await assert.rejects(checkBackport(root), /Missing Zod 3/);
    const consumer = join(root, 'node_modules/@mintlify/validation');
    await mkdir(consumer, { recursive: true });
    await writeFile(
      join(consumer, 'package.json'),
      JSON.stringify({ name: '@mintlify/validation', version: '1.0.0' })
    );
    await assert.rejects(
      applyBackport(root, { allowMissingDev: true }),
      /Missing Zod 3/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('production omission cannot skip an installed Zod 3 copy or a partial consumer install', async () =>
  fixture(async (root, pkg) => {
    const original = await readFile(join(pkg, 'lib/types.js'));
    await rm(join(root, 'node_modules/@mintlify/scraping'), {
      recursive: true,
    });
    await assert.rejects(applyBackport(root, { allowMissingDev: true }), {
      code: 'ENOENT',
    });
    await rm(join(root, 'node_modules/@mintlify/validation'), {
      recursive: true,
    });
    await assert.rejects(applyBackport(root, { allowMissingDev: true }), {
      code: 'ENOENT',
    });
    assert.deepEqual(await readFile(join(pkg, 'lib/types.js')), original);
  }));
