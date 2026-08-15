import assert from 'node:assert/strict';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { isDeepStrictEqual } from 'node:util';

import { parse } from 'yaml';

import {
  validateSecurityExceptionRegistry,
  verifySecurityExceptionLifecycle,
} from './security-exception.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHECKOUT = 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1';
const SETUP_NODE =
  'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020';
const DEPENDENCY_REVIEW =
  'actions/dependency-review-action@a1d282b36b6f3519aa1f3fc636f609c47dddb294';
const PR_TITLE =
  'amannn/action-semantic-pull-request@48f256284bd46cdaab1048c3721360e808335d50';
const RELEASE_PLEASE =
  'googleapis/release-please-action@45996ed1f6d02564a971a2fa1b5860e934307cf7';
const UPLOAD_ARTIFACT =
  'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a';
const DOWNLOAD_ARTIFACT =
  'actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c';
const DEPLOY_BOOTSTRAP = '63e89155d5e01821d908ff1cada2b62334245d19';
const STABLE_SEMVER_CURRENT_VERSION =
  '/^[1-9][0-9]*\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$/';
const ACTION_PINS = new Map([
  ['actions/checkout', `${CHECKOUT} # v7`],
  ['actions/setup-node', `${SETUP_NODE} # v7`],
  ['actions/dependency-review-action', `${DEPENDENCY_REVIEW} # v5.0.0`],
  ['amannn/action-semantic-pull-request', `${PR_TITLE} # v6`],
  ['googleapis/release-please-action', `${RELEASE_PLEASE} # v5`],
  ['actions/upload-artifact', `${UPLOAD_ARTIFACT} # v7`],
  ['actions/download-artifact', `${DOWNLOAD_ARTIFACT} # v8`],
]);

function parseYaml(source, label = 'fixture') {
  try {
    return parse(source);
  } catch (error) {
    throw new Error(`${label} is malformed YAML: ${error.message}`);
  }
}

function permissionMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value;
}

function sameObject(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function matchesRenovateRegex(pattern, value) {
  const match = typeof pattern === 'string' && pattern.match(/^\/(.*)\/$/);
  assert.ok(match, `expected a positive Renovate regex, received ${pattern}`);
  return new RegExp(match[1], 'u').test(value);
}

function normalizeExpression(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

function normalizeCommands(value) {
  return typeof value === 'string'
    ? value
        .trim()
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
    : [];
}

function walk(value, visit, path = []) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => walk(entry, visit, [...path, index]));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    visit(key, child, [...path, key]);
    walk(child, visit, [...path, key]);
  }
}

function collectValues(document, wantedKey) {
  const values = [];
  walk(document, (key, value, path) => {
    if (key === wantedKey) values.push({ value, path });
  });
  return values;
}

function validateActionUse(use, problems) {
  if (typeof use === 'string' && use.startsWith('docker://')) {
    problems.push(`Docker action references are forbidden: ${use}`);
    return;
  }
  if (typeof use !== 'string' || use.startsWith('./')) return;
  const match = use.match(/^([^@]+)@([0-9a-f]{40})$/);
  if (!match) {
    problems.push(`external Action is not pinned to a full commit: ${use}`);
    return;
  }
  if (
    /(?:^|[-_/])(auto-?merge|merge-pull-request|approve)(?:[-_/]|$)/i.test(
      match[1]
    )
  ) {
    problems.push(
      `merge or approval Action is forbidden even when pinned: ${use}`
    );
  }
}

