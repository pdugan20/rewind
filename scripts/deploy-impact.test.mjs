import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  readdirSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  isArtworkRuntime,
  isArtworkTestInput,
  classifyChangedFiles,
  classifyGitRange,
  productionGraphChanged,
  runtimeManifestChanged,
} from './deploy-impact.mjs';

const IMPACT_SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  'deploy-impact.mjs'
);

function git(directory, args) {
  return execFileSync('git', args, {
    cwd: directory,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function commit(directory, message) {
  git(directory, ['add', '--all']);
  git(directory, ['commit', '-m', message]);
  return git(directory, ['rev-parse', 'HEAD']);
}

function withRepository(run) {
  const directory = mkdtempSync(join(tmpdir(), 'rewind-deploy-impact-'));
  try {
    git(directory, ['init', '-b', 'main']);
    git(directory, ['config', 'user.name', 'Rewind Tests']);
    git(directory, ['config', 'user.email', 'rewind-tests@example.invalid']);
    mkdirSync(join(directory, 'src'));
    mkdirSync(join(directory, 'mcp-server', 'src'), { recursive: true });
    writeFileSync(join(directory, 'src', 'index.ts'), 'export {};\n');
    writeFileSync(join(directory, 'wrangler.toml'), 'name = "rewind"\n');
    for (const prefix of ['', 'mcp-server/']) {
      writeFileSync(
        join(directory, prefix, 'package.json'),
        JSON.stringify({ type: 'module', dependencies: {} })
      );
      writeFileSync(
        join(directory, prefix, 'package-lock.json'),
        JSON.stringify({ lockfileVersion: 3, packages: { '': {} } })
      );
    }
    const initial = commit(directory, 'initial');
    run(directory, initial);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function lock(packages) {
  return { lockfileVersion: 3, packages: { '': {}, ...packages } };
}

test('workflow and deploy-policy test changes have no production impact', () => {
  const result = classifyChangedFiles([
    '.github/workflows/deploy.yml',
    '.github/workflows/mcp-server.yml',
    'scripts/automation-policy.test.mjs',
    'scripts/deploy-impact.mjs',
    'scripts/deploy-impact.test.mjs',
  ]);
  assert.equal(result.d1Migrations, false);
  assert.equal(result.rootWorker, false);
  assert.equal(result.mcpWorker, false);
});

test('migrations trigger only the remote D1 action', () => {
  const result = classifyChangedFiles(['migrations/0042_example.sql']);
  assert.equal(result.d1Migrations, true);
  assert.equal(result.rootWorker, false);
  assert.equal(result.mcpWorker, false);
});

test('root runtime and config changes trigger only the root Worker', () => {
  for (const path of ['src/index.ts', 'wrangler.toml', 'tsconfig.json']) {
    const result = classifyChangedFiles([path]);
    assert.equal(result.rootWorker, true, path);
    assert.equal(result.d1Migrations, false, path);
    assert.equal(result.mcpWorker, false, path);
  }
});

test('root tests and documentation do not trigger a Worker deploy', () => {
  const result = classifyChangedFiles([
    'src/routes/listening.test.ts',
    'src/__tests__/openapi-snapshot.test.ts',
    'README.md',
    'docs/ARCHITECTURE.md',
  ]);
  assert.equal(result.rootWorker, false);
});

test('MCP runtime, UI inputs, and deployment config trigger only the MCP Worker', () => {
  for (const path of [
    'mcp-server/src/worker.ts',
    'mcp-server/web/article.tsx',
    'mcp-server/scripts/inline-bundles.mjs',
    'mcp-server/wrangler.toml',
    'mcp-server/tsconfig.json',
  ]) {
    const result = classifyChangedFiles([path]);
    assert.equal(result.mcpWorker, true, path);
    assert.equal(result.rootWorker, false, path);
    assert.equal(result.d1Migrations, false, path);
  }
});

test('generated MCP bundle churn alone is a no-op', () => {
  const result = classifyChangedFiles(['mcp-server/src/ui-bundles.ts']);
  assert.equal(result.mcpWorker, false);
});

test('generated MCP bundles deploy when a human-authored UI input also changes', () => {
  const result = classifyChangedFiles([
    'mcp-server/src/ui-bundles.ts',
    'mcp-server/web/article.tsx',
  ]);
  assert.equal(result.mcpWorker, true);
});

test('MCP tests, fixtures, workbench, and docs are no-ops', () => {
  const result = classifyChangedFiles([
    'mcp-server/src/__tests__/server.test.ts',
    'mcp-server/web/components/ArticleDetail.test.tsx',
    'mcp-server/web/article.fixtures.ts',
    'mcp-server/web/fixtures/article.json',
    'mcp-server/web-workbench/src/Workbench.tsx',
    'docs-mintlify/mcp/tools.mdx',
  ]);
  assert.equal(result.mcpWorker, false);
});

test('production graph comparison ignores dev-only lockfile churn', () => {
  const packageDocument = { dependencies: { hono: '^4.0.0' } };
  const base = lock({
    'node_modules/hono': { version: '4.12.0', integrity: 'prod' },
    'node_modules/typescript': {
      version: '5.9.3',
      integrity: 'old',
      dev: true,
    },
  });
  const head = lock({
    'node_modules/hono': { version: '4.12.0', integrity: 'prod' },
    'node_modules/typescript': {
      version: '6.0.3',
      integrity: 'new',
      dev: true,
    },
  });
  assert.equal(
    productionGraphChanged(packageDocument, base, packageDocument, head),
    false
  );
});

test('production graph comparison detects resolved runtime changes', () => {
  const packageDocument = { dependencies: { hono: '^4.0.0' } };
  const base = lock({
    'node_modules/hono': { version: '4.12.0', integrity: 'old' },
  });
  const head = lock({
    'node_modules/hono': { version: '4.13.0', integrity: 'new' },
  });
  assert.equal(
    productionGraphChanged(packageDocument, base, packageDocument, head),
    true
  );
});

test('production graph flags feed the matching Worker only', () => {
  assert.deepEqual(
    classifyChangedFiles(['package-lock.json'], { rootGraphChanged: true }),
    {
      d1Migrations: false,
      rootWorker: true,
      artworkWorker: true,
      artworkTests: true,
      mcpWorker: false,
      rootGraphChanged: true,
      mcpGraphChanged: false,
      reasons: {
        d1: [],
        root: ['root production dependency graph'],
        artwork: ['root production dependency graph'],
        artworkTests: ['package-lock.json', 'root production dependency graph'],
        mcp: [],
      },
      changedFiles: ['package-lock.json'],
    }
  );
  assert.equal(
    classifyChangedFiles(['mcp-server/package-lock.json'], {
      mcpGraphChanged: true,
    }).mcpWorker,
    true
  );
});

test('toolchain-only manifest changes do not count as runtime config', () => {
  const base = {
    type: 'module',
    main: 'src/index.ts',
    engines: { node: '22.18.0' },
    devDependencies: { typescript: '^5.9.3' },
  };
  const head = {
    ...base,
    engines: { node: '>=24.19.0 <25' },
    devDependencies: { typescript: '^6.0.3' },
  };
  assert.equal(runtimeManifestChanged(base, head, 'root'), false);
});

test('MCP build-input script changes count as runtime config', () => {
  const base = { scripts: { 'build:web': 'node scripts/inline-bundles.mjs' } };
  const head = { scripts: { 'build:web': 'node scripts/other-builder.mjs' } };
  assert.equal(runtimeManifestChanged(base, head, 'mcp'), true);
});

test('classifies every commit in a multi-commit push range', () => {
  withRepository((directory, before) => {
    mkdirSync(join(directory, 'migrations'));
    writeFileSync(
      join(directory, 'migrations', '0042_test.sql'),
      'SELECT 1;\n'
    );
    commit(directory, 'migration');
    writeFileSync(
      join(directory, 'src', 'index.ts'),
      'export const changed = true;\n'
    );
    const head = commit(directory, 'runtime');
    const result = classifyGitRange(before, head, { cwd: directory });
    assert.equal(result.d1Migrations, true);
    assert.equal(result.rootWorker, true);
    const cli = JSON.parse(
      execFileSync(
        process.execPath,
        [IMPACT_SCRIPT, '--base', before, '--head', head],
        {
          cwd: directory,
          encoding: 'utf8',
        }
      )
    );
    assert.equal(cli.outputs.d1_migrations, 'true');
    assert.equal(cli.outputs.root_worker, 'true');
    assert.equal(cli.outputs.head_sha, head);
  });
});

test('classifies a merge push from its trusted first-parent before SHA', () => {
  withRepository((directory, before) => {
    git(directory, ['switch', '-c', 'feature']);
    mkdirSync(join(directory, 'migrations'));
    writeFileSync(
      join(directory, 'migrations', '0042_merge.sql'),
      'SELECT 1;\n'
    );
    commit(directory, 'feature migration');
    git(directory, ['switch', 'main']);
    git(directory, ['merge', '--no-ff', 'feature', '-m', 'merge feature']);
    const head = git(directory, ['rev-parse', 'HEAD']);
    const result = classifyGitRange(before, head, { cwd: directory });
    assert.equal(result.d1Migrations, true);
  });
});

test('rename detection cannot hide removal of production config', () => {
  withRepository((directory, before) => {
    mkdirSync(join(directory, 'docs'));
    git(directory, ['mv', 'wrangler.toml', 'docs/wrangler-example.toml']);
    const head = commit(directory, 'move config');
    const result = classifyGitRange(before, head, { cwd: directory });
    assert.equal(result.rootWorker, true);
    assert.ok(result.changedFiles.includes('wrangler.toml'));
  });
});

test('divergent PR history compares from the merge base', () => {
  withRepository((directory, common) => {
    git(directory, ['switch', '-c', 'feature']);
    writeFileSync(
      join(directory, 'mcp-server', 'src', 'worker.ts'),
      'export {};\n'
    );
    const head = commit(directory, 'mcp runtime');
    git(directory, ['switch', 'main']);
    writeFileSync(join(directory, 'README.md'), 'advanced main\n');
    const base = commit(directory, 'advance main');
    assert.throws(() => classifyGitRange(base, head, { cwd: directory }));
    const result = classifyGitRange(base, head, {
      cwd: directory,
      useMergeBase: true,
    });
    assert.equal(result.mcpWorker, true);
    assert.equal(git(directory, ['merge-base', base, head]), common);
  });
});

test('artwork processing inputs trigger only the artwork deployment', () => {
  for (const path of [
    'wrangler.cd-artwork.jsonc',
    'scripts/cd-artwork/pixels.mjs',
    'src/services/cd-artwork/assets/cover-template.png',
  ]) {
    const impact = classifyChangedFiles([path]);
    assert.equal(impact.rootWorker, false, path);
    assert.equal(impact.artworkWorker, true, path);
    assert.equal(impact.mcpWorker, false, path);
  }
  assert.equal(
    classifyChangedFiles(['scripts/cd-artwork/pipeline.test.mjs']).rootWorker,
    false
  );
});

test('API descriptions do not replace the independent artwork Worker', () => {
  const impact = classifyChangedFiles(['src/routes/listening.ts']);
  assert.equal(impact.rootWorker, true);
  assert.equal(impact.artworkWorker, false);
});

test('shared auth, storage, image helpers and runtime dependencies affect both Workers', () => {
  for (const path of [
    'src/lib/auth.ts',
    'src/db/client.ts',
    'src/types/env.ts',
    'src/services/images/colors.ts',
  ]) {
    const impact = classifyChangedFiles([path]);
    assert.equal(impact.rootWorker, true, path);
    assert.equal(impact.artworkWorker, true, path);
  }
});

test('every local runtime import of the artwork Worker remains in its impact boundary', () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const seen = new Set();
  function visit(path) {
    if (seen.has(path)) return;
    seen.add(path);
    assert.ok(
      isArtworkRuntime(relative(root, path)),
      `Unclassified artwork dependency: ${relative(root, path)}`
    );
    if (!/\.(ts|js|mjs)$/.test(path)) return;
    const source = ts.createSourceFile(
      path,
      readFileSync(path, 'utf8'),
      ts.ScriptTarget.Latest,
      true
    );
    function walk(node) {
      let specifier;
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        !node.isTypeOnly &&
        !node.importClause?.isTypeOnly
      )
        specifier = node.moduleSpecifier;
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) &&
            node.expression.text === 'require'))
      )
        specifier = node.arguments[0];
      if (
        specifier &&
        ts.isStringLiteral(specifier) &&
        specifier.text.startsWith('.')
      ) {
        const target = resolve(dirname(path), specifier.text);
        const resolved = [
          target,
          target.replace(/\.js$/, '.ts'),
          `${target}.ts`,
          `${target}.js`,
        ].find(existsSync);
        assert.ok(
          resolved,
          `Unresolved runtime import ${specifier.text} in ${path}`
        );
        visit(resolved);
      }
      ts.forEachChild(node, walk);
    }
    walk(source);
  }
  visit(join(root, 'src/cd-artwork-worker.ts'));
  visit(join(root, 'scripts/cd-artwork/build.mjs'));
});

