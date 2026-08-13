import assert from 'node:assert/strict';
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
  createDeployRange,
  readDeployRangeDirectory,
  validateDeployRange,
} from './deploy-range.mjs';

const BASE = '1'.repeat(40);
const HEAD = '2'.repeat(40);
const expected = {
  repository: 'pdugan20/rewind',
  workflow: 'CI',
  event: 'push',
  ref: 'refs/heads/main',
  headSha: HEAD,
  runId: '1234',
  runAttempt: '1',
};

function validDocument() {
  return {
    ...createDeployRange({
      repository: expected.repository,
      workflow: expected.workflow,
      event: expected.event,
      ref: expected.ref,
      beforeSha: BASE,
      headSha: expected.headSha,
      runId: expected.runId,
      runAttempt: expected.runAttempt,
    }),
  };
}

function withDirectory(run) {
  const directory = mkdtempSync(join(tmpdir(), 'rewind-deploy-range-'));
  try {
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('accepts one exact deployment-range document', () => {
  assert.deepEqual(
    validateDeployRange(validDocument(), expected),
    validDocument()
  );
});

test('rejects first-push zero-before and abbreviated or uppercase SHAs', () => {
  for (const beforeSha of ['0'.repeat(40), 'abc123', 'A'.repeat(40)]) {
    assert.throws(
      () =>
        createDeployRange({
          repository: expected.repository,
          workflow: expected.workflow,
          event: expected.event,
          ref: expected.ref,
          beforeSha,
          headSha: HEAD,
          runId: expected.runId,
          runAttempt: expected.runAttempt,
        }),
      /SHA/
    );
  }
});

test('rejects tampered repository, head, run identity, and schema', () => {
  for (const mutate of [
    (document) => {
      document.repository = 'attacker/fork';
    },
    (document) => {
      document.head_sha = '3'.repeat(40);
    },
    (document) => {
      document.run_id = '9999';
    },
    (document) => {
      document.run_attempt = '2';
    },
    (document) => {
      document.schema = 'rewind.deploy-range.v0';
    },
    (document) => {
      document.extra = true;
    },
  ]) {
    const document = validDocument();
    mutate(document);
    assert.throws(() => validateDeployRange(document, expected));
  }
});

test('rejects missing or expired, duplicate, malformed, oversized, and ambiguous downloads', () => {
  for (const setup of [
    () => {},
    (directory) => {
      writeFileSync(join(directory, 'deploy-range.json'), '{');
    },
    (directory) => {
      writeFileSync(join(directory, 'deploy-range.json'), 'x'.repeat(4097));
    },
    (directory) => {
      writeFileSync(
        join(directory, 'deploy-range.json'),
        JSON.stringify(validDocument())
      );
      writeFileSync(join(directory, 'duplicate.json'), '{}');
    },
    (directory) => {
      mkdirSync(join(directory, 'deploy-range-1234'));
      writeFileSync(
        join(directory, 'deploy-range-1234', 'deploy-range.json'),
        JSON.stringify(validDocument())
      );
    },
  ]) {
    withDirectory((directory) => {
      setup(directory);
      assert.throws(() => readDeployRangeDirectory(directory, expected));
    });
  }
});

test('rejects a symlinked artifact payload', () => {
  withDirectory((directory) => {
    const outside = join(directory, 'outside.json');
    writeFileSync(outside, JSON.stringify(validDocument()));
    symlinkSync(outside, join(directory, 'deploy-range.json'));
    rmSync(outside);
    assert.throws(() => readDeployRangeDirectory(directory, expected));
  });
});