function validateActionComments(source, problems) {
  for (const match of source.matchAll(
    /^\s*-?\s*uses:\s*['"]?([^'"\s#]+)[^\n]*$/gm
  )) {
    const use = match[1];
    if (use.startsWith('./') || use.startsWith('docker://')) continue;
    const ownerRepo = use.slice(0, use.indexOf('@'));
    const expected = ACTION_PINS.get(ownerRepo);
    if (!expected || !match[0].includes(expected)) {
      problems.push(
        `Action pin or major-version comment is not approved: ${match[0].trim()}`
      );
    }
  }
}

function validateRun(run, problems) {
  if (typeof run !== 'string') return;
  const mutationPatterns = [
    /\bgh\s+pr\s+(?:merge|review|ready)\b/i,
    /\bgh\s+api\b/i,
    /api\.github\.com/i,
    /\bgraphql\b/i,
    /\b(?:auto-?merge|merge-queue|approve)\b/i,
  ];
  if (mutationPatterns.some((pattern) => pattern.test(run))) {
    problems.push(
      `merge, approval, or GitHub API mutation command is forbidden: ${run}`
    );
  }
  if (/\bnpx\b/.test(run) || /@[Ll]atest\b/.test(run)) {
    problems.push(
      `workflow tool must resolve from the exact local lockfile: ${run}`
    );
  }
}

function validatePermissions(name, document, problems) {
  const expectedTop = {
    'ci.yml': { contents: 'read' },
    'deploy.yml': { actions: 'read', contents: 'read' },
    'mcp-server.yml': { actions: 'read', contents: 'read' },
    'pr-lint.yml': { 'pull-requests': 'read' },
    'release-please.yml': { contents: 'write', 'pull-requests': 'write' },
    'security-exceptions.yml': {
      contents: 'read',
      'vulnerability-alerts': 'read',
    },
  }[name];
  if (!sameObject(permissionMap(document.permissions), expectedTop)) {
    problems.push(
      `${name} must have exact top-level permissions ${JSON.stringify(expectedTop)}`
    );
  }
  for (const [jobId, job] of Object.entries(document.jobs ?? {})) {
    if (!job?.permissions) continue;
    const expected =
      name === 'mcp-server.yml' && jobId === 'publish-npm'
        ? { contents: 'read', 'id-token': 'write' }
        : null;
    if (!expected || !sameObject(permissionMap(job.permissions), expected)) {
      problems.push(`${name}:${jobId} has an unapproved job permission map`);
    }
  }
}

function stepRun(step) {
  return typeof step?.run === 'string' ? step.run : '';
}

function validateInstallOrdering(name, document, problems) {
  for (const [jobId, job] of Object.entries(document.jobs ?? {})) {
    const steps = job?.steps ?? [];
    const isMcp = name === 'mcp-server.yml';
    const nodeInput = isMcp
      ? {
          key: 'node-version',
          value: jobId === 'build' ? '${{ matrix.node-version }}' : '24.19.0',
        }
      : { key: 'node-version-file', value: '.nvmrc' };
    for (let index = 0; index < steps.length; index += 1) {
      if (!/\bnpm ci\b/.test(stepRun(steps[index]))) continue;
      const setupIndex = steps
        .slice(0, index)
        .map((step) => step?.uses)
        .lastIndexOf(SETUP_NODE);
      if (setupIndex < 0) {
        problems.push(`${name}:${jobId} must set up Node before npm ci`);
        continue;
      }
      if (
        String(steps[setupIndex]?.with?.[nodeInput.key]) !== nodeInput.value
      ) {
        problems.push(
          `${name}:${jobId} must use ${nodeInput.key} ${nodeInput.value}`
        );
      }
      const setupAbsoluteIndex = setupIndex;
      const commands = steps
        .slice(setupAbsoluteIndex + 1, index)
        .map(stepRun)
        .join('\n');
      if (!/npm install (?:--global|-g) npm@11\.5\.2/.test(commands)) {
        problems.push(`${name}:${jobId} must install npm 11.5.2 before npm ci`);
      }
      if (
        !/npm --version[\s\S]*(?:11\.5\.2)|(?:11\.5\.2)[\s\S]*npm --version/.test(
          commands
        )
      ) {
        problems.push(`${name}:${jobId} must assert npm 11.5.2 before npm ci`);
      }
    }
  }
}

function validateCi(document, problems) {
  const required = {
    lint: 'Lint',
    test: 'Test',
    docs: 'Docs Links',
    build: 'Build',
    security: 'Security',
    'dependency-review': 'Dependency Review',
    gate: 'CI Gate',
  };
  for (const [id, name] of Object.entries(required)) {
    if (document.jobs?.[id]?.name !== name)
      problems.push(`CI must preserve job ${name}`);
  }
  const concurrency = document.concurrency ?? {};
  if (
    concurrency.group !==
    'ci-${{ github.workflow }}-${{ github.event.pull_request.number || github.run_id }}'
  ) {
    problems.push(
      'CI concurrency must use PR numbers and unique non-PR run IDs'
    );
  }
  if (
    concurrency['cancel-in-progress'] !==
    "${{ github.event_name == 'pull_request' }}"
  ) {
    problems.push('CI cancellation must apply only to pull requests');
  }
  const security = document.jobs?.security;
  if (security?.['continue-on-error'] !== undefined) {
    problems.push('Security must fail closed without continue-on-error');
  }
  if (
    !security?.steps?.some((step) =>
      stepRun(step).includes('npm audit --audit-level=critical --omit=dev')
    )
  ) {
    problems.push('Security must enforce the critical production audit');
  }
  const exceptionSteps = (security?.steps ?? []).filter(
    (step) => stepRun(step) === 'node scripts/security-exception.mjs --offline'
  );
  if (
    exceptionSteps.length !== 1 ||
    exceptionSteps[0]?.env !== undefined ||
    exceptionSteps[0]?.if !== undefined ||
    exceptionSteps[0]?.['continue-on-error'] !== undefined
  ) {
    problems.push(
      'Security must re-evaluate registered exceptions without a PR token and fail closed'
    );
  }
  const dependencyReview = document.jobs?.['dependency-review'];
  if (dependencyReview?.if !== "github.event_name == 'pull_request'") {
    problems.push('Dependency Review must be pull-request-only');
  }
  if (
    !dependencyReview?.steps?.some((step) => step?.uses === DEPENDENCY_REVIEW)
  ) {
    problems.push('Dependency Review must use the approved immutable Action');
  }
  const docsCommands = (document.jobs?.docs?.steps ?? [])
    .map(stepRun)
    .join('\n');
  if (
    !docsCommands.includes(
      'npm exec -- tsx scripts/gen-mcp-reference.ts --check'
    )
  ) {
    problems.push('Docs must invoke the locally installed tsx generator');
  }
  if (!docsCommands.includes('npm exec -- mint broken-links')) {
    problems.push('Docs must invoke exact locally installed Mint');
  }
  const lintCommands = (document.jobs?.lint?.steps ?? [])
    .map(stepRun)
    .join('\n');
  if (!lintCommands.includes('npm run lint:claude')) {
    problems.push('Lint must invoke the local exact Claude lint script');
  }
  validateGate(document.jobs?.gate, problems, document.defaults);
  validateDeploymentRangeMetadata(
    document.jobs?.['deployment-range'],
    problems
  );
}

function validateDeploymentRangeMetadata(job, problems) {
  if (job?.name !== 'Deployment Range Metadata' || job?.needs !== 'gate') {
    problems.push('CI deployment range metadata must run only after CI Gate');
  }
  const expectedCondition = `
    always() &&
    github.event_name == 'push' &&
    github.ref == 'refs/heads/main' &&
    needs.gate.result == 'success'
  `;
  if (normalizeExpression(job?.if) !== normalizeExpression(expectedCondition)) {
    problems.push(
      'CI deployment range metadata must be successful-main-push-only'
    );
  }
  validateExactHeadCheckout(
    job,
    '${{ github.sha }}',
    'CI deployment range metadata',
    problems
  );
  const write = (job?.steps ?? []).find(
    (step) => step?.name === 'Write exact push range'
  );
  const writeRun = stepRun(write);
  for (const expected of [
    'scripts/deploy-range.mjs write',
    '--repository "${{ github.repository }}"',
    '--workflow "${{ github.workflow }}"',
    '--event "${{ github.event_name }}"',
    '--ref "${{ github.ref }}"',
    '--before "${{ github.event.before }}"',
    '--head "${{ github.sha }}"',
    '--run-id "${{ github.run_id }}"',
    '--run-attempt "${{ github.run_attempt }}"',
  ]) {
    if (!writeRun.includes(expected)) {
      problems.push(`CI deployment range metadata must preserve ${expected}`);
    }
  }
  const upload = (job?.steps ?? []).find(
    (step) => step?.name === 'Upload immutable push range'
  );
  const expectedUpload = {
    name: 'deploy-range-${{ github.run_id }}-${{ github.run_attempt }}',
    path: '.deploy-range/deploy-range.json',
    'if-no-files-found': 'error',
    'retention-days': 1,
  };
  if (
    upload?.uses !== UPLOAD_ARTIFACT ||
    !sameObject(upload?.with, expectedUpload) ||
    upload?.['continue-on-error'] !== undefined
  ) {
    problems.push(
      'CI must fail closed while uploading one immutable push range'
    );
  }
  if (JSON.stringify(job ?? {}).includes('CLOUDFLARE_API_TOKEN')) {
    problems.push(
      'CI deployment range metadata must not receive Cloudflare secrets'
    );
  }
}

function validateGate(gate, problems, workflowDefaults) {
  const requiredNeeds = [
    'lint',
    'test',
    'docs',
    'build',
    'security',
    'dependency-review',
  ];
  if (gate?.if !== 'always()') problems.push('CI Gate must use if: always()');
  if (!sameObject(gate?.needs, requiredNeeds)) {
    problems.push('CI Gate must depend on every required diagnostic job');
  }
  if (gate?.['continue-on-error'] !== undefined) {
    problems.push('CI Gate job must not set continue-on-error');
  }
  if (
    workflowDefaults?.run?.shell !== undefined ||
    gate?.defaults?.run?.shell !== undefined
  ) {
    problems.push('CI Gate must not override the fail-closed default shell');
  }
  for (const step of gate?.steps ?? []) {
    if (step?.['continue-on-error'] !== undefined) {
      problems.push('CI Gate steps must not set continue-on-error');
    }
    if (step?.shell !== undefined) {
      problems.push('CI Gate steps must not override the default shell');
    }
  }
  const run = (gate?.steps ?? []).map(stepRun).join('\n');
  const normalizedCommands = normalizeCommands(run);
  const expectedCommands = [
    'test "${{ needs.lint.result }}" = "success" || exit 1',
    'test "${{ needs.test.result }}" = "success" || exit 1',
    'test "${{ needs.docs.result }}" = "success" || exit 1',
    'test "${{ needs.build.result }}" = "success" || exit 1',
    'test "${{ needs.security.result }}" = "success" || exit 1',
    'case "${{ needs.dependency-review.result }}" in',
    'success|skipped) ;;',
    '*) exit 1 ;;',
    'esac',
  ];
  if (!sameObject(normalizedCommands, expectedCommands)) {
    problems.push(
      'CI Gate command must exactly implement the fail-closed result policy'
    );
  }
  for (const dependency of requiredNeeds.slice(0, -1)) {
    if (
      !run.includes(`needs.${dependency}.result`) ||
      !run.includes('success')
    ) {
      problems.push(`CI Gate must require ${dependency} success`);
    }
  }
  if (
    !run.includes('needs.dependency-review.result') ||
    !run.includes('success') ||
    !run.includes('skipped') ||
    !/exit\s+1/.test(run)
  ) {
    problems.push(
      'CI Gate must fail unless Dependency Review succeeds or is intentionally skipped'
    );
  }
}

function serializedJob(document, jobId) {
  return JSON.stringify(document.jobs?.[jobId] ?? {});
}

function validateExactHeadCheckout(job, ref, label, problems) {
  const steps = job?.steps ?? [];
  const checkouts = steps.filter((step) => step?.uses === CHECKOUT);
  const checkout = checkouts[0];
  if (
    checkouts.length !== 1 ||
    checkout?.with?.ref !== ref ||
    checkout?.with?.['fetch-depth'] !== 0
  ) {
    problems.push(`${label} must check out the classified exact head SHA`);
  }
  const verification = steps.find(
    (step) => step?.name === 'Verify trusted checkout'
  );
  if (
    !verification ||
    !stepRun(verification).includes('git rev-parse HEAD') ||
    !stepRun(verification).includes(ref)
  ) {
    problems.push(`${label} must fail closed on an exact-head mismatch`);
  }
}

function validateCheckpointFlow(
  document,
  {
    label,
    workflow,
    workflowFile,
    workflowPath,
    events,
    finalizerNeeds,
    finalizerCondition,
  },
  problems
) {
  const impact = document.jobs?.impact;
  const steps = impact?.steps ?? [];
  const locate = steps.find(
    (step) => step?.name === `Locate prior successful ${label} checkpoint`
  );
  const locateRun = stepRun(locate);
  for (const expected of [
    'scripts/deploy-checkpoint.mjs locate',
    '--workflow "${{ github.workflow }}"',
    `--workflow-file "${workflowFile}"`,
    `--workflow-path "${workflowPath}"`,
    `--events "${events}"`,
    `--bootstrap "${DEPLOY_BOOTSTRAP}"`,
    '--current-head "$(git rev-parse HEAD)"',
    '--current-run-id "${{ github.run_id }}"',
    '--current-run-number "${{ github.run_number }}"',
    '--output "$GITHUB_OUTPUT"',
  ]) {
    if (!locateRun.includes(expected)) {
      problems.push(`${label} checkpoint locator must preserve ${expected}`);
    }
  }
  if (
    locate?.id !== 'checkpoint' ||
    locate?.env?.GITHUB_TOKEN !== '${{ github.token }}' ||
    locate?.['continue-on-error'] !== undefined
  ) {
    problems.push(
      `${label} checkpoint locator must fail closed with Actions read`
    );
  }

  const download = steps.find(
    (step) => step?.name === `Download prior successful ${label} checkpoint`
  );
  const expectedDownload = {
    name: '${{ steps.checkpoint.outputs.checkpoint_artifact_name }}',
    path: '.deploy-checkpoint',
    'github-token': '${{ github.token }}',
    repository: '${{ github.repository }}',
    'run-id': '${{ steps.checkpoint.outputs.checkpoint_run_id }}',
    'digest-mismatch': 'error',
  };
  if (
    download?.uses !== DOWNLOAD_ARTIFACT ||
    !sameObject(download?.with, expectedDownload) ||
    download?.['continue-on-error'] !== undefined
  ) {
    problems.push(`${label} checkpoint download must be exact and fail closed`);
  }

  const resolve = steps.find(
    (step) => step?.name === `Resolve cumulative successful ${label} baseline`
  );
  const resolveRun = stepRun(resolve);
  for (const expected of [
    'scripts/deploy-checkpoint.mjs resolve',
    '--mode "${{ steps.checkpoint.outputs.mode }}"',
    `--bootstrap "${DEPLOY_BOOTSTRAP}"`,
    '--current-head "$(git rev-parse HEAD)"',
    '--expected-repository "${{ github.repository }}"',
    `--expected-workflow "${workflow}"`,
    '--expected-event "${{ steps.checkpoint.outputs.checkpoint_event }}"',
    '--expected-head "${{ steps.checkpoint.outputs.expected_checkpoint_head }}"',
    '--expected-run-id "${{ steps.checkpoint.outputs.checkpoint_run_id }}"',
    '--expected-run-attempt "${{ steps.checkpoint.outputs.checkpoint_run_attempt }}"',
    '--output "$GITHUB_OUTPUT"',
  ]) {
    if (!resolveRun.includes(expected)) {
      problems.push(`${label} cumulative baseline must preserve ${expected}`);
    }
  }
  if (
    resolve?.id !== 'baseline' ||
    resolve?.['continue-on-error'] !== undefined
  ) {
    problems.push(`${label} cumulative baseline must fail closed`);
  }

  const finalizer = document.jobs?.['finalize-checkpoint'];
  if (
    !sameObject(finalizer?.needs, finalizerNeeds) ||
    normalizeExpression(finalizer?.if) !==
      normalizeExpression(finalizerCondition) ||
    finalizer?.['continue-on-error'] !== undefined
  ) {
    problems.push(
      `${label} checkpoint finalizer must depend on every terminal path and reject failure or cancellation`
    );
  }
  validateExactHeadCheckout(
    finalizer,
    '${{ needs.impact.outputs.head_sha }}',
    `${label} checkpoint finalizer`,
    problems
  );
  const finalizerSerialized = JSON.stringify(finalizer ?? {});
  if (
    finalizerSerialized.includes('CLOUDFLARE_API_TOKEN') ||
    finalizerSerialized.includes('wrangler deploy') ||
    finalizerSerialized.includes('d1 migrations apply')
  ) {
    problems.push(
      `${label} checkpoint finalizer must be secret-free metadata only`
    );
  }
  const create = (finalizer?.steps ?? []).find(
    (step) => step?.name === `Write successful ${label} checkpoint`
  );
  const createRun = stepRun(create);
  for (const expected of [
    'scripts/deploy-checkpoint.mjs create',
    '--repository "${{ github.repository }}"',
    '--workflow "${{ github.workflow }}"',
    '--event "${{ github.event_name }}"',
    '--ref "refs/heads/main"',
    '--head "${{ needs.impact.outputs.head_sha }}"',
    '--run-id "${{ github.run_id }}"',
    '--run-attempt "${{ github.run_attempt }}"',
  ]) {
    if (!createRun.includes(expected)) {
      problems.push(`${label} checkpoint finalizer must preserve ${expected}`);
    }
  }
  const upload = (finalizer?.steps ?? []).find(
    (step) => step?.name === `Upload successful ${label} checkpoint`
  );
  const expectedUpload = {
    name: 'deploy-checkpoint-${{ github.run_id }}-${{ github.run_attempt }}',
    path: '.deploy-checkpoint/deploy-checkpoint.json',
    'if-no-files-found': 'error',
    'retention-days': 90,
  };
  if (
    upload?.uses !== UPLOAD_ARTIFACT ||
    !sameObject(upload?.with, expectedUpload) ||
    upload?.['continue-on-error'] !== undefined
  ) {
    problems.push(`${label} checkpoint upload must be exact and fail closed`);
  }
  const gate = document.jobs?.['checkpoint-gate'];
  const gateRun = (gate?.steps ?? []).map(stepRun).join('\n');
  const gateSerialized = JSON.stringify(gate ?? {});
  if (
    gate?.needs !== 'finalize-checkpoint' ||
    gate?.if !== 'always()' ||
    gate?.['continue-on-error'] !== undefined ||
    !gateSerialized.includes('needs.finalize-checkpoint.result') ||
    !gateSerialized.includes('success') ||
    gateSerialized.includes('CLOUDFLARE_API_TOKEN') ||
    gateRun.includes('wrangler')
  ) {
    problems.push(
      `${label} checkpoint completion gate must make missing finalization fail closed`
    );
  }
  if (
    label === 'MCP' &&
    (!gateRun.includes('EVENT_NAME') ||
      !gateRun.includes('EVENT_REF') ||
      !gateRun.includes('refs/heads/main'))
  ) {
    problems.push('MCP checkpoint gate must apply only to main push runs');
  }
}

function validateDeploy(document, problems) {
  const expectedTriggers = {
    workflow_dispatch: null,
    workflow_run: {
      workflows: ['CI'],
      types: ['completed'],
      branches: ['main'],
    },
  };
  if (!isDeepStrictEqual(document.on, expectedTriggers)) {
    problems.push(
      'Deploy triggers must exactly target manual runs and completed main CI'
    );
  }
  if (
    document.concurrency?.group !== 'deploy' ||
    document.concurrency?.['cancel-in-progress'] !== false
  ) {
    problems.push(
      'Deploy must serialize without cancelling the running deployment'
    );
  }
  const expectedJobIds = [
    'impact',
    'apply-d1-migrations',
    'd1-no-impact',
    'deploy-root-worker',
    'root-worker-no-impact',
    'finalize-checkpoint',
    'checkpoint-gate',
  ];
  if (!sameObject(Object.keys(document.jobs ?? {}), expectedJobIds)) {
    problems.push('Deploy must preserve the exact classified job boundary');
  }
  const impact = document.jobs?.impact;
  if (impact?.if !== 'always()') {
    problems.push(
      'Deploy classifier must run and fail closed for every triggering event'
    );
  }
  const steps = impact?.steps ?? [];
  const trustedTrigger = steps.find(
    (step) => step?.name === 'Validate trusted trigger'
  );
  const trustedRun = stepRun(trustedTrigger);
  for (const expected of [
    'test "$EVENT_NAME" = "workflow_run"',
    'test "$CONCLUSION" = "success"',
    'test "$TRIGGER_EVENT" = "push"',
    'test "$HEAD_BRANCH" = "main"',
    'test "$WORKFLOW_NAME" = "CI"',
    'test "$WORKFLOW_PATH" = ".github/workflows/ci.yml"',
    'test "$RUN_REPOSITORY" = "$EXPECTED_REPOSITORY"',
    'test "$HEAD_REPOSITORY" = "$EXPECTED_REPOSITORY"',
  ]) {
    if (!trustedRun.includes(expected)) {
      problems.push(`Deploy trusted trigger must preserve ${expected}`);
    }
  }
  if (
    trustedTrigger?.env?.EXPECTED_REPOSITORY !== '${{ github.repository }}' ||
    trustedTrigger?.['continue-on-error'] !== undefined
  ) {
    problems.push(
      'Deploy trusted trigger must validate exact repository identity'
    );
  }
  const checkouts = steps.filter((step) => step?.uses === CHECKOUT);
  const checkout = checkouts[0];
  if (
    checkouts.length !== 1 ||
    checkout?.uses !== CHECKOUT ||
    checkout?.with?.ref !==
      "${{ github.event_name == 'workflow_run' && github.event.workflow_run.head_sha || 'main' }}"
  ) {
    problems.push(
      'Deploy classifier must select the successful workflow head SHA or main for dispatch'
    );
  }
  const verification = steps.find(
    (step) => step?.name === 'Verify trusted checkout'
  );
  const expectedCommands = normalizeCommands(`
    EXPECTED_REF="\${{ github.event_name == 'workflow_run' && github.event.workflow_run.head_sha || 'main' }}"
    if [ "$EXPECTED_REF" = "main" ]; then
      EXPECTED_SHA="$(git rev-parse main)"
    else
      EXPECTED_SHA="$EXPECTED_REF"
    fi
    test "$(git rev-parse HEAD)" = "$EXPECTED_SHA"
    git fetch origin main
    git merge-base --is-ancestor "$EXPECTED_SHA" origin/main
  `);
  if (
    verification?.name !== 'Verify trusted checkout' ||
    !sameObject(Object.keys(verification ?? {}).sort(), ['name', 'run']) ||
    !sameObject(normalizeCommands(stepRun(verification)), expectedCommands)
  ) {
    problems.push(
      'Deploy classifier must use the exact fail-closed checkout verification step'
    );
  }

  const classify = steps.find(
    (step) => step?.name === 'Classify D1 and root Worker impact'
  );
  const classifyRun = stepRun(classify);
  if (
    classify?.id !== 'classify' ||
    !classifyRun.includes('scripts/deploy-impact.mjs') ||
    !classifyRun.includes('--manual') ||
    !classifyRun.includes('--base "${{ steps.baseline.outputs.base_sha }}"') ||
    !classifyRun.includes('--head "$HEAD_SHA"') ||
    !classifyRun.includes('--output "$GITHUB_OUTPUT"') ||
    classifyRun.includes('HEAD_SHA^')
  ) {
    problems.push(
      'Deploy classifier must preserve manual-full and exact base/head semantics'
    );
  }

  const download = steps.find(
    (step) => step?.name === 'Download exact triggering-run range'
  );
  const expectedDownload = {
    pattern:
      'deploy-range-${{ github.event.workflow_run.id }}-${{ github.event.workflow_run.run_attempt }}',
    path: '.deploy-range',
    'merge-multiple': false,
    'github-token': '${{ github.token }}',
    repository: '${{ github.repository }}',
    'run-id': '${{ github.event.workflow_run.id }}',
    'digest-mismatch': 'error',
  };
  if (
    download?.uses !== DOWNLOAD_ARTIFACT ||
    download?.if !== "github.event_name == 'workflow_run'" ||
    !sameObject(download?.with, expectedDownload) ||
    download?.['continue-on-error'] !== undefined
  ) {
    problems.push(
      'Deploy must fail closed while downloading only the exact triggering-run artifact'
    );
  }
  const validateRange = steps.find(
    (step) => step?.name === 'Validate untrusted triggering-run range'
  );
  const validateRun = stepRun(validateRange);
  if (
    validateRange?.if !== "github.event_name == 'workflow_run'" ||
    validateRange?.id !== 'range' ||
    !validateRun.includes('scripts/deploy-range.mjs validate') ||
    !validateRun.includes('--expected-repository "${{ github.repository }}"') ||
    !validateRun.includes('--expected-workflow "CI"') ||
    !validateRun.includes('--expected-event "push"') ||
    !validateRun.includes('--expected-ref "refs/heads/main"') ||
    !validateRun.includes(
      '--expected-head "${{ github.event.workflow_run.head_sha }}"'
    ) ||
    !validateRun.includes(
      '--expected-run-id "${{ github.event.workflow_run.id }}"'
    ) ||
    !validateRun.includes(
      '--expected-run-attempt "${{ github.event.workflow_run.run_attempt }}"'
    ) ||
    !validateRun.includes('--output "$GITHUB_OUTPUT"') ||
    validateRange?.['continue-on-error'] !== undefined
  ) {
    problems.push(
      'Deploy must fail closed while validating the untrusted artifact schema and identity'
    );
  }
  if (JSON.stringify(impact ?? {}).includes('CLOUDFLARE_API_TOKEN')) {
    problems.push(
      'Deploy impact classifier must not receive Cloudflare secrets'
    );
  }

  const expectedConditions = {
    'apply-d1-migrations': `
      needs.impact.result == 'success' &&
      needs.impact.outputs.d1_migrations == 'true'
    `,
    'd1-no-impact': `
      needs.impact.result == 'success' &&
      needs.impact.outputs.d1_migrations == 'false'
    `,
    'deploy-root-worker': `
      always() &&
      needs.impact.result == 'success' &&
      (needs.apply-d1-migrations.result == 'success' ||
      needs.d1-no-impact.result == 'success') &&
      needs.impact.outputs.root_worker == 'true'
    `,
    'root-worker-no-impact': `
      needs.impact.result == 'success' &&
      needs.impact.outputs.root_worker == 'false'
    `,
  };
  for (const [jobId, expected] of Object.entries(expectedConditions)) {
    if (
      normalizeExpression(document.jobs?.[jobId]?.if) !==
      normalizeExpression(expected)
    ) {
      problems.push(`${jobId} must use its exact fail-closed impact condition`);
    }
  }
  if (
    !sameObject(document.jobs?.['deploy-root-worker']?.needs, [
      'impact',
      'apply-d1-migrations',
      'd1-no-impact',
    ])
  ) {
    problems.push(
      'Root Worker deployment must wait for the D1 impact path to finalize'
    );
  }
  if (
    !sameObject(document.jobs?.['deploy-root-worker']?.environment, {
      name: 'Production',
      url: 'https://api.rewind.rest',
    })
  ) {
    problems.push('Root Worker deployments must target Production');
  }

  for (const jobId of ['apply-d1-migrations', 'deploy-root-worker']) {
    validateExactHeadCheckout(
      document.jobs?.[jobId],
      '${{ needs.impact.outputs.head_sha }}',
      `Deploy ${jobId}`,
      problems
    );
  }

  const remoteMigrationJobs = expectedJobIds.filter((jobId) =>
    serializedJob(document, jobId).includes(
      'wrangler d1 migrations apply rewind-db --remote'
    )
  );
  if (!sameObject(remoteMigrationJobs, ['apply-d1-migrations'])) {
    problems.push(
      'Remote D1 apply must exist only in the migration-impact job'
    );
  }
  const rootDeployJobs = expectedJobIds.filter((jobId) =>
    serializedJob(document, jobId).includes('npm exec -- wrangler deploy')
  );
  if (!sameObject(rootDeployJobs, ['deploy-root-worker'])) {
    problems.push('Root Worker deploy must exist only in its impact job');
  }

  for (const jobId of ['d1-no-impact', 'root-worker-no-impact']) {
    const serialized = serializedJob(document, jobId);
    if (
      !serialized.includes('no production impact') ||
      serialized.includes('CLOUDFLARE_API_TOKEN') ||
      serialized.includes('wrangler d1 migrations apply') ||
      serialized.includes('wrangler deploy')
    ) {
      problems.push(`${jobId} must be an explicit secret-free no-op`);
    }
  }
  validateCheckpointFlow(
    document,
    {
      label: 'Deploy',
      workflow: 'Deploy',
      workflowFile: 'deploy.yml',
      workflowPath: '.github/workflows/deploy.yml',
      events: 'workflow_run,workflow_dispatch',
      finalizerNeeds: [
        'impact',
        'apply-d1-migrations',
        'd1-no-impact',
        'deploy-root-worker',
        'root-worker-no-impact',
      ],
      finalizerCondition: `
        always() &&
        needs.impact.result == 'success' &&
        (needs.apply-d1-migrations.result == 'success' ||
        needs.d1-no-impact.result == 'success') &&
        (needs.deploy-root-worker.result == 'success' ||
        needs.root-worker-no-impact.result == 'success')
      `,
    },
    problems
  );
}

function validateMcpDeploy(document, problems) {
  const triggerPaths = [
    'mcp-server/**',
    'docs-mintlify/**',
    '.github/workflows/mcp-server.yml',
    'scripts/deploy-impact.mjs',
    'scripts/deploy-impact.test.mjs',
    'scripts/deploy-checkpoint.mjs',
    'scripts/deploy-checkpoint.test.mjs',
  ];
  if (
    !sameObject(document.on?.push?.paths, triggerPaths) ||
    !sameObject(document.on?.pull_request?.paths, triggerPaths)
  ) {
    problems.push(
      'MCP workflow must evaluate its own workflow and impact-guard changes'
    );
  }
  if (!sameObject(document.on?.push?.tags, ['v*'])) {
    problems.push('MCP releases must use repository-level v* tags');
  }
  if (
    document.concurrency?.group !== 'mcp-server-${{ github.ref }}' ||
    document.concurrency?.['cancel-in-progress'] !==
      "${{ github.event_name == 'pull_request' }}"
  ) {
    problems.push(
      'MCP main runs must be non-cancelling while PR runs may cancel'
    );
  }
  const impact = document.jobs?.impact;
  validateExactHeadCheckout(
    impact,
    '${{ github.event.pull_request.head.sha || github.sha }}',
    'MCP classifier',
    problems
  );
  const classifyRun = (impact?.steps ?? []).map(stepRun).join('\n');
  if (
    !classifyRun.includes('scripts/deploy-impact.mjs') ||
    !classifyRun.includes('--release') ||
    !classifyRun.includes('refs/tags/v*') ||
    !classifyRun.includes('--merge-base') ||
    !classifyRun.includes('${{ github.event.pull_request.base.sha }}') ||
    !classifyRun.includes('${{ steps.baseline.outputs.base_sha }}') ||
    !classifyRun.includes('--output "$GITHUB_OUTPUT"')
  ) {
    problems.push(
      'MCP classifier must fail closed across tag, PR, and push events'
    );
  }

  for (const jobId of ['build', 'publish-npm', 'deploy-worker']) {
    validateExactHeadCheckout(
      document.jobs?.[jobId],
      '${{ needs.impact.outputs.head_sha }}',
      `MCP ${jobId}`,
      problems
    );
  }
  if (!sameObject(document.jobs?.build?.needs, 'impact')) {
    problems.push('MCP build must wait for exact-head classification');
  }
  const buildRuns = (document.jobs?.build?.steps ?? []).map(stepRun);
  const freshnessIndex = buildRuns.indexOf('npm run check:web');
  const buildWebIndex = buildRuns.indexOf('npm run build:web');
  if (
    freshnessIndex === -1 ||
    buildWebIndex === -1 ||
    freshnessIndex >= buildWebIndex
  ) {
    problems.push(
      'MCP build must fail closed on stale committed UI bundles before rebuilding'
    );
  }
  if (!sameObject(document.jobs?.['publish-npm']?.needs, ['impact', 'build'])) {
    problems.push('MCP publish must retain classification and build gates');
  }
  if (
    !sameObject(document.jobs?.['deploy-worker']?.needs, ['impact', 'build'])
  ) {
    problems.push('MCP deploy must retain classification and build gates');
  }
  if (
    !sameObject(document.jobs?.['deploy-worker']?.environment, {
      name: 'Production',
      url: 'https://mcp.rewind.rest',
    })
  ) {
    problems.push('MCP Worker deployments must target Production');
  }

  const expectedDeployCondition = `
    needs.impact.result == 'success' &&
    needs.build.result == 'success' &&
    (startsWith(github.ref, 'refs/tags/v') ||
    (github.ref == 'refs/heads/main' &&
    needs.impact.outputs.mcp_worker == 'true'))
  `;
  if (
    normalizeExpression(document.jobs?.['deploy-worker']?.if) !==
    normalizeExpression(expectedDeployCondition)
  ) {
    problems.push('MCP Worker deployment must be tag-or-classified-main-only');
  }
  const expectedNoImpactCondition = `
    needs.impact.result == 'success' &&
    needs.build.result == 'success' &&
    github.ref == 'refs/heads/main' &&
    needs.impact.outputs.mcp_worker == 'false'
  `;
  if (
    normalizeExpression(document.jobs?.['mcp-worker-no-impact']?.if) !==
    normalizeExpression(expectedNoImpactCondition)
  ) {
    problems.push('MCP no-impact job must be classified-main-only');
  }
  const noImpact = serializedJob(document, 'mcp-worker-no-impact');
  if (
    !noImpact.includes('no production impact') ||
    noImpact.includes('CLOUDFLARE_API_TOKEN') ||
    noImpact.includes('wrangler deploy')
  ) {
    problems.push('MCP no-impact job must be an explicit secret-free no-op');
  }
  validateCheckpointFlow(
    document,
    {
      label: 'MCP',
      workflow: 'MCP Server',
      workflowFile: 'mcp-server.yml',
      workflowPath: '.github/workflows/mcp-server.yml',
      events: 'push',
      finalizerNeeds: [
        'impact',
        'build',
        'deploy-worker',
        'mcp-worker-no-impact',
      ],
      finalizerCondition: `
        always() &&
        github.event_name == 'push' &&
        github.ref == 'refs/heads/main' &&
        needs.impact.result == 'success' &&
        needs.build.result == 'success' &&
        (needs.deploy-worker.result == 'success' ||
        needs.mcp-worker-no-impact.result == 'success')
      `,
    },
    problems
  );
}

function validateSecurityExceptionsWorkflow(document, problems) {
  if (
    !sameObject(document.on, {
      schedule: [{ cron: '20 15 * * *' }],
      workflow_dispatch: null,
    })
  ) {
    problems.push(
      'Security exception lifecycle must run daily and on manual dispatch'
    );
  }
  if (!sameObject(Object.keys(document.jobs ?? {}), ['verify'])) {
    problems.push(
      'Security exception lifecycle must contain only the verifier job'
    );
    return;
  }
  const job = document.jobs.verify;
  if (
    job?.name !== 'Verify dismissed alert exceptions' ||
    job?.['runs-on'] !== 'ubuntu-latest' ||
    job?.if !== undefined ||
    job?.['continue-on-error'] !== undefined
  ) {
    problems.push(
      'Security exception verifier must be an exact fail-closed job'
    );
  }
  const steps = job?.steps ?? [];
  const checkout = steps.filter((step) => step?.uses === CHECKOUT);
  const setup = steps.filter((step) => step?.uses === SETUP_NODE);
  const verify = steps.filter(
    (step) => stepRun(step) === 'node scripts/security-exception.mjs'
  );
  if (
    checkout.length !== 1 ||
    checkout[0]?.if !== undefined ||
    setup.length !== 1 ||
    setup[0]?.if !== undefined ||
    setup[0]?.with?.['node-version-file'] !== '.nvmrc' ||
    verify.length !== 1 ||
    verify[0]?.if !== undefined ||
    !sameObject(verify[0]?.env, { GITHUB_TOKEN: '${{ github.token }}' }) ||
    verify[0]?.['continue-on-error'] !== undefined
  ) {
    problems.push(
      'Security exception verifier must use the trusted lockfile, Node contract, and read-only token'
    );
  }
}

function validateActionlintConfig(document, problems) {
  const expected = {
    paths: {
      '.github/workflows/security-exceptions.yml': {
        ignore: ['^unknown permission scope "vulnerability-alerts"'],
      },
    },
  };
  if (!sameObject(document, expected)) {
    problems.push(
      'actionlint may ignore only its exact vulnerability-alerts compatibility false positive'
    );
  }
}

function validateTrustedBoundaries(workflows, sources, problems) {
  const release = workflows.get('release-please.yml');
  if (!release?.on?.push || !sameObject(release.on.push.branches, ['main'])) {
    problems.push('Release Please must be triggered only by pushes to main');
  }
  if (
    !release?.jobs?.['release-please']?.steps?.some(
      (step) => step?.uses === RELEASE_PLEASE
    )
  ) {
    problems.push('Release Please must use the approved immutable Action');
  }
  const mcp = workflows.get('mcp-server.yml');
  if (
    mcp?.jobs?.['publish-npm']?.if !== "startsWith(github.ref, 'refs/tags/v')"
  ) {
    problems.push('npm provenance publishing must remain tag-only');
  }
  const allSources = [...sources.entries()];
  const releaseTokenFiles = allSources.filter(([, source]) =>
    source.includes('RELEASE_PLEASE_TOKEN')
  );
  if (
    releaseTokenFiles.length !== 1 ||
    releaseTokenFiles[0][0] !== 'release-please.yml'
  ) {
    problems.push('RELEASE_PLEASE_TOKEN must occur only in Release Please');
  }
  for (const [name, source] of allSources) {
    if (
      source.includes('CLOUDFLARE_API_TOKEN') &&
      !['deploy.yml', 'mcp-server.yml'].includes(name)
    ) {
      problems.push(`CLOUDFLARE_API_TOKEN is unsafe in ${name}`);
    }
    if (source.includes('id-token: write') && name !== 'mcp-server.yml') {
      problems.push(`id-token: write is unsafe in ${name}`);
    }
  }
  for (const [name, workflow] of workflows) {
    for (const [jobId, job] of Object.entries(workflow?.jobs ?? {})) {
      const serialized = JSON.stringify(job);
      if (
        serialized.includes('CLOUDFLARE_API_TOKEN') &&
        !(
          (name === 'deploy.yml' &&
            ['apply-d1-migrations', 'deploy-root-worker'].includes(jobId)) ||
          (name === 'mcp-server.yml' && jobId === 'deploy-worker')
        )
      ) {
        problems.push(`CLOUDFLARE_API_TOKEN is unsafe in ${name}:${jobId}`);
      }
      if (
        permissionMap(job?.permissions)?.['id-token'] === 'write' &&
        !(name === 'mcp-server.yml' && jobId === 'publish-npm')
      ) {
        problems.push(`id-token: write is unsafe in ${name}:${jobId}`);
      }
      if (
        serialized.includes('RELEASE_PLEASE_TOKEN') &&
        !(name === 'release-please.yml' && jobId === 'release-please')
      ) {
        problems.push(`RELEASE_PLEASE_TOKEN is unsafe in ${name}:${jobId}`);
      }
    }
  }
  const publishPermissions = mcp?.jobs?.['publish-npm']?.permissions;
  if (
    !sameObject(publishPermissions, { contents: 'read', 'id-token': 'write' })
  ) {
    problems.push('id-token: write must be isolated to the npm publish job');
  }
}

function validatePackages(rootPackage, mcpPackage, problems) {
  if (
    !sameObject(rootPackage.engines, {
      node: '>=24.19.0 <25',
      npm: '11.5.2',
    })
  ) {
    problems.push('root engines must pin Node 24.19 and npm 11.5.2');
  }
  if (rootPackage.packageManager !== 'npm@11.5.2')
    problems.push('root packageManager must pin npm 11.5.2');
  if (rootPackage.devDependencies?.['claude-code-lint'] !== '0.7.0') {
    problems.push('claude-code-lint must be exact 0.7.0');
  }
  if (rootPackage.dependencies?.yaml !== '2.9.0')
    problems.push('yaml must be exact 2.9.0');
  if (rootPackage.devDependencies?.mint !== '4.2.802')
    problems.push('mint must be exact 4.2.802');
  if (rootPackage.devDependencies?.tsx !== '4.23.1')
    problems.push('tsx must be direct and exact 4.23.1');
  if (
    !sameObject(rootPackage.overrides, {
      '@esbuild-kit/core-utils': { esbuild: '0.25.12' },
      '@mintlify/prebuild': { sharp: '0.35.3' },
      favicons: { sharp: '0.35.3' },
      qs: '6.15.3',
      undici: '7.29.0',
      ws: '8.21.3',
    })
  ) {
    problems.push('root security overrides must stay exact and complete');
  }
  if (rootPackage.scripts?.['lint:claude'] !== 'claudelint') {
    problems.push('lint:claude must invoke the local binary');
  }
  if (
    rootPackage.scripts?.['test:automation-policy'] !==
    'node --test scripts/automation-policy.test.mjs scripts/deploy-checkpoint.test.mjs scripts/deploy-impact.test.mjs scripts/deploy-range.test.mjs'
  ) {
    problems.push(
      'test:automation-policy must invoke the zero-network Node suite'
    );
  }
  if (mcpPackage.packageManager !== 'npm@11.5.2')
    problems.push('MCP packageManager must pin npm 11.5.2');
  if (mcpPackage.engines?.node !== '>=22.0.0')
    problems.push('MCP engines must preserve the supported Node 22 floor');
}

function validateReleasePleaseConfig(document, problems) {
  const expected = {
    packages: {
      'mcp-server': {
        'release-type': 'node',
        component: 'mcp-server',
        'include-component-in-tag': false,
        'include-v-in-tag': true,
        'include-v-in-release-name': true,
        'changelog-path': 'CHANGELOG.md',
      },
    },
  };
  if (!sameObject(document, expected)) {
    problems.push('Release Please must publish repository-level v* releases');
  }
}

function validateDependabot(document, problems) {
  const updates = document?.updates ?? [];
  const get = (ecosystem, directory) =>
    updates.find(
      (entry) =>
        entry?.['package-ecosystem'] === ecosystem &&
        entry?.directory === directory
    );
  const expected = [
    ['npm', '/', '07:00', 'root npm'],
    ['npm', '/mcp-server', '07:10', 'MCP npm'],
    ['npm', '/docs-site', '07:20', 'docs-site npm'],
    ['npm', '/apex-worker', '07:30', 'Apex npm'],
    ['github-actions', '/', '07:40', 'Actions'],
  ];
  if (
    updates.length !== expected.length ||
    expected.some(([ecosystem, directory]) => !get(ecosystem, directory))
  ) {
    problems.push('Dependabot must cover exactly four npm roots and Actions');
    return;
  }
  for (const [ecosystem, directory, time, label] of expected) {
    validateSchedule(get(ecosystem, directory), time, 0, label, problems);
  }
}

function validateRenovate(document, problems) {
  if (
    document?.enabled !== true ||
    !sameObject(document?.extends, ['config:recommended']) ||
    !sameObject(document?.enabledManagers, ['npm', 'github-actions']) ||
    document?.timezone !== 'America/Los_Angeles'
  ) {
    problems.push('Renovate must use the approved active manager boundary');
  }
  if (
    document?.dependencyDashboard !== true ||
    document?.dependencyDashboardAutoclose !== true ||
    !sameObject(document?.labels, ['dependencies']) ||
    document?.branchConcurrentLimit !== 2 ||
    document?.prConcurrentLimit !== 2 ||
    document?.prHourlyLimit !== 1
  ) {
    problems.push('Renovate must preserve the bounded dashboard and queue');
  }
  if (
    document?.rebaseWhen !== 'behind-base-branch' ||
    document?.platformAutomerge !== true ||
    document?.automergeType !== 'pr' ||
    document?.automergeStrategy !== 'squash' ||
    document?.internalChecksFilter !== 'strict'
  ) {
    problems.push('Renovate must use strict GitHub-native PR automerge');
  }
  if (
    document?.vulnerabilityAlerts?.enabled !== false ||
    document?.lockFileMaintenance?.enabled !== false
  ) {
    problems.push(
      'Renovate must not own security alerts or broad lock refresh'
    );
  }

  const rules = document?.packageRules ?? [];
  const byDescription = new Map(rules.map((rule) => [rule.description, rule]));
  const expectedDescriptions = [
    'Default every dependency surface to dashboard approval',
    'Root stable runtime patches',
    'MCP stable runtime patches',
    'Root and MCP stable development non-major updates',
    'Root security overrides require exception handling',
    'Exact automation contracts require exception handling',
    'Pre-1.0 minor updates require exception handling',
    'All major updates require exception handling',
    'Pin, digest, and lockfile updates require exception handling',
  ];
  if (
    rules.length !== expectedDescriptions.length ||
    expectedDescriptions.some((description) => !byDescription.has(description))
  ) {
    problems.push('Renovate package-rule set must remain exact');
    return;
  }

  const expectedRules = [
    {
      description: 'Default every dependency surface to dashboard approval',
      matchManagers: ['npm', 'github-actions'],
      dependencyDashboardApproval: true,
      automerge: false,
    },
    {
      description: 'Root stable runtime patches',
      matchManagers: ['npm'],
      matchFileNames: ['package.json'],
      matchDepTypes: ['dependencies', 'optionalDependencies'],
      matchCurrentVersion: STABLE_SEMVER_CURRENT_VERSION,
      matchUpdateTypes: ['patch'],
      minimumReleaseAge: '14 days',
      dependencyDashboardApproval: false,
      automerge: true,
    },
    {
      description: 'MCP stable runtime patches',
      matchManagers: ['npm'],
      matchFileNames: ['mcp-server/package.json'],
      matchDepTypes: ['dependencies', 'optionalDependencies'],
      matchCurrentVersion: STABLE_SEMVER_CURRENT_VERSION,
      matchUpdateTypes: ['patch'],
      minimumReleaseAge: '14 days',
      dependencyDashboardApproval: false,
      automerge: true,
    },
    {
      description: 'Root and MCP stable development non-major updates',
      matchManagers: ['npm'],
      matchFileNames: ['package.json', 'mcp-server/package.json'],
      matchDepTypes: ['devDependencies'],
      matchCurrentVersion: STABLE_SEMVER_CURRENT_VERSION,
      matchUpdateTypes: ['patch', 'minor'],
      minimumReleaseAge: '14 days',
      dependencyDashboardApproval: false,
      automerge: true,
    },
    {
      description: 'Root security overrides require exception handling',
      matchManagers: ['npm'],
      matchFileNames: ['package.json'],
      matchDepTypes: ['overrides'],
      dependencyDashboardApproval: true,
      automerge: false,
    },
    {
      description: 'Exact automation contracts require exception handling',
      matchManagers: ['npm'],
      matchFileNames: ['package.json'],
      matchPackageNames: ['claude-code-lint', 'mint', 'tsx', 'yaml'],
      dependencyDashboardApproval: true,
      automerge: false,
    },
    {
      description: 'Pre-1.0 minor updates require exception handling',
      matchCurrentVersion: '/^0\\./',
      matchUpdateTypes: ['minor', 'major'],
      dependencyDashboardApproval: true,
      automerge: false,
    },
    {
      description: 'All major updates require exception handling',
      matchUpdateTypes: ['major'],
      dependencyDashboardApproval: true,
      automerge: false,
    },
    {
      description:
        'Pin, digest, and lockfile updates require exception handling',
      matchUpdateTypes: ['digest', 'pin', 'pinDigest', 'lockFileMaintenance'],
      dependencyDashboardApproval: true,
      automerge: false,
    },
  ];
  if (!sameObject(rules, expectedRules)) {
    problems.push('Renovate package-rule definitions must remain exact');
  }

  const defaultRule = byDescription.get(expectedDescriptions[0]);
  if (
    !sameObject(defaultRule?.matchManagers, ['npm', 'github-actions']) ||
    defaultRule?.dependencyDashboardApproval !== true ||
    defaultRule?.automerge !== false
  ) {
    problems.push('Renovate must default every surface to manual approval');
  }

  const stableRuntimeTypes = ['patch'];
  for (const [description, file] of [
    ['Root stable runtime patches', 'package.json'],
    ['MCP stable runtime patches', 'mcp-server/package.json'],
  ]) {
    const rule = byDescription.get(description);
    if (
      !sameObject(rule?.matchManagers, ['npm']) ||
      !sameObject(rule?.matchFileNames, [file]) ||
      !sameObject(rule?.matchDepTypes, [
        'dependencies',
        'optionalDependencies',
      ]) ||
      rule?.matchCurrentVersion !== STABLE_SEMVER_CURRENT_VERSION ||
      !sameObject(rule?.matchUpdateTypes, stableRuntimeTypes) ||
      rule?.minimumReleaseAge !== '14 days' ||
      rule?.dependencyDashboardApproval !== false ||
      rule?.automerge !== true
    ) {
      problems.push(`${description} must stay patch-only and critical-tier`);
    }
  }

  const development = byDescription.get(
    'Root and MCP stable development non-major updates'
  );
  if (
    !sameObject(development?.matchManagers, ['npm']) ||
    !sameObject(development?.matchFileNames, [
      'package.json',
      'mcp-server/package.json',
    ]) ||
    !sameObject(development?.matchDepTypes, ['devDependencies']) ||
    development?.matchCurrentVersion !== STABLE_SEMVER_CURRENT_VERSION ||
    !sameObject(development?.matchUpdateTypes, ['patch', 'minor']) ||
    development?.minimumReleaseAge !== '14 days' ||
    development?.dependencyDashboardApproval !== false ||
    development?.automerge !== true
  ) {
    problems.push('root and MCP development updates must stay bounded');
  }

  const overrides = byDescription.get(
    'Root security overrides require exception handling'
  );
  if (
    !sameObject(overrides?.matchManagers, ['npm']) ||
    !sameObject(overrides?.matchFileNames, ['package.json']) ||
    !sameObject(overrides?.matchDepTypes, ['overrides']) ||
    overrides?.dependencyDashboardApproval !== true ||
    overrides?.automerge !== false
  ) {
    problems.push('root security overrides must require exception handling');
  }

  const exactContracts = byDescription.get(
    'Exact automation contracts require exception handling'
  );
  if (
    !sameObject(exactContracts?.matchManagers, ['npm']) ||
    !sameObject(exactContracts?.matchFileNames, ['package.json']) ||
    !sameObject(exactContracts?.matchPackageNames, [
      'claude-code-lint',
      'mint',
      'tsx',
      'yaml',
    ]) ||
    exactContracts?.dependencyDashboardApproval !== true ||
    exactContracts?.automerge !== false
  ) {
    problems.push('exact automation contracts must require exception handling');
  }

  const preOne = byDescription.get(
    'Pre-1.0 minor updates require exception handling'
  );
  if (
    preOne?.matchCurrentVersion !== '/^0\\./' ||
    !sameObject(preOne?.matchUpdateTypes, ['minor', 'major']) ||
    preOne?.dependencyDashboardApproval !== true ||
    preOne?.automerge !== false
  ) {
    problems.push('pre-1.0 minor updates must require exception handling');
  }
  const majors = byDescription.get(
    'All major updates require exception handling'
  );
  if (
    !sameObject(majors?.matchUpdateTypes, ['major']) ||
    majors?.dependencyDashboardApproval !== true ||
    majors?.automerge !== false
  ) {
    problems.push('all major updates must require exception handling');
  }

  const unsafeTypes = ['digest', 'pin', 'pinDigest', 'lockFileMaintenance'];
  const unsafeGate = byDescription.get(
    'Pin, digest, and lockfile updates require exception handling'
  );
  if (
    unsafeGate !== rules.at(-1) ||
    !sameObject(Object.keys(unsafeGate ?? {}).sort(), [
      'automerge',
      'dependencyDashboardApproval',
      'description',
      'matchUpdateTypes',
    ]) ||
    !sameObject(unsafeGate?.matchUpdateTypes, unsafeTypes) ||
    unsafeGate?.dependencyDashboardApproval !== true ||
    unsafeGate?.automerge !== false
  ) {
    problems.push(
      'pin, digest, and lockfile updates must end in an unconstrained manual gate'
    );
  }
  for (const rule of rules.filter(
    (candidate) => candidate?.automerge === true
  )) {
    const updateTypes = rule.matchUpdateTypes ?? [];
    if (
      updateTypes.length === 0 ||
      updateTypes.some(
        (updateType) => !['patch', 'minor'].includes(updateType)
      ) ||
      rule.minimumReleaseAge !== '14 days'
    ) {
      problems.push(
        'Renovate automerge must remain patch/minor-only with a 14-day age'
      );
    }
  }
}

function validateSchedule(entry, time, limit, label, problems) {
  const expected = {
    interval: 'weekly',
    day: 'monday',
    time,
    timezone: 'America/Los_Angeles',
  };
  if (!sameObject(entry?.schedule, expected))
    problems.push(`${label} schedule must be ${time} Pacific Monday`);
  if (entry?.['open-pull-requests-limit'] !== limit)
    problems.push(`${label} queue limit must be ${limit}`);
}

function validateRepository(root) {
  const problems = [];
  const workflowDir = join(root, '.github', 'workflows');
  const names = readdirSync(workflowDir)
    .filter((name) => /\.ya?ml$/.test(name))
    .sort();
  const expectedNames = [
    'ci.yml',
    'deploy.yml',
    'mcp-server.yml',
    'pr-lint.yml',
    'release-please.yml',
    'security-exceptions.yml',
  ];
  if (!sameObject(names, expectedNames)) {
    problems.push(`workflow set must be exactly ${expectedNames.join(', ')}`);
  }
  const workflows = new Map();
  const sources = new Map();
  for (const name of names) {
    const source = readFileSync(join(workflowDir, name), 'utf8');
    const document = parseYaml(source, name);
    workflows.set(name, document);
    sources.set(name, source);
    validatePermissions(name, document, problems);
    for (const { value: use } of collectValues(document, 'uses'))
      validateActionUse(use, problems);
    for (const { value: run } of collectValues(document, 'run'))
      validateRun(run, problems);
    validateActionComments(source, problems);
    validateInstallOrdering(name, document, problems);
  }
  validateCi(workflows.get('ci.yml') ?? {}, problems);
  validateDeploy(workflows.get('deploy.yml') ?? {}, problems);
  validateMcpDeploy(workflows.get('mcp-server.yml') ?? {}, problems);
  validateSecurityExceptionsWorkflow(
    workflows.get('security-exceptions.yml') ?? {},
    problems
  );
  validateActionlintConfig(
    parseYaml(
      readFileSync(join(root, '.github', 'actionlint.yaml'), 'utf8'),
      'actionlint.yaml'
    ),
    problems
  );
  validateTrustedBoundaries(workflows, sources, problems);
  validatePackages(
    JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')),
    JSON.parse(readFileSync(join(root, 'mcp-server', 'package.json'), 'utf8')),
    problems
  );
  validateReleasePleaseConfig(
    JSON.parse(readFileSync(join(root, 'release-please-config.json'), 'utf8')),
    problems
  );
  validateDependabot(
    parseYaml(
      readFileSync(join(root, '.github', 'dependabot.yml'), 'utf8'),
      'dependabot.yml'
    ),
    problems
  );
  validateRenovate(
    JSON.parse(readFileSync(join(root, 'renovate.json'), 'utf8')),
    problems
  );
  return problems;
}

test('repository automation satisfies the fail-closed contract', () => {
  assert.deepEqual(validateRepository(ROOT), []);
});

function securityExceptionFixture() {
  return {
    registry: JSON.parse(
      readFileSync(join(ROOT, '.github', 'security-exceptions.json'), 'utf8')
    ),
    lockfile: JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')),
  };
}

function validReviewNow(fixture) {
  const exception = fixture.registry.exceptions[0];
  return new Date(
    Math.min(
      Date.parse(exception.reviewedAt) + 60 * 60 * 1000,
      Date.parse(exception.expiresAt) - 1
    )
  );
}

function liveExceptionFetch({
  patched = false,
  newer = false,
  newerWithBuild = false,
  wrongIdentity = false,
  unregistered = false,
  reopened = false,
  metadataDrift = false,
  malformedRegistry = false,
  paginated = false,
  hostilePagination = false,
} = {}) {
  const exception = securityExceptionFixture().registry.exceptions[0];
  return async (url) => {
    if (url.includes('/dependabot/alerts?')) {
      const nextPage = url.includes('after=');
      const alert = {
        number: exception.alertNumber,
        state: 'dismissed',
        dependency: {
          package: exception.package,
          manifest_path: exception.manifestPath,
          scope: metadataDrift ? 'runtime' : exception.scope,
          relationship: exception.relationship,
        },
        security_advisory: {
          ghsa_id: exception.advisory.ghsa,
          cve_id: exception.advisory.cve,
        },
        security_vulnerability: {
          package: exception.package,
          vulnerable_version_range: exception.advisory.vulnerableVersionRange,
          first_patched_version: null,
        },
        dismissed_at: exception.dismissedAt,
        dismissed_by: { login: exception.owner },
        dismissed_reason: exception.dismissalReason,
        dismissed_comment: exception.reason,
        fixed_at: null,
        auto_dismissed_at: null,
      };
      return {
        ok: true,
        status: 200,
        headers: new Headers(
          paginated && !nextPage
            ? {
                link: `<https://api.github.com/${
                  hostilePagination
                    ? 'repos/example/other'
                    : 'repositories/1178236034'
                }/dependabot/alerts?state=dismissed&per_page=100&after=cursor>; rel="next"`,
              }
            : {}
        ),
        async json() {
          return [
            ...(nextPage || reopened ? [] : [alert]),
            ...(nextPage || !unregistered ? [] : [{ ...alert, number: 999 }]),
          ];
        },
      };
    }
    if (url.includes('api.github.com/advisories/')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            ghsa_id: 'GHSA-jmr9-qjv8-65gv',
            cve_id: wrongIdentity ? 'CVE-2026-00000' : 'CVE-2026-56876',
            withdrawn_at: null,
            vulnerabilities: [
              {
                package: { ecosystem: 'npm', name: 'extract-zip' },
                vulnerable_version_range: '<= 2.0.1',
                first_patched_version: patched ? { identifier: '2.0.2' } : null,
              },
            ],
          };
        },
      };
    }
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          ...(malformedRegistry
            ? {}
            : {
                versions: newer
                  ? { '2.0.1': {}, '2.0.2': {} }
                  : newerWithBuild
                    ? { '2.0.1': {}, '2.0.2+patched': {} }
                    : { '2.0.1': {} },
              }),
        };
      },
    };
  };
}

