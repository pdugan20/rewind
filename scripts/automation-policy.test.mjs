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
const ACTION_PINS = new Map([
  ['actions/checkout', `${CHECKOUT} # v7`],
  ['actions/setup-node', `${SETUP_NODE} # v7`],
  ['actions/dependency-review-action', `${DEPENDENCY_REVIEW} # v5`],
  ['amannn/action-semantic-pull-request', `${PR_TITLE} # v6`],
  ['googleapis/release-please-action', `${RELEASE_PLEASE} # v5`],
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
    'deploy.yml': { contents: 'read' },
    'mcp-server.yml': { contents: 'read' },
    'pr-lint.yml': { 'pull-requests': 'read' },
    'release-please.yml': { contents: 'write', 'pull-requests': 'write' },
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
    const nodeVersion = isMcp ? '24.0.0' : '22.18.0';
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
      if (String(steps[setupIndex]?.with?.['node-version']) !== nodeVersion) {
        problems.push(`${name}:${jobId} must use Node ${nodeVersion}`);
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
  const condition = normalizeExpression(document.jobs?.deploy?.if);
  const expectedCondition = normalizeExpression(`
    github.event_name == 'workflow_dispatch' ||
    (github.event.workflow_run.conclusion == 'success' &&
    github.event.workflow_run.event == 'push' &&
    github.event.workflow_run.head_branch == 'main')
  `);
  if (condition !== expectedCondition) {
    problems.push(
      'Deploy condition must exactly enforce the trusted event policy'
    );
  }
  const steps = document.jobs?.deploy?.steps ?? [];
  const checkouts = steps.filter((step) => step?.uses === CHECKOUT);
  const checkout = steps[0];
  if (
    checkouts.length !== 1 ||
    checkout?.uses !== CHECKOUT ||
    checkout?.with?.ref !==
      "${{ github.event_name == 'workflow_run' && github.event.workflow_run.head_sha || 'main' }}"
  ) {
    problems.push(
      'Deploy checkout must select the successful workflow head SHA or main for dispatch'
    );
  }
  const verification = steps[1];
  const expectedCommands = normalizeCommands(`
    EXPECTED_REF="\${{ github.event_name == 'workflow_run' && github.event.workflow_run.head_sha || 'main' }}"
    if [ "$EXPECTED_REF" = "main" ]; then
      EXPECTED_SHA="$(git rev-parse main)"
    else
      EXPECTED_SHA="$EXPECTED_REF"
    fi
    test "$(git rev-parse HEAD)" = "$EXPECTED_SHA"
  `);
  if (
    verification?.name !== 'Verify trusted checkout' ||
    !sameObject(Object.keys(verification ?? {}).sort(), ['name', 'run']) ||
    !sameObject(normalizeCommands(stepRun(verification)), expectedCommands)
  ) {
    problems.push(
      'Deploy must use the exact fail-closed checkout verification step'
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
    mcp?.jobs?.['publish-npm']?.if !==
    "startsWith(github.ref, 'refs/tags/mcp-server-v')"
  ) {
    problems.push('npm provenance publishing must remain tag-only');
  }
  if (
    mcp?.jobs?.['deploy-worker']?.if !==
    "github.ref == 'refs/heads/main' || startsWith(github.ref, 'refs/tags/mcp-server-v')"
  ) {
    problems.push('MCP Worker deployment must remain main-or-tag-only');
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
          (name === 'deploy.yml' && jobId === 'deploy') ||
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
  if (!sameObject(rootPackage.engines, { node: '22.18.0', npm: '11.5.2' })) {
    problems.push('root engines must pin Node 22.18.0 and npm 11.5.2');
  }
  if (rootPackage.packageManager !== 'npm@11.5.2')
    problems.push('root packageManager must pin npm 11.5.2');
  if (rootPackage.devDependencies?.['claude-code-lint'] !== '0.7.0') {
    problems.push('claude-code-lint must be exact 0.7.0');
  }
  if (rootPackage.dependencies?.yaml !== '2.9.0')
    problems.push('yaml must be exact 2.9.0');
  if (rootPackage.devDependencies?.mint !== '4.2.728')
    problems.push('mint must be exact 4.2.728');
  if (rootPackage.devDependencies?.tsx !== '4.21.0')
    problems.push('tsx must be direct and exact 4.21.0');
  if (rootPackage.scripts?.['lint:claude'] !== 'claudelint') {
    problems.push('lint:claude must invoke the local binary');
  }
  if (
    rootPackage.scripts?.['test:automation-policy'] !==
    'node --test scripts/automation-policy.test.mjs'
  ) {
    problems.push(
      'test:automation-policy must invoke the zero-network Node suite'
    );
  }
  if (mcpPackage.packageManager !== 'npm@11.5.2')
    problems.push('MCP packageManager must pin npm 11.5.2');
}

function validateDependabot(document, problems) {
  const updates = document?.updates ?? [];
  const get = (ecosystem, directory) =>
    updates.find(
      (entry) =>
        entry?.['package-ecosystem'] === ecosystem &&
        entry?.directory === directory
    );
  const root = get('npm', '/');
  const mcp = get('npm', '/mcp-server');
  const actions = get('github-actions', '/');
  if (updates.length !== 3 || !root || !mcp || !actions) {
    problems.push(
      'Dependabot must define exactly root npm, MCP npm, and Actions surfaces'
    );
    return;
  }
  validateSchedule(root, '09:00', 5, 'root npm', problems);
  validateSchedule(mcp, '10:00', 3, 'MCP npm', problems);
  validateSchedule(actions, '11:00', 2, 'Actions', problems);
  const rootPatterns = {
    cloudflare: ['wrangler', '@cloudflare/*'],
    drizzle: ['drizzle-orm', 'drizzle-kit'],
    eslint: ['eslint', '@typescript-eslint/*', 'eslint-*'],
    vitest: ['vitest', '@vitest/*'],
  };
  for (const [key, patterns] of Object.entries(rootPatterns)) {
    if (!sameObject(root.groups?.[key]?.patterns, patterns)) {
      problems.push(
        `root group ${key} patterns must preserve its family boundary`
      );
    }
    if (!sameObject(root.groups?.[key]?.['update-types'], ['minor', 'patch'])) {
      problems.push(`root group ${key} must be patch/minor-only`);
    }
  }
  const stable = mcp.groups?.['mcp-stable'];
  if (
    !sameObject(stable?.patterns, ['*']) ||
    !sameObject(stable?.['exclude-patterns'], [
      '@cloudflare/workers-oauth-provider',
      'thumbhash',
    ]) ||
    !sameObject(stable?.['update-types'], ['minor', 'patch'])
  ) {
    problems.push(
      'MCP stable group must exclude the two named pre-1 dependencies'
    );
  }
  const actionGroup = actions.groups?.['actions-minor-patch'];
  if (
    !sameObject(actionGroup?.patterns, ['*']) ||
    !sameObject(actionGroup?.['update-types'], ['minor', 'patch'])
  ) {
    problems.push('Actions group must be patch/minor-only');
  }
  for (const [label, entry] of [
    ['root npm', root],
    ['MCP npm', mcp],
    ['Actions', actions],
  ]) {
    if (
      !entry.ignore?.some(
        (rule) =>
          rule?.['dependency-name'] === '*' &&
          sameObject(rule?.['update-types'], ['version-update:semver-major'])
      )
    ) {
      problems.push(`${label} must ignore wildcard major updates`);
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
  validateTrustedBoundaries(workflows, sources, problems);
  validatePackages(
    JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')),
    JSON.parse(readFileSync(join(root, 'mcp-server', 'package.json'), 'utf8')),
    problems
  );
  validateDependabot(
    parseYaml(
      readFileSync(join(root, '.github', 'dependabot.yml'), 'utf8'),
      'dependabot.yml'
    ),
    problems
  );
  return problems;
}

test('repository automation satisfies the fail-closed contract', () => {
  assert.deepEqual(validateRepository(ROOT), []);
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
              if: "startsWith(github.ref, 'refs/tags/mcp-server-v')",
              permissions: { contents: 'read', 'id-token': 'write' },
            },
            'deploy-worker': {
              if: "github.ref == 'refs/heads/main' || startsWith(github.ref, 'refs/tags/mcp-server-v')",
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

test('rejects drift in root updater family boundaries', () => {
  const fixture = parseYaml(
    readFileSync(join(ROOT, '.github', 'dependabot.yml'), 'utf8')
  );
  fixture.updates[0].groups.cloudflare.patterns = ['*'];
  const problems = [];
  validateDependabot(fixture, problems);
  assert.ok(
    problems.some((problem) => problem.includes('cloudflare patterns'))
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
  deploy.jobs.deploy.if = `true || (${deploy.jobs.deploy.if})`;
  const problems = [];
  validateDeploy(deploy, problems);
  assert.ok(problems.length > 0);
});

test('rejects an echo-only deploy verification containing trusted substrings', () => {
  const deploy = parseYaml(
    readFileSync(join(ROOT, '.github', 'workflows', 'deploy.yml'), 'utf8')
  );
  deploy.jobs.deploy.steps[1].run = `
    echo github.event.workflow_run.head_sha
    echo git rev-parse HEAD
    echo git rev-parse main
  `;
  const problems = [];
  validateDeploy(deploy, problems);
  assert.ok(problems.length > 0);
});

test('rejects collapsed schedules, grouped majors, and grouped pre-1 dependencies', () => {
  const fixture = parseYaml(`
updates:
  - package-ecosystem: npm
    directory: /
    schedule: { interval: weekly, day: monday, time: "09:00", timezone: America/Los_Angeles }
    open-pull-requests-limit: 5
    groups:
      cloudflare: { update-types: [major, minor, patch] }
      drizzle: { update-types: [minor, patch] }
      eslint: { update-types: [minor, patch] }
      vitest: { update-types: [minor, patch] }
    ignore: []
  - package-ecosystem: npm
    directory: /mcp-server
    schedule: { interval: weekly, day: monday, time: "09:00", timezone: America/Los_Angeles }
    open-pull-requests-limit: 3
    groups:
      mcp-stable: { patterns: ["*"], update-types: [minor, patch] }
    ignore: []
  - package-ecosystem: github-actions
    directory: /
    schedule: { interval: weekly, day: monday, time: "09:00", timezone: America/Los_Angeles }
    open-pull-requests-limit: 2
    groups:
      actions-minor-patch: { patterns: ["*"], update-types: [major, minor, patch] }
    ignore: []
`);
  const problems = [];
  validateDependabot(fixture, problems);
  assert.ok(problems.some((problem) => problem.includes('10:00')));
  assert.ok(problems.some((problem) => problem.includes('11:00')));
  assert.ok(problems.some((problem) => problem.includes('pre-1')));
  assert.ok(problems.some((problem) => problem.includes('major')));
});