test('manual dispatch explicitly selects both Worker deployments', () => {
  const cli = JSON.parse(
    execFileSync(
      process.execPath,
      [IMPACT_SCRIPT, '--manual', '--head', 'a'.repeat(40)],
      { encoding: 'utf8' }
    )
  );
  assert.equal(cli.outputs.root_worker, 'true');
  assert.equal(cli.outputs.artwork_worker, 'true');
});

test('artwork tests run for every artwork deployment and for test-only inputs', () => {
  for (const path of [
    'src/cd-artwork-worker.ts',
    'src/lib/auth.ts',
    'src/db/client.ts',
    'src/types/env.ts',
    'src/services/images/colors.ts',
    'tsconfig.json',
    'wrangler.cd-artwork.jsonc',
    'migrations/0042_example.sql',
    'vitest.cd-artwork.config.ts',
    'src/services/cd-artwork/automatic.test.ts',
    'scripts/cd-artwork/pipeline.test.mjs',
    'src/test-helpers.ts',
    'src/services/lastfm/sync.ts',
    'package.json',
    'package-lock.json',
    '.nvmrc',
    '.github/workflows/ci.yml',
    'scripts/deploy-impact.mjs',
  ]) {
    assert.equal(classifyChangedFiles([path]).artworkTests, true, path);
  }
  assert.equal(
    classifyChangedFiles([], { rootGraphChanged: true }).artworkTests,
    true
  );
  assert.equal(
    classifyChangedFiles([], { rootManifestChanged: true }).artworkTests,
    true
  );
});

