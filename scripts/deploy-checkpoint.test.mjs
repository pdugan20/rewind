import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createCheckpoint,
  locateCheckpoint,
  readCheckpointDirectory,
  validateCheckpoint,
} from './deploy-checkpoint.mjs';
import { classifyGitRange } from './deploy-impact.mjs';

const REPOSITORY = 'pdugan20/rewind';
const WORKFLOW = 'Deploy';
const WORKFLOW_PATH = '.github/workflows/deploy.yml';
const WORKFLOW_ID = 77;

function git(directory, args) {
  return execFileSync('git', args, {
    cwd: directory,
    encoding: 'utf8',
  }).trim();
}

function commit(directory, message, contents) {
  writeFileSync(join(directory, 'state.txt'), `${contents}\n`);
  git(directory, ['add', 'state.txt']);
  git(directory, ['commit', '-m', message]);
  return git(directory, ['rev-parse', 'HEAD']);
}

async function withRepository(run) {
  const directory = mkdtempSync(join(tmpdir(), 'rewind-checkpoint-git-'));
  try {
    git(directory, ['init', '-b', 'main']);
    git(directory, ['config', 'user.email', 'checkpoint@example.com']);
    git(directory, ['config', 'user.name', 'Checkpoint Test']);
    const bootstrap = commit(directory, 'bootstrap', 'bootstrap');
    mkdirSync(join(directory, 'src'));
    writeFileSync(
      join(directory, 'src', 'runtime.ts'),
      'export const a = 1;\n'
    );
    git(directory, ['add', 'src/runtime.ts']);
    git(directory, ['commit', '-m', 'runtime push']);
    const prior = git(directory, ['rev-parse', 'HEAD']);
    writeFileSync(join(directory, 'README.md'), 'docs-only follow-up\n');
    git(directory, ['add', 'README.md']);
    git(directory, ['commit', '-m', 'docs push']);
    const head = git(directory, ['rev-parse', 'HEAD']);
    return await run({ directory, bootstrap, prior, head });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function runDocument({
  id,
  runNumber,
  headSha,
  createdAt,
  event = 'workflow_run',
}) {
  return {
    id,
    run_attempt: 1,
    run_number: runNumber,
    workflow_id: WORKFLOW_ID,
    status: 'completed',
    conclusion: 'success',
    repository: { full_name: REPOSITORY },
    name: WORKFLOW,
    path: WORKFLOW_PATH,
    event,
    head_branch: 'main',
    head_sha: headSha,
    created_at: createdAt,
  };
}

function mockFetch({ current, runs, artifacts }) {
  return async (url) => {
    let body;
    if (url.endsWith(`/actions/runs/${current.id}`)) body = current;
    else if (url.includes('/actions/workflows/'))
      body = { workflow_runs: runs };
    else if (url.includes('/artifacts?')) body = { artifacts };
    else return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => body };
  };
}

function currentRun(head) {
  return {
    ...runDocument({
      id: 1000,
      runNumber: 20,
      headSha: head,
      createdAt: '2026-08-13T18:00:00Z',
    }),
    status: 'in_progress',
    conclusion: null,
  };
}

function locateArguments({ directory, bootstrap, head, fetchImpl }) {
  return {
    repository: REPOSITORY,
    workflow: WORKFLOW,
    workflowFile: 'deploy.yml',
    workflowPath: WORKFLOW_PATH,
    events: ['workflow_run', 'workflow_dispatch'],
    bootstrapSha: bootstrap,
    currentHead: head,
    currentRunId: '1000',
    currentRunNumber: '20',
    token: 'test-token',
    fetchImpl,
    cwd: directory,
  };
}

test('creates and validates one exact checkpoint document', () => {
  const document = createCheckpoint({
    repository: REPOSITORY,
    workflow: WORKFLOW,
    event: 'workflow_run',
    ref: 'refs/heads/main',
    headSha: '1'.repeat(40),
    runId: '123',
    runAttempt: '1',
  });
  assert.deepEqual(
    validateCheckpoint(document, {
      repository: REPOSITORY,
      workflow: WORKFLOW,
      event: 'workflow_run',
      ref: 'refs/heads/main',
      headSha: '1'.repeat(40),
      runId: '123',
      runAttempt: '1',
    }),
    document
  );
});

test('selects the highest valid prior run number and exact artifact', async () => {
  await withRepository(async ({ directory, bootstrap, prior, head }) => {
    const selected = runDocument({
      id: 900,
      runNumber: 19,
      headSha: prior,
      createdAt: '2026-08-13T17:00:00Z',
    });
    const lower = runDocument({
      id: 999,
      runNumber: 18,
      headSha: bootstrap,
      createdAt: '2026-08-13T17:30:00Z',
    });
    const artifact = {
      id: 55,
      name: 'deploy-checkpoint-900-1',
      expired: false,
      size_in_bytes: 300,
      workflow_run: { id: 900 },
    };
    const result = await locateCheckpoint(
      locateArguments({
        directory,
        bootstrap,
        head,
        fetchImpl: mockFetch({
          current: currentRun(head),
          runs: [lower, selected],
          artifacts: [artifact],
        }),
      })
    );
    assert.deepEqual(result, {
      mode: 'artifact',
      runId: '900',
      runAttempt: '1',
      event: 'workflow_run',
      artifactName: 'deploy-checkpoint-900-1',
      expectedHead: prior,
    });
  });
});

test('cumulative baseline survives a superseded intermediate push', async () => {
  await withRepository(async ({ directory, bootstrap, prior, head }) => {
    const lastSuccess = runDocument({
      id: 800,
      runNumber: 17,
      headSha: bootstrap,
      createdAt: '2026-08-13T16:00:00Z',
    });
    const result = await locateCheckpoint(
      locateArguments({
        directory,
        bootstrap,
        head,
        fetchImpl: mockFetch({
          current: currentRun(head),
          runs: [lastSuccess],
          artifacts: [
            {
              id: 54,
              name: 'deploy-checkpoint-800-1',
              expired: false,
              size_in_bytes: 300,
              workflow_run: { id: 800 },
            },
          ],
        }),
      })
    );
    assert.equal(result.expectedHead, bootstrap);
    assert.notEqual(result.expectedHead, prior);
    assert.equal(
      classifyGitRange(result.expectedHead, head, { cwd: directory })
        .rootWorker,
      true
    );
    assert.equal(
      classifyGitRange(prior, head, { cwd: directory }).rootWorker,
      false
    );
  });
});

test('rejects current, future, wrong-workflow, and non-ancestor checkpoints', async () => {
  await withRepository(async ({ directory, bootstrap, prior, head }) => {
    const base = locateArguments({
      directory,
      bootstrap,
      head,
      fetchImpl: null,
    });
    const validArtifact = {
      id: 55,
      name: 'deploy-checkpoint-900-1',
      expired: false,
      size_in_bytes: 300,
      workflow_run: { id: 900 },
    };
    const mutations = [
      runDocument({
        id: 1001,
        runNumber: 21,
        headSha: head,
        createdAt: '2026-08-13T19:00:00Z',
      }),
      {
        ...runDocument({
          id: 900,
          runNumber: 19,
          headSha: prior,
          createdAt: '2026-08-13T17:00:00Z',
        }),
        workflow_id: 88,
      },
      runDocument({
        id: 900,
        runNumber: 19,
        headSha: 'f'.repeat(40),
        createdAt: '2026-08-13T17:00:00Z',
      }),
    ];
    for (const run of mutations) {
      const fetchImpl = mockFetch({
        current: currentRun(head),
        runs: [run],
        artifacts: [validArtifact],
      });
      await assert.rejects(() => locateCheckpoint({ ...base, fetchImpl }));
    }
  });
});

test('fails closed on duplicate, expired, missing-after-cutover, and mismatched artifacts', async () => {
  await withRepository(async ({ directory, bootstrap, prior, head }) => {
    const run = runDocument({
      id: 900,
      runNumber: 19,
      headSha: prior,
      createdAt: '2026-08-13T17:00:00Z',
    });
    const artifact = {
      id: 55,
      name: 'deploy-checkpoint-900-1',
      expired: false,
      size_in_bytes: 300,
      workflow_run: { id: 900 },
    };
    for (const artifacts of [
      [artifact, { ...artifact, id: 56 }],
      [{ ...artifact, expired: true }],
      [],
      [{ ...artifact, workflow_run: { id: 899 } }],
    ]) {
      await assert.rejects(() =>
        locateCheckpoint(
          locateArguments({
            directory,
            bootstrap,
            head,
            fetchImpl: mockFetch({
              current: currentRun(head),
              runs: [run],
              artifacts,
            }),
          })
        )
      );
    }
  });
});

test('allows bootstrap only while the latest successful head predates cutover', async () => {
  await withRepository(async ({ directory, bootstrap, head }) => {
    const preCutover = runDocument({
      id: 700,
      runNumber: 16,
      headSha: bootstrap,
      createdAt: '2026-08-13T15:00:00Z',
    });
    const result = await locateCheckpoint(
      locateArguments({
        directory,
        bootstrap,
        head,
        fetchImpl: mockFetch({
          current: currentRun(head),
          runs: [preCutover],
          artifacts: [],
        }),
      })
    );
    assert.deepEqual(result, {
      mode: 'bootstrap',
      expectedHead: bootstrap,
    });
  });
});

test('rejects malformed, ambiguous, and symlinked downloaded checkpoints', () => {
  const directory = mkdtempSync(join(tmpdir(), 'rewind-checkpoint-file-'));
  const expected = {
    repository: REPOSITORY,
    workflow: WORKFLOW,
    event: 'workflow_run',
    ref: 'refs/heads/main',
    headSha: '1'.repeat(40),
    runId: '123',
    runAttempt: '1',
  };
  try {
    assert.throws(() => readCheckpointDirectory(directory, expected));
    writeFileSync(join(directory, 'deploy-checkpoint.json'), '{');
    assert.throws(() => readCheckpointDirectory(directory, expected));
    rmSync(join(directory, 'deploy-checkpoint.json'));
    mkdirSync(join(directory, 'nested'));
    assert.throws(() => readCheckpointDirectory(directory, expected));
    rmSync(join(directory, 'nested'), { recursive: true });
    const outside = join(directory, 'outside.json');
    writeFileSync(outside, '{}');
    symlinkSync(outside, join(directory, 'deploy-checkpoint.json'));
    assert.throws(() => readCheckpointDirectory(directory, expected));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
