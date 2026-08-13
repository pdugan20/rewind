#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const ROOT_MANIFEST = 'package.json';
const ROOT_LOCK = 'package-lock.json';
const MCP_MANIFEST = 'mcp-server/package.json';
const MCP_LOCK = 'mcp-server/package-lock.json';

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)])
  );
}

function sameValue(left, right) {
  return (
    JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right))
  );
}

function selected(object, keys) {
  return Object.fromEntries(
    keys
      .filter((key) => object?.[key] !== undefined)
      .map((key) => [key, object[key]])
  );
}

export function productionGraph(packageDocument, lockDocument) {
  if (!lockDocument?.packages || typeof lockDocument.packages !== 'object') {
    throw new Error('package-lock.json must contain a packages map');
  }

  const packageFields = [
    'version',
    'resolved',
    'integrity',
    'link',
    'inBundle',
    'optional',
    'peer',
    'hasInstallScript',
    'dependencies',
    'optionalDependencies',
    'peerDependencies',
    'peerDependenciesMeta',
    'os',
    'cpu',
    'libc',
  ];

  const packages = Object.fromEntries(
    Object.entries(lockDocument.packages)
      .filter(([path, metadata]) => path !== '' && metadata?.dev !== true)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([path, metadata]) => [path, selected(metadata, packageFields)])
  );

  return canonicalize({
    dependencies: packageDocument?.dependencies ?? {},
    optionalDependencies: packageDocument?.optionalDependencies ?? {},
    packages,
  });
}

export function productionGraphChanged(
  basePackage,
  baseLock,
  headPackage,
  headLock
) {
  return !sameValue(
    productionGraph(basePackage, baseLock),
    productionGraph(headPackage, headLock)
  );
}

function runtimeManifest(packageDocument, surface) {
  const common = selected(packageDocument, [
    'type',
    'main',
    'exports',
    'imports',
  ]);
  if (surface !== 'mcp') return canonicalize(common);
  return canonicalize({
    ...common,
    scripts: selected(packageDocument?.scripts, ['build:web']),
  });
}

export function runtimeManifestChanged(basePackage, headPackage, surface) {
  return !sameValue(
    runtimeManifest(basePackage, surface),
    runtimeManifest(headPackage, surface)
  );
}

function isTestLike(path) {
  return (
    path.includes('/__tests__/') ||
    path.includes('/__fixtures__/') ||
    path.includes('/fixtures/') ||
    /\.(?:test|spec|live|fixtures)\.[cm]?[jt]sx?$/.test(path)
  );
}

function isRootRuntime(path) {
  if (
    path === 'wrangler.toml' ||
    path === 'wrangler.json' ||
    path === 'wrangler.jsonc'
  ) {
    return true;
  }
  if (path === 'tsconfig.json') return true;
  return path.startsWith('src/') && !isTestLike(path);
}

function isMcpRuntime(path) {
  if (path === 'mcp-server/src/ui-bundles.ts') return false;
  if (
    path === 'mcp-server/wrangler.toml' ||
    path === 'mcp-server/wrangler.json' ||
    path === 'mcp-server/wrangler.jsonc' ||
    path === 'mcp-server/tsconfig.json' ||
    path === 'mcp-server/scripts/inline-bundles.mjs'
  ) {
    return true;
  }
  if (path.startsWith('mcp-server/src/')) return !isTestLike(path);
  if (path.startsWith('mcp-server/web/')) {
    return !path.startsWith('mcp-server/web/dist/') && !isTestLike(path);
  }
  return false;
}

export function classifyChangedFiles(
  changedFiles,
  {
    rootGraphChanged = false,
    mcpGraphChanged = false,
    rootManifestChanged = false,
    mcpManifestChanged = false,
  } = {}
) {
  const files = [...new Set(changedFiles)].sort();
  const migrationFiles = files.filter((path) => path.startsWith('migrations/'));
  const rootRuntimeFiles = files.filter(isRootRuntime);
  const mcpRuntimeFiles = files.filter(isMcpRuntime);

  const d1Migrations = migrationFiles.length > 0;
  const rootWorker =
    rootRuntimeFiles.length > 0 || rootGraphChanged || rootManifestChanged;
  const mcpWorker =
    mcpRuntimeFiles.length > 0 || mcpGraphChanged || mcpManifestChanged;

  return {
    d1Migrations,
    rootWorker,
    mcpWorker,
    rootGraphChanged,
    mcpGraphChanged,
    reasons: {
      d1: migrationFiles,
      root: [
        ...rootRuntimeFiles,
        ...(rootGraphChanged ? ['root production dependency graph'] : []),
        ...(rootManifestChanged ? ['root runtime manifest'] : []),
      ],
      mcp: [
        ...mcpRuntimeFiles,
        ...(mcpGraphChanged ? ['MCP production dependency graph'] : []),
        ...(mcpManifestChanged ? ['MCP runtime manifest'] : []),
      ],
    },
    changedFiles: files,
  };
}

function git(args, options = {}) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
}