test('API, MCP, documentation and unrelated tooling changes skip the artwork tests', () => {
  const impact = classifyChangedFiles([
    'src/routes/listening.ts',
    'src/routes/listening.test.ts',
    'src/services/strava/sync.ts',
    'mcp-server/src/worker.ts',
    'docs/ARCHITECTURE.md',
    'docs-mintlify/index.mdx',
    '.github/workflows/deploy.yml',
    'scripts/automation-policy.test.mjs',
  ]);
  assert.equal(impact.artworkWorker, false);
  assert.equal(impact.artworkTests, false);
  assert.deepEqual(impact.reasons.artworkTests, []);
});

test('artwork test impact is a superset of artwork deployment impact', () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const files = git(root, ['ls-files']).split('\n').filter(Boolean);
  for (const path of files) {
    if (isArtworkRuntime(path)) {
      assert.ok(isArtworkTestInput(path), path);
    }
  }
});

test('every local import of the artwork test suites remains in the test impact boundary', () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const seen = new Set();
  function visit(path) {
    if (seen.has(path)) return;
    seen.add(path);
    assert.ok(
      isArtworkTestInput(relative(root, path)),
      `Unclassified artwork test dependency: ${relative(root, path)}`
    );
    if (!/\.(ts|js|mjs|mts)$/.test(path)) return;
    const source = ts.createSourceFile(
      path,
      readFileSync(path, 'utf8'),
      ts.ScriptTarget.Latest,
      true
    );
    function walk(node) {
      let specifier;
      // Type-only imports are included: the boundary is deliberately broad.
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
        specifier = node.moduleSpecifier;
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) &&
            node.expression.text === 'require'))
      )
        specifier = node.arguments[0];
      if (
        specifier &&
        ts.isStringLiteral(specifier) &&
        specifier.text.startsWith('.')
      ) {
        const target = resolve(dirname(path), specifier.text);
        const resolved = [
          target,
          target.replace(/\.js$/, '.ts'),
          `${target}.ts`,
          `${target}.js`,
        ].find(
          (candidate) =>
            existsSync(candidate) && !statSync(candidate).isDirectory()
        );
        assert.ok(
          resolved,
          `Unresolved test import ${specifier.text} in ${path}`
        );
        visit(resolved);
      }
      ts.forEachChild(node, walk);
    }
    walk(source);
  }
  const suites = join(root, 'src/services/cd-artwork');
  for (const name of readdirSync(suites).filter((name) =>
    name.endsWith('.test.ts')
  )) {
    visit(join(suites, name));
  }
  visit(join(root, 'scripts/cd-artwork/pipeline.test.mjs'));
  visit(join(root, 'vitest.cd-artwork.config.ts'));
  assert.ok(seen.size > 10);
});

