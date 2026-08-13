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

const SCHEMA = 'rewind.deploy-checkpoint.v1';
const FILE_NAME = 'deploy-checkpoint.json';
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const EXPECTED_KEYS = [
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
  if (!['create', 'locate', 'resolve'].includes(command)) {
    throw new Error('command must be create, locate, or resolve');
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

function requireSha(value, name) {
  requireValue(value, name);
  if (!SHA_PATTERN.test(value) || value === '0'.repeat(40)) {
    throw new Error(`${name} must be one full lowercase nonzero SHA`);
  }
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

function gitAncestor(baseSha, headSha, cwd) {
  execFileSync('git', ['cat-file', '-e', `${baseSha}^{commit}`], {
    stdio: ['ignore', 'ignore', 'pipe'],
    cwd,
  });
  execFileSync('git', ['cat-file', '-e', `${headSha}^{commit}`], {
    stdio: ['ignore', 'ignore', 'pipe'],
    cwd,
  });
  execFileSync('git', ['merge-base', '--is-ancestor', baseSha, headSha], {
    stdio: ['ignore', 'ignore', 'pipe'],
    cwd,
  });
}

function writeOutputs(path, values) {
  for (const [key, value] of Object.entries(values)) {
    const rendered = String(value);
    if (rendered.includes('\n') || rendered.includes('\r')) {
      throw new Error(`output ${key} must be one line`);
    }
    appendFileSync(path, `${key}=${rendered}\n`, 'utf8');
  }
}

export function createCheckpoint({
  repository,
  workflow,
  event,
  ref,
  headSha,
  runId,
  runAttempt,
}) {
  return {
    schema: SCHEMA,
    repository: requireValue(repository, 'repository'),
    workflow: requireValue(workflow, 'workflow'),
    event: requireValue(event, 'event'),
    ref: requireValue(ref, 'ref'),
    head_sha: requireSha(headSha, 'head_sha'),
    run_id: requireDecimal(runId, 'run_id'),
    run_attempt: requireDecimal(runAttempt, 'run_attempt'),
  };
}

export function validateCheckpoint(document, expected) {
  if (!exactKeys(document)) {
    throw new Error('checkpoint schema keys are invalid or ambiguous');
  }
  const normalized = createCheckpoint({
    repository: document.repository,
    workflow: document.workflow,
    event: document.event,
    ref: document.ref,
    headSha: document.head_sha,
    runId: document.run_id,
    runAttempt: document.run_attempt,
  });
  if (document.schema !== SCHEMA)
    throw new Error('checkpoint schema version is invalid');
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
    if (normalized[key] !== value) {
      throw new Error(`checkpoint ${key} does not match its successful run`);
    }
  }
  return normalized;
}

export function readCheckpointDirectory(directory, expected) {
  const directoryStat = lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error('checkpoint path must be one real directory');
  }
  const entries = readdirSync(directory);
  if (entries.length !== 1 || entries[0] !== FILE_NAME) {
    throw new Error('checkpoint is missing, duplicate, or ambiguous');
  }
  const path = join(directory, FILE_NAME);
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size === 0 ||
    stat.size > 4096
  ) {
    throw new Error('checkpoint payload must be one small regular file');
  }
  let document;
  try {
    document = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`checkpoint payload is malformed JSON: ${error.message}`);
  }
  return validateCheckpoint(document, expected);
}

function validateRun(
  run,
  { repository, workflow, path, events, workflowId = null }
) {
  if (
    !run ||
    typeof run !== 'object' ||
    !Number.isSafeInteger(run.id) ||
    run.id <= 0 ||
    !Number.isSafeInteger(run.run_attempt) ||
    run.run_attempt <= 0 ||
    !Number.isSafeInteger(run.run_number) ||
    run.run_number <= 0 ||
    !Number.isSafeInteger(run.workflow_id) ||
    run.workflow_id <= 0 ||
    (workflowId !== null && run.workflow_id !== workflowId) ||
    run.status !== 'completed' ||
    run.conclusion !== 'success' ||
    run.repository?.full_name !== repository ||
    run.name !== workflow ||
    run.path !== path ||
    !events.includes(run.event) ||
    run.head_branch !== 'main' ||
    !SHA_PATTERN.test(run.head_sha ?? '') ||
    !Number.isFinite(Date.parse(run.created_at ?? ''))
  ) {
    throw new Error('GitHub returned an invalid successful workflow run');
  }
  return run;
}