test('registered security exception is exact, current, and development-only', () => {
  const fixture = securityExceptionFixture();
  assert.deepEqual(
    fixture.registry.exceptions.map((exception) => exception.alertNumber),
    [210]
  );
  assert.deepEqual(
    {
      owner: fixture.registry.exceptions[0].owner,
      dismissalReason: fixture.registry.exceptions[0].dismissalReason,
      ghsa: fixture.registry.exceptions[0].advisory.ghsa,
      cve: fixture.registry.exceptions[0].advisory.cve,
      scope: fixture.registry.exceptions[0].scope,
      relationship: fixture.registry.exceptions[0].relationship,
    },
    {
      owner: 'pdugan20',
      dismissalReason: 'tolerable_risk',
      ghsa: 'GHSA-jmr9-qjv8-65gv',
      cve: 'CVE-2026-56876',
      scope: 'development',
      relationship: 'transitive',
    }
  );
  assert.deepEqual(
    validateSecurityExceptionRegistry({
      ...fixture,
      now: validReviewNow(fixture),
    }),
    []
  );
});

test('security exception lifecycle reconciles the exact dismissed alert inventory', async () => {
  const fixture = securityExceptionFixture();
  assert.deepEqual(
    await verifySecurityExceptionLifecycle({
      ...fixture,
      now: validReviewNow(fixture),
      fetchImpl: liveExceptionFetch(),
      token: undefined,
    }),
    []
  );
  assert.deepEqual(
    await verifySecurityExceptionLifecycle({
      ...fixture,
      now: validReviewNow(fixture),
      fetchImpl: liveExceptionFetch({ paginated: true }),
      token: undefined,
    }),
    []
  );

  for (const fetchImpl of [
    liveExceptionFetch({ unregistered: true }),
    liveExceptionFetch({ reopened: true }),
    liveExceptionFetch({ metadataDrift: true }),
  ]) {
    const problems = await verifySecurityExceptionLifecycle({
      ...fixture,
      now: validReviewNow(fixture),
      fetchImpl,
      token: undefined,
    });
    assert.ok(
      problems.some(
        (problem) =>
          problem.includes('inventory must exactly match') ||
          problem.includes('dismissal metadata changed')
      )
    );
  }

  const hostilePaginationProblems = await verifySecurityExceptionLifecycle({
    ...fixture,
    now: validReviewNow(fixture),
    fetchImpl: liveExceptionFetch({
      paginated: true,
      hostilePagination: true,
    }),
    token: undefined,
  });
  assert.ok(
    hostilePaginationProblems.some((problem) =>
      problem.includes('next link left the exact inventory')
    )
  );
});