test('CLI writes the artwork test decision for CI', () => {
  withRepository((directory, initial) => {
    writeFileSync(join(directory, 'src', 'routes.ts'), 'export {};\n');
    const apiOnly = commit(directory, 'api only');
    const apiOutputs = JSON.parse(
      execFileSync(
        process.execPath,
        [IMPACT_SCRIPT, '--base', initial, '--head', apiOnly, '--merge-base'],
        { cwd: directory, encoding: 'utf8' }
      )
    ).outputs;
    assert.equal(apiOutputs.artwork_tests, 'false');
    mkdirSync(join(directory, 'src', 'services', 'cd-artwork'), {
      recursive: true,
    });
    writeFileSync(
      join(directory, 'src', 'services', 'cd-artwork', 'store.ts'),
      'export {};\n'
    );
    const artwork = commit(directory, 'artwork');
    const artworkOutputs = JSON.parse(
      execFileSync(
        process.execPath,
        [IMPACT_SCRIPT, '--base', initial, '--head', artwork, '--merge-base'],
        { cwd: directory, encoding: 'utf8' }
      )
    ).outputs;
    assert.equal(artworkOutputs.artwork_tests, 'true');
  });
  const manual = JSON.parse(
    execFileSync(
      process.execPath,
      [IMPACT_SCRIPT, '--manual', '--head', 'a'.repeat(40)],
      { encoding: 'utf8' }
    )
  ).outputs;
  assert.equal(manual.artwork_tests, 'true');
});