async function githubJson(fetchImpl, url, token) {
  const response = await fetchImpl(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response?.ok) {
    throw new Error(
      `GitHub Actions API failed with status ${response?.status}`
    );
  }
  return response.json();
}

export async function locateCheckpoint({
  repository,
  workflow,
  workflowFile,
  workflowPath,
  events,
  bootstrapSha,
  currentHead,
  currentRunId,
  currentRunNumber,
  token,
  fetchImpl = fetch,
  cwd,
}) {
  requireValue(repository, 'repository');
  requireValue(workflow, 'workflow');
  requireValue(workflowFile, 'workflow_file');
  requireValue(workflowPath, 'workflow_path');
  requireValue(token, 'token');
  requireSha(bootstrapSha, 'bootstrap_sha');
  requireSha(currentHead, 'current_head');
  const exactCurrentRunId = requireDecimal(currentRunId, 'current_run_id');
  const exactCurrentRunNumber = requireDecimal(
    currentRunNumber,
    'current_run_number'
  );
  gitAncestor(bootstrapSha, currentHead, cwd);

  const apiRoot = `https://api.github.com/repos/${repository}`;
  const currentRun = await githubJson(
    fetchImpl,
    `${apiRoot}/actions/runs/${exactCurrentRunId}`,
    token
  );
  if (
    String(currentRun?.id) !== exactCurrentRunId ||
    String(currentRun?.run_number) !== exactCurrentRunNumber ||
    currentRun?.repository?.full_name !== repository ||
    currentRun?.name !== workflow ||
    currentRun?.path !== workflowPath ||
    !events.includes(currentRun?.event) ||
    currentRun?.head_branch !== 'main' ||
    currentRun?.head_sha !== currentHead ||
    !Number.isSafeInteger(currentRun?.workflow_id) ||
    currentRun.workflow_id <= 0 ||
    !Number.isFinite(Date.parse(currentRun?.created_at ?? ''))
  ) {
    throw new Error('current workflow run identity is malformed or mismatched');
  }
  const currentCreatedAt = Date.parse(currentRun.created_at);
  const runsDocument = await githubJson(
    fetchImpl,
    `${apiRoot}/actions/workflows/${encodeURIComponent(workflowFile)}/runs?branch=main&status=success&per_page=100`,
    token
  );
  if (!Array.isArray(runsDocument?.workflow_runs)) {
    throw new Error('GitHub workflow-run response is malformed');
  }
  const relevantRuns = runsDocument.workflow_runs
    .filter(
      (run) =>
        run?.status === 'completed' &&
        run?.conclusion === 'success' &&
        run?.head_branch === 'main' &&
        events.includes(run?.event)
    )
    .map((run) =>
      validateRun(run, {
        repository,
        workflow,
        path: workflowPath,
        events,
      })
    );
  if (relevantRuns.some((run) => run.workflow_id !== currentRun.workflow_id)) {
    throw new Error(
      'successful run does not match the exact current workflow ID'
    );
  }
  const sameWorkflowRuns = relevantRuns.filter(
    (run) => run?.workflow_id === currentRun.workflow_id
  );
  if (
    sameWorkflowRuns.some(
      (run) =>
        !Number.isSafeInteger(run?.run_number) ||
        run.run_number >= Number(exactCurrentRunNumber) ||
        !Number.isFinite(Date.parse(run?.created_at ?? '')) ||
        Date.parse(run.created_at) >= currentCreatedAt ||
        String(run?.id) === exactCurrentRunId
    )
  ) {
    throw new Error('GitHub returned a current or future successful run');
  }
  const candidates = sameWorkflowRuns
    .filter((run) => run?.workflow_id === currentRun.workflow_id)
    .map((run) =>
      validateRun(run, {
        repository,
        workflow,
        path: workflowPath,
        events,
        workflowId: currentRun.workflow_id,
      })
    )
    .sort(
      (left, right) =>
        right.run_number - left.run_number ||
        Date.parse(right.created_at) - Date.parse(left.created_at) ||
        right.id - left.id
    );

  if (candidates.length === 0) {
    return { mode: 'bootstrap', expectedHead: bootstrapSha };
  }
  const run = candidates[0];
  gitAncestor(run.head_sha, currentHead, cwd);
  const artifactName = `deploy-checkpoint-${run.id}-${run.run_attempt}`;
  const artifactsDocument = await githubJson(
    fetchImpl,
    `${apiRoot}/actions/runs/${run.id}/artifacts?name=${encodeURIComponent(artifactName)}&per_page=100`,
    token
  );
  if (!Array.isArray(artifactsDocument?.artifacts)) {
    throw new Error('GitHub artifact response is malformed');
  }
  const artifacts = artifactsDocument.artifacts.filter(
    (artifact) => artifact?.name === artifactName
  );
  if (artifacts.length === 0) {
    gitAncestor(run.head_sha, bootstrapSha, cwd);
    return { mode: 'bootstrap', expectedHead: bootstrapSha };
  }
  if (artifacts.length !== 1) {
    throw new Error('checkpoint artifact is duplicate or ambiguous');
  }
  const artifact = artifacts[0];
  if (
    !Number.isSafeInteger(artifact.id) ||
    artifact.id <= 0 ||
    artifact.expired !== false ||
    artifact.workflow_run?.id !== run.id ||
    artifact.size_in_bytes <= 0 ||
    artifact.size_in_bytes > 8192
  ) {
    throw new Error('checkpoint artifact is expired or malformed');
  }
  return {
    mode: 'artifact',
    runId: String(run.id),
    runAttempt: String(run.run_attempt),
    event: run.event,
    artifactName,
    expectedHead: run.head_sha,
  };
}

