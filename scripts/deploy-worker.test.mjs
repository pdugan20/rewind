import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  activeDeployment,
  checkSource,
  deployedSource,
} from './deploy-worker.mjs';

const commit = 'a'.repeat(40);
const deployment = (
  id,
  created,
  versions = [{ version_id: id, percentage: 100 }]
) => ({ id, created_on: created, versions });

test('uses newest deployment regardless of provider ordering', () => {
  const old = deployment('old', '2026-10-12T00:00:00Z');
  const current = deployment('current', '2026-10-13T00:00:00Z');
  for (const list of [
    [old, current],
    [current, old],
  ])
    assert.equal(activeDeployment(list), 'current');
});

test('rejects missing, malformed or split production deployments', () => {
  for (const list of [
    [],
    [{}],
    [
      deployment('split', '2026-10-13', [
        { version_id: 'one', percentage: 50 },
        { version_id: 'two', percentage: 50 },
      ]),
    ],
    [
      deployment('partial', '2026-10-13', [
        { version_id: 'one', percentage: 90 },
      ]),
    ],
  ])
    assert.throws(() => activeDeployment(list));
});

test('accepts Git tags and only the exact audited legacy version for its surface', () => {
  const baseline = { root: { version: 'known', commit } };
  assert.equal(
    deployedSource(
      { id: 'new', annotations: { 'workers/tag': `git-${commit}` } },
      'root',
      baseline
    ),
    commit
  );
  assert.equal(deployedSource({ id: 'known' }, 'root', baseline), commit);
  for (const [version, surface] of [
    [{ id: 'other' }, 'root'],
    [{ id: 'known' }, 'artwork'],
    [{ id: 'known', annotations: { 'workers/tag': 'dirty' } }, 'root'],
  ])
    assert.throws(() => deployedSource(version, surface, baseline));
});

test('source guard rejects dirty, untracked, wrong-head and unpublished code', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'rewind-source-guard-'));
  const git = (...args) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  try {
    git('init', '-b', 'main');
    git('config', 'user.name', 'Tests');
    git('config', 'user.email', 'tests@example.invalid');
    writeFileSync(join(cwd, 'source.txt'), 'one');
    git('add', '.');
    git('commit', '-m', 'initial');
    const head = git('rev-parse', 'HEAD');
    git('update-ref', 'refs/remotes/origin/main', head);
    assert.equal(checkSource(head, cwd), head);
    assert.throws(() => checkSource(commit, cwd));
    writeFileSync(join(cwd, 'source.txt'), 'two');
    assert.throws(() => checkSource(head, cwd));
    git('checkout', '--', 'source.txt');
    writeFileSync(join(cwd, 'new.txt'), 'new');
    assert.throws(() => checkSource(head, cwd));
    git('add', '.');
    git('commit', '-m', 'unpublished');
    assert.throws(() => checkSource(undefined, cwd));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('documented deployment scripts use the source guard before migrations', () => {
  const { scripts } = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url))
  );
  assert.ok(scripts.deploy.startsWith('npm run deployment:check &&'));
  assert.equal(scripts['deploy:worker'], 'node scripts/deploy-worker.mjs root');
  assert.equal(
    scripts['deploy:artwork'],
    'node scripts/deploy-worker.mjs artwork'
  );
});

test('equal newest deployment timestamps cannot validate an arbitrary source', () => {
  assert.throws(
    () =>
      activeDeployment([
        deployment('known', '2026-10-13T00:00:00Z'),
        deployment('unknown', '2026-10-13T00:00:00Z'),
      ]),
    /Ambiguous latest deployment/
  );
});