test('security exception registry has a clean remediated terminal state', async () => {
  const remediated = { schemaVersion: 1, exceptions: [] };
  assert.deepEqual(
    validateSecurityExceptionRegistry({
      registry: remediated,
      lockfile: null,
      now: new Date(),
    }),
    []
  );
  assert.deepEqual(
    await verifySecurityExceptionLifecycle({
      registry: remediated,
      lockfile: null,
      now: new Date(),
      fetchImpl: async (url) => {
        assert.match(url, /\/dependabot\/alerts\?/);
        return {
          ok: true,
          status: 200,
          async json() {
            return [];
          },
        };
      },
      token: undefined,
    }),
    []
  );
});

test('security exception registry permits a bounded future review renewal', () => {
  const renewed = securityExceptionFixture();
  const priorExpiry = Date.parse(renewed.registry.exceptions[0].expiresAt);
  renewed.registry.exceptions[0].reviewedAt = new Date(
    priorExpiry - 60 * 60 * 1000
  ).toISOString();
  renewed.registry.exceptions[0].expiresAt = new Date(
    priorExpiry + 31 * 24 * 60 * 60 * 1000
  ).toISOString();
  assert.deepEqual(
    validateSecurityExceptionRegistry({
      ...renewed,
      now: validReviewNow(renewed),
    }),
    []
  );
});