function resolveBase(options) {
  const mode = requireValue(options.mode, 'mode');
  const bootstrapSha = requireSha(options.bootstrap, 'bootstrap');
  const currentHead = requireSha(options.current_head, 'current_head');
  let baseSha;
  if (mode === 'bootstrap') {
    baseSha = bootstrapSha;
  } else if (mode === 'artifact') {
    const document = readCheckpointDirectory(
      requireValue(options.directory, 'directory'),
      {
        repository: requireValue(
          options.expected_repository,
          'expected_repository'
        ),
        workflow: requireValue(options.expected_workflow, 'expected_workflow'),
        event: requireValue(options.expected_event, 'expected_event'),
        ref: 'refs/heads/main',
        headSha: requireSha(options.expected_head, 'expected_head'),
        runId: requireDecimal(options.expected_run_id, 'expected_run_id'),
        runAttempt: requireDecimal(
          options.expected_run_attempt,
          'expected_run_attempt'
        ),
      }
    );
    baseSha = document.head_sha;
  } else {
    throw new Error('checkpoint mode must be bootstrap or artifact');
  }
  gitAncestor(baseSha, currentHead);
  writeOutputs(requireValue(options.output, 'output'), { base_sha: baseSha });
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.command === 'create') {
    const document = createCheckpoint({
      repository: options.repository,
      workflow: options.workflow,
      event: options.event,
      ref: options.ref,
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
  if (options.command === 'locate') {
    const located = await locateCheckpoint({
      repository: options.repository,
      workflow: options.workflow,
      workflowFile: options.workflow_file,
      workflowPath: options.workflow_path,
      events: requireValue(options.events, 'events').split(','),
      bootstrapSha: options.bootstrap,
      currentHead: options.current_head,
      currentRunId: options.current_run_id,
      currentRunNumber: options.current_run_number,
      token: process.env.GITHUB_TOKEN,
    });
    writeOutputs(requireValue(options.output, 'output'), {
      mode: located.mode,
      checkpoint_run_id: located.runId ?? '',
      checkpoint_run_attempt: located.runAttempt ?? '',
      checkpoint_event: located.event ?? '',
      checkpoint_artifact_name: located.artifactName ?? '',
      expected_checkpoint_head: located.expectedHead,
    });
    return;
  }
  resolveBase(options);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[deploy-checkpoint] ${error.message}`);
    process.exitCode = 1;
  });
}