function gitJson(ref, path, { cwd } = {}) {
  try {
    return JSON.parse(git(['show', `${ref}:${path}`], { cwd }));
  } catch (error) {
    throw new Error(`cannot read ${path} at ${ref}: ${error.message}`);
  }
}

function changedFiles(baseRef, headRef, { cwd } = {}) {
  const output = git(
    ['diff', '--no-renames', '--name-only', '-z', baseRef, headRef],
    {
      encoding: 'buffer',
      cwd,
    }
  );
  return output.toString('utf8').split('\0').filter(Boolean);
}

export function classifyGitRange(
  baseRef,
  headRef,
  { useMergeBase = false, cwd } = {}
) {
  let comparisonBase = baseRef;
  if (useMergeBase) {
    comparisonBase = git(['merge-base', baseRef, headRef], { cwd }).trim();
    if (!/^[0-9a-f]{40}$/.test(comparisonBase)) {
      throw new Error('git merge-base did not return one full SHA');
    }
  } else {
    execFileSync('git', ['merge-base', '--is-ancestor', baseRef, headRef], {
      stdio: ['ignore', 'ignore', 'pipe'],
      cwd,
    });
  }
  const files = changedFiles(comparisonBase, headRef, { cwd });

  let rootGraphHasChanged = false;
  let rootRuntimeManifestHasChanged = false;
  if (files.includes(ROOT_MANIFEST) || files.includes(ROOT_LOCK)) {
    const basePackage = gitJson(comparisonBase, ROOT_MANIFEST, { cwd });
    const headPackage = gitJson(headRef, ROOT_MANIFEST, { cwd });
    rootGraphHasChanged = productionGraphChanged(
      basePackage,
      gitJson(comparisonBase, ROOT_LOCK, { cwd }),
      headPackage,
      gitJson(headRef, ROOT_LOCK, { cwd })
    );
    rootRuntimeManifestHasChanged = runtimeManifestChanged(
      basePackage,
      headPackage,
      'root'
    );
  }

  let mcpGraphHasChanged = false;
  let mcpRuntimeManifestHasChanged = false;
  if (files.includes(MCP_MANIFEST) || files.includes(MCP_LOCK)) {
    const basePackage = gitJson(comparisonBase, MCP_MANIFEST, { cwd });
    const headPackage = gitJson(headRef, MCP_MANIFEST, { cwd });
    mcpGraphHasChanged = productionGraphChanged(
      basePackage,
      gitJson(comparisonBase, MCP_LOCK, { cwd }),
      headPackage,
      gitJson(headRef, MCP_LOCK, { cwd })
    );
    mcpRuntimeManifestHasChanged = runtimeManifestChanged(
      basePackage,
      headPackage,
      'mcp'
    );
  }

  return classifyChangedFiles(files, {
    rootGraphChanged: rootGraphHasChanged,
    mcpGraphChanged: mcpGraphHasChanged,
    rootManifestChanged: rootRuntimeManifestHasChanged,
    mcpManifestChanged: mcpRuntimeManifestHasChanged,
  });
}

function parseArguments(argv) {
  const result = { forceAll: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--manual') {
      result.forceAll = 'manual dispatch';
      continue;
    }
    if (argument === '--release') {
      result.forceAll = 'release tag';
      continue;
    }
    if (argument === '--merge-base') {
      result.useMergeBase = true;
      continue;
    }
    if (['--base', '--head', '--output'].includes(argument)) {
      const value = argv[index + 1];
      if (!value) throw new Error(`${argument} requires a value`);
      result[argument.slice(2)] = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${argument}`);
  }
  if (!result.head) throw new Error('--head is required');
  if (!result.forceAll && !result.base) throw new Error('--base is required');
  return result;
}

function githubOutputs(classification, { base, head, forceAll }) {
  const summary = forceAll
    ? { mode: forceAll, allProductionActions: true }
    : classification.reasons;
  return {
    base_sha: base ?? '',
    head_sha: head,
    manual: String(forceAll === 'manual dispatch'),
    d1_migrations: String(Boolean(forceAll) || classification.d1Migrations),
    root_worker: String(Boolean(forceAll) || classification.rootWorker),
    mcp_worker: String(Boolean(forceAll) || classification.mcpWorker),
    root_graph_changed: String(classification.rootGraphChanged),
    mcp_graph_changed: String(classification.mcpGraphChanged),
    summary: JSON.stringify(summary),
  };
}

function writeOutputs(path, outputs) {
  for (const [key, value] of Object.entries(outputs)) {
    if (value.includes('\n') || value.includes('\r')) {
      throw new Error(`output ${key} must be a single line`);
    }
    appendFileSync(path, `${key}=${value}\n`, 'utf8');
  }
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const classification = options.forceAll
    ? classifyChangedFiles([])
    : classifyGitRange(options.base, options.head, {
        useMergeBase: options.useMergeBase,
      });
  const outputs = githubOutputs(classification, options);
  if (options.output) writeOutputs(options.output, outputs);
  process.stdout.write(
    `${JSON.stringify({ ...classification, outputs }, null, 2)}\n`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(`[deploy-impact] ${error.message}`);
    process.exitCode = 1;
  }
}