test('security exception checks cannot be conditionally skipped', () => {
  const workflow = parseYaml(
    readFileSync(
      join(ROOT, '.github', 'workflows', 'security-exceptions.yml'),
      'utf8'
    ),
    'security-exceptions.yml'
  );
  workflow.jobs.verify.if = 'false';
  const workflowProblems = [];
  validateSecurityExceptionsWorkflow(workflow, workflowProblems);
  assert.ok(
    workflowProblems.some((problem) => problem.includes('fail-closed'))
  );

  const ci = parseYaml(
    readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8'),
    'ci.yml'
  );
  const exceptionStep = ci.jobs.security.steps.find(
    (step) => stepRun(step) === 'node scripts/security-exception.mjs --offline'
  );
  exceptionStep.if = 'false';
  const ciProblems = [];
  validateCi(ci, ciProblems);
  assert.ok(ciProblems.some((problem) => problem.includes('fail closed')));
});

test('actionlint compatibility ignore cannot broaden', () => {
  const config = parseYaml(
    readFileSync(join(ROOT, '.github', 'actionlint.yaml'), 'utf8'),
    'actionlint.yaml'
  );
  config.paths['.github/workflows/security-exceptions.yml'].ignore.push('.*');
  const problems = [];
  validateActionlintConfig(config, problems);
  assert.ok(
    problems.some((problem) => problem.includes('compatibility false positive'))
  );
});

