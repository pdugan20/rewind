import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

test('discovery edits preserve deployed renderer deduplication while pixel edits invalidate it', async () => {
  const root = path.resolve(import.meta.dirname, '../..');
  const scratch = await fs.mkdtemp(
    path.join(os.tmpdir(), 'rewind-renderer-contract-')
  );
  try {
    await fs.mkdir(path.join(scratch, 'scripts/cd-artwork'), {
      recursive: true,
    });
    await fs.mkdir(path.join(scratch, 'src/services'), { recursive: true });
    await fs.cp(
      path.join(root, 'src/services/cd-artwork'),
      path.join(scratch, 'src/services/cd-artwork'),
      { recursive: true }
    );
    for (const file of ['build.mjs', 'pixels.mjs'])
      await fs.copyFile(
        path.join(root, 'scripts/cd-artwork', file),
        path.join(scratch, 'scripts/cd-artwork', file)
      );
    const build = async () => {
      execFileSync(process.execPath, ['scripts/cd-artwork/build.mjs'], {
        cwd: scratch,
      });
      return fs.readFile(
        path.join(scratch, 'src/services/cd-artwork/processor-version.ts'),
        'utf8'
      );
    };
    const baseline = await build();
    assert.match(
      baseline,
      /9f312830a7484ada1472df9a52ac5e92e54bf09f9dae31c52df76f8904686e92/
    );
    for (const file of [
      'discovery.ts',
      'selection.ts',
      'sources.ts',
      'audiodb.ts',
      'identity.ts',
      'discovery-policy.ts',
    ])
      await fs.appendFile(
        path.join(scratch, 'src/services/cd-artwork', file),
        '\n// Synthetic discovery change.\n'
      );
    assert.equal(await build(), baseline);
    await fs.appendFile(
      path.join(scratch, 'src/services/cd-artwork/rendering.ts'),
      '\n// Synthetic rendering change.\n'
    );
    assert.notEqual(await build(), baseline);
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
});
