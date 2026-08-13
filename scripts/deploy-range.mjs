#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const SCHEMA = 'rewind.deploy-range.v1';
const FILE_NAME = 'deploy-range.json';
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const ZERO_SHA = '0'.repeat(40);
const EXPECTED_KEYS = [
  'before_sha',
  'event',
  'head_sha',
  'ref',
  'repository',
  'run_attempt',
  'run_id',
  'schema',
  'workflow',
];

function parseArguments(argv) {
  const [command, ...rest] = argv;
  if (!['write', 'validate'].includes(command)) {
    throw new Error('command must be write or validate');
  }
  const options = { command };
  for (let index = 0; index < rest.length; index += 2) {
    const argument = rest[index];
    const value = rest[index + 1];
    if (!argument?.startsWith('--') || value === undefined) {
      throw new Error(`invalid argument: ${argument ?? ''}`);
    }
    const key = argument.slice(2).replaceAll('-', '_');
    if (options[key] !== undefined)
      throw new Error(`duplicate option: ${argument}`);
    options[key] = value;
  }
  return options;
}

function requireValue(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function requireSha(value, name, { allowZero = false } = {}) {
  requireValue(value, name);
  if (!SHA_PATTERN.test(value))
    throw new Error(`${name} must be a full lowercase SHA`);
  if (!allowZero && value === ZERO_SHA)
    throw new Error(`${name} must not be the zero SHA`);
  return value;
}

function requireDecimal(value, name) {
  requireValue(value, name);
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`${name} must be a positive decimal string`);
  }
  return value;
}

function exactKeys(value) {
  return value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify(EXPECTED_KEYS)
    ? value
    : null;
}

export function createDeployRange({
  repository,
  workflow,
  event,
  ref,
  beforeSha,
  headSha,
  runId,
  runAttempt,
}) {
  const document = {
    schema: SCHEMA,
    repository: requireValue(repository, 'repository'),
    workflow: requireValue(workflow, 'workflow'),
    event: requireValue(event, 'event'),
    ref: requireValue(ref, 'ref'),
    before_sha: requireSha(beforeSha, 'before_sha'),
    head_sha: requireSha(headSha, 'head_sha'),
    run_id: requireDecimal(runId, 'run_id'),
    run_attempt: requireDecimal(runAttempt, 'run_attempt'),
  };
  if (document.before_sha === document.head_sha) {
    throw new Error('before_sha and head_sha must differ');
  }
  return document;
}

export function validateDeployRange(document, expected) {
  if (!exactKeys(document))
    throw new Error('artifact schema keys are invalid or ambiguous');
  const normalized = createDeployRange({
    repository: document.repository,
    workflow: document.workflow,
    event: document.event,
    ref: document.ref,
    beforeSha: document.before_sha,
    headSha: document.head_sha,
    runId: document.run_id,
    runAttempt: document.run_attempt,
  });
  if (document.schema !== SCHEMA)
    throw new Error('artifact schema version is invalid');
  const comparisons = {
    repository: expected.repository,
    workflow: expected.workflow,
    event: expected.event,
    ref: expected.ref,
    head_sha: expected.headSha,
    run_id: expected.runId,
    run_attempt: expected.runAttempt,
  };
  for (const [key, value] of Object.entries(comparisons)) {
    if (normalized[key] !== value)
      throw new Error(`artifact ${key} does not match the triggering run`);
  }
  return normalized;
}

export function readDeployRangeDirectory(directory, expected) {
  const directoryStat = lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error('artifact download path must be one real directory');
  }
  const entries = readdirSync(directory);
  if (entries.length !== 1 || entries[0] !== FILE_NAME) {
    throw new Error('artifact download is missing, duplicate, or ambiguous');
  }
  const path = join(directory, FILE_NAME);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('artifact payload must be one regular file');
  }
  if (stat.size === 0 || stat.size > 4096) {
    throw new Error('artifact payload size is invalid');
  }
  let document;
  try {
    document = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`artifact payload is malformed JSON: ${error.message}`);
  }
  return validateDeployRange(document, expected);
}

function verifyGitRange(baseSha, headSha) {
  execFileSync('git', ['cat-file', '-e', `${baseSha}^{commit}`], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  execFileSync('git', ['cat-file', '-e', `${headSha}^{commit}`], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  execFileSync('git', ['merge-base', '--is-ancestor', baseSha, headSha], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
}

function writeOutputs(path, document) {
  for (const [key, value] of [
    ['base_sha', document.before_sha],
    ['head_sha', document.head_sha],
  ]) {
    appendFileSync(path, `${key}=${value}\n`, 'utf8');
  }
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.command === 'write') {
    const document = createDeployRange({
      repository: options.repository,
      workflow: options.workflow,
      event: options.event,
      ref: options.ref,
      beforeSha: options.before,
      headSha: options.head,
      runId: options.run_id,
      runAttempt: options.run_attempt,
    });
    const output = requireValue(options.output, 'output');
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify(document)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    return;
  }

  const document = readDeployRangeDirectory(
    requireValue(options.directory, 'directory'),
    {
      repository: requireValue(
        options.expected_repository,
        'expected_repository'
      ),
      workflow: requireValue(options.expected_workflow, 'expected_workflow'),
      event: requireValue(options.expected_event, 'expected_event'),
      ref: requireValue(options.expected_ref, 'expected_ref'),
      headSha: requireSha(options.expected_head, 'expected_head'),
      runId: requireDecimal(options.expected_run_id, 'expected_run_id'),
      runAttempt: requireDecimal(
        options.expected_run_attempt,
        'expected_run_attempt'
      ),
    }
  );
  verifyGitRange(document.before_sha, document.head_sha);
  writeOutputs(requireValue(options.output, 'output'), document);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(`[deploy-range] ${error.message}`);
    process.exitCode = 1;
  }
}