test('security exception lifecycle fails on expiry or dependency-scope drift', () => {
  const expired = securityExceptionFixture();
  assert.ok(
    validateSecurityExceptionRegistry({
      ...expired,
      now: new Date(expired.registry.exceptions[0].expiresAt),
    }).some((problem) => problem.includes('expired'))
  );

  const overlong = securityExceptionFixture();
  overlong.registry.exceptions[0].expiresAt = new Date(
    Date.parse(overlong.registry.exceptions[0].reviewedAt) +
      33 * 24 * 60 * 60 * 1000
  ).toISOString();
  assert.ok(
    validateSecurityExceptionRegistry({
      ...overlong,
      now: validReviewNow(overlong),
    }).some((problem) => problem.includes('within 32 days'))
  );

  const runtime = securityExceptionFixture();
  runtime.lockfile.packages['node_modules/extract-zip'].dev = false;
  assert.ok(
    validateSecurityExceptionRegistry({
      ...runtime,
      now: validReviewNow(runtime),
    }).some((problem) => problem.includes('development'))
  );

  const moved = securityExceptionFixture();
  delete moved.lockfile.packages['node_modules/@mintlify/link-rot']
    .dependencies['@mintlify/scraping'];
  assert.ok(
    validateSecurityExceptionRegistry({
      ...moved,
      now: validReviewNow(moved),
    }).some((problem) => problem.includes('edge'))
  );
});

test('security exception lifecycle fails when a patch appears', async () => {
  for (const fetchImpl of [
    liveExceptionFetch({ patched: true }),
    liveExceptionFetch({ newer: true }),
    liveExceptionFetch({ newerWithBuild: true }),
  ]) {
    const problems = await verifySecurityExceptionLifecycle({
      ...securityExceptionFixture(),
      now: validReviewNow(securityExceptionFixture()),
      fetchImpl,
      token: undefined,
    });
    assert.ok(
      problems.some(
        (problem) =>
          problem.includes('patched version') || problem.includes('newer')
      )
    );
  }
});

test('security exception lifecycle fails when advisory identity changes', async () => {
  const fixture = securityExceptionFixture();
  const problems = await verifySecurityExceptionLifecycle({
    ...fixture,
    now: validReviewNow(fixture),
    fetchImpl: liveExceptionFetch({ wrongIdentity: true }),
    token: undefined,
  });
  assert.ok(problems.some((problem) => problem.includes('identity or status')));
});

test('security exception lifecycle fails closed on advisory lookup errors', async () => {
  const fixture = securityExceptionFixture();
  const problems = await verifySecurityExceptionLifecycle({
    ...fixture,
    now: validReviewNow(fixture),
    fetchImpl: async () => {
      throw new Error('offline');
    },
    token: undefined,
  });
  assert.ok(
    problems.some((problem) => problem.includes('failed closed: offline'))
  );

  const malformedRegistryProblems = await verifySecurityExceptionLifecycle({
    ...fixture,
    now: validReviewNow(fixture),
    fetchImpl: liveExceptionFetch({ malformedRegistry: true }),
    token: undefined,
  });
  assert.ok(
    malformedRegistryProblems.some((problem) =>
      problem.includes('registry metadata no longer contains')
    )
  );
});

test('rejects malformed YAML', () => {
  assert.throws(() => parseYaml('jobs: [', 'bad.yml'), /malformed YAML/);
});

test('discovers and rejects unsafe .yaml workflow files', () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'rewind-automation-policy-'));
  try {
    cpSync(join(ROOT, '.github'), join(fixtureRoot, '.github'), {
      recursive: true,
    });
    mkdirSync(join(fixtureRoot, 'mcp-server'));
    cpSync(join(ROOT, 'package.json'), join(fixtureRoot, 'package.json'));
    cpSync(join(ROOT, 'renovate.json'), join(fixtureRoot, 'renovate.json'));
    cpSync(
      join(ROOT, 'release-please-config.json'),
      join(fixtureRoot, 'release-please-config.json')
    );
    cpSync(
      join(ROOT, 'mcp-server', 'package.json'),
      join(fixtureRoot, 'mcp-server', 'package.json')
    );
    writeFileSync(
      join(fixtureRoot, '.github', 'workflows', 'unsafe.yaml'),
      'name: Unsafe\non: push\npermissions:\n  contents: write\njobs:\n  mutate:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v7\n'
    );
    const problems = validateRepository(fixtureRoot);
    assert.ok(
      problems.some((problem) => problem.includes('actions/checkout@v7'))
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('rejects omitted and write permissions for ordinary CI', () => {
  for (const permissions of [undefined, { contents: 'write' }]) {
    const problems = [];
    validatePermissions('ci.yml', { permissions, jobs: {} }, problems);
    assert.ok(problems.length > 0);
  }
});

test('rejects deploy permissions beyond actions-read and contents-read', () => {
  for (const permissions of [
    { contents: 'read' },
    { actions: 'write', contents: 'read' },
    { actions: 'read', contents: 'read', issues: 'read' },
  ]) {
    const problems = [];
    validatePermissions('deploy.yml', { permissions, jobs: {} }, problems);
    assert.ok(problems.length > 0);
  }
});

test('rejects mutable Actions and pinned merge or approval Actions', () => {
  for (const use of [
    'actions/checkout@v7',
    'someone/auto-merge@1234567890123456789012345678901234567890',
    'someone/approve@1234567890123456789012345678901234567890',
  ]) {
    const problems = [];
    validateActionUse(use, problems);
    assert.ok(problems.length > 0, use);
  }
});

test('rejects Docker action references', () => {
  const problems = [];
  validateActionUse('docker://alpine:latest', problems);
  assert.ok(problems.length > 0);
});

test('rejects merge, approval, REST, GraphQL, and floating-tool commands', () => {
  for (const run of [
    'gh pr merge --auto 42',
    'gh pr review --approve 42',
    'gh api -X PUT repos/o/r/pulls/42/merge',
    'curl -X POST https://api.github.com/graphql',
    'npx mint@latest broken-links',
  ]) {
    const problems = [];
    validateRun(run, problems);
    assert.ok(problems.length > 0, run);
  }
});

test('rejects wrong toolchain setup or ordering', () => {
  const problems = [];
  validateInstallOrdering(
    'ci.yml',
    {
      jobs: {
        lint: {
          steps: [
            { run: 'npm ci' },
            { uses: SETUP_NODE, with: { 'node-version': '22' } },
            { run: 'npm install -g npm@11' },
          ],
        },
      },
    },
    problems
  );
  assert.ok(problems.length > 0);
});

test('rejects dependency security override drift', () => {
  const rootPackage = JSON.parse(
    readFileSync(join(ROOT, 'package.json'), 'utf8')
  );
  const mcpPackage = JSON.parse(
    readFileSync(join(ROOT, 'mcp-server', 'package.json'), 'utf8')
  );
  rootPackage.overrides['@mintlify/prebuild'].sharp = '0.33.5';
  const problems = [];
  validatePackages(rootPackage, mcpPackage, problems);
  assert.ok(
    problems.includes('root security overrides must stay exact and complete')
  );
});

test('rejects component-prefixed release tags', () => {
  const config = JSON.parse(
    readFileSync(join(ROOT, 'release-please-config.json'), 'utf8')
  );
  config.packages['mcp-server']['include-component-in-tag'] = true;
  const problems = [];
  validateReleasePleaseConfig(config, problems);
  assert.ok(problems.some((problem) => problem.includes('v* releases')));
});

test('rejects non-production deployment environments', () => {
  const deploy = parseYaml(
    readFileSync(join(ROOT, '.github', 'workflows', 'deploy.yml'), 'utf8')
  );
  deploy.jobs['deploy-root-worker'].environment.name = 'production-api';
  const deployProblems = [];
  validateDeploy(deploy, deployProblems);
  assert.ok(
    deployProblems.some((problem) => problem.includes('target Production'))
  );

  const mcp = parseYaml(
    readFileSync(join(ROOT, '.github', 'workflows', 'mcp-server.yml'), 'utf8')
  );
  mcp.jobs['deploy-worker'].environment.name = 'production-mcp';
  const mcpProblems = [];
  validateMcpDeploy(mcp, mcpProblems);
  assert.ok(
    mcpProblems.some((problem) => problem.includes('target Production'))
  );
});

test('rejects unsafe credential placement', () => {
  const problems = [];
  validateTrustedBoundaries(
    new Map([
      [
        'release-please.yml',
        {
          on: { push: { branches: ['main'] } },
          jobs: {
            'release-please': { steps: [{ uses: RELEASE_PLEASE }] },
          },
        },
      ],
      [
        'mcp-server.yml',
        {
          jobs: {
            build: {
              env: { CLOUDFLARE_API_TOKEN: 'unsafe' },
              permissions: { 'id-token': 'write' },
            },
            'publish-npm': {
              if: "startsWith(github.ref, 'refs/tags/v')",
              permissions: { contents: 'read', 'id-token': 'write' },
            },
            'deploy-worker': {
              if: "github.ref == 'refs/heads/main' || startsWith(github.ref, 'refs/tags/v')",
            },
          },
        },
      ],
    ]),
    new Map([
      ['release-please.yml', 'RELEASE_PLEASE_TOKEN'],
      ['mcp-server.yml', 'CLOUDFLARE_API_TOKEN\nid-token: write'],
    ]),
    problems
  );
  assert.ok(
    problems.some((problem) => problem.includes('CLOUDFLARE_API_TOKEN'))
  );
  assert.ok(problems.some((problem) => problem.includes('id-token: write')));
});

test('rejects Dependabot routine-version ownership drift', () => {
  const fixture = parseYaml(
    readFileSync(join(ROOT, '.github', 'dependabot.yml'), 'utf8')
  );
  fixture.updates[0]['open-pull-requests-limit'] = 1;
  const problems = [];
  validateDependabot(fixture, problems);
  assert.ok(
    problems.some((problem) => problem.includes('queue limit must be 0'))
  );
});

test('rejects unsafe Renovate routine-merge expansion', () => {
  const fixture = JSON.parse(readFileSync(join(ROOT, 'renovate.json'), 'utf8'));
  for (const rule of fixture.packageRules.filter(
    (candidate) => candidate.automerge === true
  )) {
    rule.matchUpdateTypes.push('digest');
  }
  const problems = [];
  validateRenovate(fixture, problems);
  assert.ok(
    problems.some((problem) =>
      problem.includes('automerge must remain patch/minor-only')
    )
  );
});

test('stable Renovate automerge lanes require exact release versions', () => {
  const source = JSON.parse(readFileSync(join(ROOT, 'renovate.json'), 'utf8'));
  const automaticRules = source.packageRules.filter(
    (candidate) => candidate.automerge === true
  );
  assert.equal(automaticRules.length, 3);

  for (const rule of automaticRules) {
    assert.equal(rule.matchCurrentVersion, STABLE_SEMVER_CURRENT_VERSION);
    for (const version of ['1.0.0', '1.2.3', '10.20.30']) {
      assert.equal(
        matchesRenovateRegex(rule.matchCurrentVersion, version),
        true,
        `${rule.description} must admit ${version}`
      );
    }
    for (const version of [
      '0.2.3',
      '1.2.3-beta.1',
      '1.2.3-rc.1+build.5',
      '1.2',
      '1',
      'v1.2.3',
      '1.2.3.4',
      '01.2.3',
      '1.02.3',
      '1.2.03',
      '1.2.x',
      'latest',
    ]) {
      assert.equal(
        matchesRenovateRegex(rule.matchCurrentVersion, version),
        false,
        `${rule.description} must reject ${version}`
      );
    }
  }
});

test('root security overrides stay outside every automerge lane', () => {
  const source = JSON.parse(readFileSync(join(ROOT, 'renovate.json'), 'utf8'));
  const overrideRule = source.packageRules.find(
    (rule) =>
      rule.description === 'Root security overrides require exception handling'
  );
  assert.deepEqual(overrideRule, {
    description: 'Root security overrides require exception handling',
    matchManagers: ['npm'],
    matchFileNames: ['package.json'],
    matchDepTypes: ['overrides'],
    dependencyDashboardApproval: true,
    automerge: false,
  });
  assert.equal(
    source.packageRules.some(
      (rule) =>
        rule.automerge === true &&
        (rule.matchDepTypes ?? []).includes('overrides')
    ),
    false
  );

  for (const mutation of [
    (rule) => {
      rule.automerge = true;
    },
    (rule) => {
      rule.dependencyDashboardApproval = false;
    },
    (rule) => {
      rule.matchUpdateTypes = ['patch'];
    },
  ]) {
    const fixture = structuredClone(source);
    mutation(
      fixture.packageRules.find(
        (rule) =>
          rule.description ===
          'Root security overrides require exception handling'
      )
    );
    const problems = [];
    validateRenovate(fixture, problems);
    assert.ok(
      problems.some(
        (problem) =>
          problem.includes('package-rule definitions must remain exact') ||
          problem.includes('root security overrides must require')
      )
    );
  }
});

test('rejects Renovate matcher drift that narrows the manual default', () => {
  const fixture = JSON.parse(readFileSync(join(ROOT, 'renovate.json'), 'utf8'));
  fixture.packageRules.find(
    (rule) =>
      rule.description ===
      'Default every dependency surface to dashboard approval'
  ).matchPackageNames = ['zod'];
  const problems = [];
  validateRenovate(fixture, problems);
  assert.ok(
    problems.some((problem) =>
      problem.includes('package-rule definitions must remain exact')
    )
  );
});

test('rejects narrowed or overridden unsafe Renovate gates', () => {
  const source = JSON.parse(readFileSync(join(ROOT, 'renovate.json'), 'utf8'));
  const narrowed = structuredClone(source);
  narrowed.packageRules.at(-1).matchManagers = ['npm'];
  const narrowedProblems = [];
  validateRenovate(narrowed, narrowedProblems);
  assert.ok(
    narrowedProblems.some((problem) =>
      problem.includes('unconstrained manual gate')
    )
  );

  const overridden = structuredClone(source);
  overridden.packageRules.push({
    matchManagers: ['github-actions'],
    dependencyDashboardApproval: false,
  });
  const overriddenProblems = [];
  validateRenovate(overridden, overriddenProblems);
  assert.ok(
    overriddenProblems.some((problem) =>
      problem.includes('package-rule set must remain exact')
    )
  );
});

test('rejects shortened or later Renovate release-age overrides', () => {
  const source = JSON.parse(readFileSync(join(ROOT, 'renovate.json'), 'utf8'));
  const shortened = structuredClone(source);
  shortened.packageRules.find(
    (rule) => rule.description === 'Root stable runtime patches'
  ).minimumReleaseAge = '1 day';
  const shortenedProblems = [];
  validateRenovate(shortened, shortenedProblems);
  assert.ok(
    shortenedProblems.some((problem) =>
      problem.includes('package-rule definitions must remain exact')
    )
  );

  const overridden = structuredClone(source);
  overridden.packageRules.push({
    matchManagers: ['npm'],
    matchUpdateTypes: ['patch'],
    minimumReleaseAge: '1 day',
  });
  const overriddenProblems = [];
  validateRenovate(overridden, overriddenProblems);
  assert.ok(
    overriddenProblems.some((problem) =>
      problem.includes('package-rule set must remain exact')
    )
  );
});

test('rejects a non-enforcing aggregate gate', () => {
  const problems = [];
  validateGate(
    {
      if: 'always()',
      needs: ['lint', 'test', 'docs', 'build', 'security', 'dependency-review'],
      steps: [
        {
          run: `
            echo needs.lint.result success
            echo needs.test.result success
            echo needs.docs.result success
            echo needs.build.result success
            echo needs.security.result success
            echo needs.dependency-review.result success skipped
            false && exit 1
            exit 0
          `,
        },
      ],
    },
    problems
  );
  assert.ok(problems.length > 0);
});

test('rejects aggregate gate continue-on-error at job or step scope', () => {
  const currentGate = parseYaml(
    readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')
  ).jobs.gate;
  for (const mutate of [
    (gate) => {
      gate['continue-on-error'] = true;
    },
    (gate) => {
      gate.steps[0]['continue-on-error'] = true;
    },
  ]) {
    const gate = structuredClone(currentGate);
    mutate(gate);
    const problems = [];
    validateGate(gate, problems);
    assert.ok(problems.length > 0);
  }
});

test('rejects an aggregate gate with a custom shell', () => {
  const gate = structuredClone(
    parseYaml(
      readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')
    ).jobs.gate
  );
  gate.steps[0].shell = 'bash {0} || true';
  const problems = [];
  validateGate(gate, problems);
  assert.ok(problems.length > 0);
});

test('rejects a deploy checkout not bound to the triggering SHA', () => {
  const problems = [];
  validateDeploy(
    {
      jobs: {
        deploy: {
          if: "github.event_name == 'workflow_dispatch' || github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.event == 'push' && github.event.workflow_run.head_branch == 'main'",
          steps: [{ uses: CHECKOUT }, { run: 'git rev-parse HEAD' }],
        },
      },
    },
    problems
  );
  assert.ok(problems.length > 0);
});

test('rejects a fail-open deploy condition containing trusted substrings', () => {
  const deploy = parseYaml(
    readFileSync(join(ROOT, '.github', 'workflows', 'deploy.yml'), 'utf8')
  );
  deploy.jobs.impact.if = `true || (${deploy.jobs.impact.if})`;
  const problems = [];
  validateDeploy(deploy, problems);
  assert.ok(problems.length > 0);
});

test('rejects a trusted-trigger gate that accepts failed CI', () => {
  const deploy = parseYaml(
    readFileSync(join(ROOT, '.github', 'workflows', 'deploy.yml'), 'utf8')
  );
  const gate = deploy.jobs.impact.steps.find(
    (step) => step.name === 'Validate trusted trigger'
  );
  gate.run = gate.run.replace('test "$CONCLUSION" = "success"', 'true');
  const problems = [];
  validateDeploy(deploy, problems);
  assert.ok(problems.some((problem) => problem.includes('trusted trigger')));
});

test('rejects an echo-only deploy verification containing trusted substrings', () => {
  const deploy = parseYaml(
    readFileSync(join(ROOT, '.github', 'workflows', 'deploy.yml'), 'utf8')
  );
  deploy.jobs.impact.steps.find(
    (step) => step.name === 'Verify trusted checkout'
  ).run = `
    echo github.event.workflow_run.head_sha
    echo git rev-parse HEAD
    echo git rev-parse main
  `;
  const problems = [];
  validateDeploy(deploy, problems);
  assert.ok(problems.length > 0);
});

test('rejects triggering-run artifact download ambiguity and tampering', () => {
  const current = parseYaml(
    readFileSync(join(ROOT, '.github', 'workflows', 'deploy.yml'), 'utf8')
  );
  for (const mutate of [
    (download) => {
      download.with.pattern = 'deploy-range-*';
    },
    (download) => {
      download.with.repository = 'attacker/fork';
    },
    (download) => {
      download.with['run-id'] = '${{ github.run_id }}';
    },
    (download) => {
      download.with['digest-mismatch'] = 'warn';
    },
    (download) => {
      download.with['merge-multiple'] = true;
    },
    (download) => {
      download['continue-on-error'] = true;
    },
  ]) {
    const deploy = structuredClone(current);
    const download = deploy.jobs.impact.steps.find(
      (step) => step.name === 'Download exact triggering-run range'
    );
    mutate(download);
    const problems = [];
    validateDeploy(deploy, problems);
    assert.ok(
      problems.some((problem) => problem.includes('triggering-run artifact'))
    );
  }
});

test('rejects tampered deployment-range metadata production', () => {
  const current = parseYaml(
    readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')
  ).jobs['deployment-range'];
  for (const mutate of [
    (job) => {
      job.if = `
        github.event_name == 'push' &&
        github.ref == 'refs/heads/main' &&
        needs.gate.result == 'success'
      `;
    },
    (job) => {
      job.steps.find((step) => step.name === 'Write exact push range').run =
        'node scripts/deploy-range.mjs write --before HEAD^';
    },
    (job) => {
      job.steps.find(
        (step) => step.name === 'Upload immutable push range'
      ).with['if-no-files-found'] = 'warn';
    },
  ]) {
    const job = structuredClone(current);
    mutate(job);
    const problems = [];
    validateDeploymentRangeMetadata(job, problems);
    assert.ok(problems.length > 0);
  }
});

test('rejects Cloudflare secrets or mutations in explicit no-impact jobs', () => {
  const deploy = parseYaml(
    readFileSync(join(ROOT, '.github', 'workflows', 'deploy.yml'), 'utf8')
  );
  deploy.jobs['d1-no-impact'].steps[0].env.CLOUDFLARE_API_TOKEN = 'unsafe';
  deploy.jobs['root-worker-no-impact'].steps[0].run =
    'npm exec -- wrangler deploy';
  const problems = [];
  validateDeploy(deploy, problems);
  assert.ok(problems.some((problem) => problem.includes('secret-free no-op')));
});

test('rejects remote D1 apply outside the migration-impact job', () => {
  const deploy = parseYaml(
    readFileSync(join(ROOT, '.github', 'workflows', 'deploy.yml'), 'utf8')
  );
  deploy.jobs['deploy-root-worker'].steps.push({
    run: 'npm exec -- wrangler d1 migrations apply rewind-db --remote',
  });
  const problems = [];
  validateDeploy(deploy, problems);
  assert.ok(problems.some((problem) => problem.includes('Remote D1 apply')));
});

test('rejects Root Worker deployment before the D1 path finalizes', () => {
  const deploy = parseYaml(
    readFileSync(join(ROOT, '.github', 'workflows', 'deploy.yml'), 'utf8')
  );
  deploy.jobs['deploy-root-worker'].needs = ['impact'];
  const problems = [];
  validateDeploy(deploy, problems);
  assert.ok(problems.some((problem) => problem.includes('D1 impact path')));
});

test('rejects a Deploy checkpoint that can advance after a failed terminal path', () => {
  const current = parseYaml(
    readFileSync(join(ROOT, '.github', 'workflows', 'deploy.yml'), 'utf8')
  );
  for (const mutate of [
    (deploy) => {
      deploy.jobs['finalize-checkpoint'].needs = ['impact'];
    },
    (deploy) => {
      deploy.jobs['finalize-checkpoint'].if = 'always()';
    },
    (deploy) => {
      deploy.jobs['finalize-checkpoint'].steps.find(
        (step) => step.name === 'Upload successful Deploy checkpoint'
      ).with['retention-days'] = 1;
    },
    (deploy) => {
      deploy.jobs.impact.steps.find(
        (step) => step.name === 'Locate prior successful Deploy checkpoint'
      ).run = 'node scripts/deploy-checkpoint.mjs locate --bootstrap HEAD^';
    },
  ]) {
    const deploy = structuredClone(current);
    mutate(deploy);
    const problems = [];
    validateDeploy(deploy, problems);
    assert.ok(problems.some((problem) => problem.includes('checkpoint')));
  }
});

test('rejects MCP deploy on an unclassified main change', () => {
  const mcp = parseYaml(
    readFileSync(join(ROOT, '.github', 'workflows', 'mcp-server.yml'), 'utf8')
  );
  mcp.jobs['deploy-worker'].if =
    "github.ref == 'refs/heads/main' || startsWith(github.ref, 'refs/tags/v')";
  const problems = [];
  validateMcpDeploy(mcp, problems);
  assert.ok(
    problems.some((problem) => problem.includes('classified-main-only'))
  );
});

test('rejects MCP guard changes that do not evaluate their own workflow', () => {
  const mcp = parseYaml(
    readFileSync(join(ROOT, '.github', 'workflows', 'mcp-server.yml'), 'utf8')
  );
  mcp.on.push.paths = mcp.on.push.paths.filter(
    (path) => path !== '.github/workflows/mcp-server.yml'
  );
  const problems = [];
  validateMcpDeploy(mcp, problems);
  assert.ok(problems.some((problem) => problem.includes('its own workflow')));
});

test('rejects MCP builds that overwrite stale committed UI bundles', () => {
  const mcp = parseYaml(
    readFileSync(join(ROOT, '.github', 'workflows', 'mcp-server.yml'), 'utf8')
  );
  mcp.jobs.build.steps = mcp.jobs.build.steps.filter(
    (step) => stepRun(step) !== 'npm run check:web'
  );
  const problems = [];
  validateMcpDeploy(mcp, problems);
  assert.ok(problems.some((problem) => problem.includes('stale committed')));
});

test('rejects MCP cancellation or checkpoint advancement before every terminal path', () => {
  const current = parseYaml(
    readFileSync(join(ROOT, '.github', 'workflows', 'mcp-server.yml'), 'utf8')
  );
  for (const mutate of [
    (mcp) => {
      mcp.concurrency['cancel-in-progress'] = true;
    },
    (mcp) => {
      mcp.jobs['finalize-checkpoint'].needs = ['impact', 'build'];
    },
    (mcp) => {
      mcp.jobs['finalize-checkpoint'].if = 'always()';
    },
    (mcp) => {
      mcp.jobs.impact.steps.find(
        (step) => step.name === 'Download prior successful MCP checkpoint'
      ).with['run-id'] = '${{ github.run_id }}';
    },
  ]) {
    const mcp = structuredClone(current);
    mutate(mcp);
    const problems = [];
    validateMcpDeploy(mcp, problems);
    assert.ok(problems.length > 0);
  }
});

test('rejects collapsed Dependabot security-only schedules and missing roots', () => {
  const fixture = parseYaml(`
updates:
  - package-ecosystem: npm
    directory: /
    schedule: { interval: weekly, day: monday, time: "07:00", timezone: America/Los_Angeles }
    open-pull-requests-limit: 0
  - package-ecosystem: npm
    directory: /mcp-server
    schedule: { interval: weekly, day: monday, time: "07:00", timezone: America/Los_Angeles }
    open-pull-requests-limit: 0
  - package-ecosystem: github-actions
    directory: /
    schedule: { interval: weekly, day: monday, time: "07:00", timezone: America/Los_Angeles }
    open-pull-requests-limit: 0
`);
  const problems = [];
  validateDependabot(fixture, problems);
  assert.ok(
    problems.some((problem) => problem.includes('four npm roots and Actions'))
  );
});
