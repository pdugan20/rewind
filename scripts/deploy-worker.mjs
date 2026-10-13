import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const CONFIGS = { root: 'wrangler.toml', artwork: 'wrangler.cd-artwork.jsonc' };
const SHA = /^[0-9a-f]{40}$/;

function git(args, cwd = ROOT) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export function checkSource(expectedHead, cwd = ROOT) {
  const head = git(['rev-parse', 'HEAD'], cwd);
  if (!SHA.test(head) || (expectedHead && expectedHead !== head)) {
    throw new Error('Checkout does not match the expected source commit');
  }
  if (git(['status', '--porcelain', '--untracked-files=all'], cwd)) {
    throw new Error(
      'Commit or preserve local changes before deploying; source checkout must be clean'
    );
  }
  git(['merge-base', '--is-ancestor', head, 'origin/main'], cwd);
  return head;
}

export function activeDeployment(deployments) {
  if (!Array.isArray(deployments) || deployments.length === 0) {
    throw new Error(
      'No deployment history; establish an approved initial deployment separately'
    );
  }
  for (const deployment of deployments) {
    if (!deployment.id || !Number.isFinite(Date.parse(deployment.created_on))) {
      throw new Error('Invalid deployment history');
    }
  }
  const latest = [...deployments].sort(
    (a, b) => Date.parse(b.created_on) - Date.parse(a.created_on)
  )[0];
  if (
    !Array.isArray(latest.versions) ||
    latest.versions.length !== 1 ||
    latest.versions[0].percentage !== 100
  ) {
    throw new Error(
      'Production is split across versions; reconcile it before replacing it'
    );
  }
  if (
    deployments.filter(
      (entry) => Date.parse(entry.created_on) === Date.parse(latest.created_on)
    ).length !== 1
  ) {
    throw new Error(
      'Ambiguous latest deployment; inspect the active version before replacing it'
    );
  }
  return latest.versions[0].version_id;
}

export function deployedSource(version, surface, baseline) {
  const tag = version.annotations?.['workers/tag'];
  if (typeof tag === 'string' && /^git-[0-9a-f]{40}$/.test(tag))
    return tag.slice(4);
  const known = baseline[surface];
  if (!tag && version.id === known?.version && SHA.test(known.commit))
    return known.commit;
  throw new Error(
    'Production version has no recognized Git source. Reconcile and review that version before deploying'
  );
}

function wrangler(args, capture = false) {
  return execFileSync(
    process.execPath,
    [
      fileURLToPath(
        new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url)
      ),
      ...args,
    ],
    {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    }
  );
}

export function main(argv = process.argv.slice(2)) {
  const surface = argv.shift();
  if (!Object.hasOwn(CONFIGS, surface))
    throw new Error('Select root or artwork');
  let expectedHead;
  let mode = 'deploy';
  while (argv.length) {
    const flag = argv.shift();
    if (flag === '--expected-head') {
      expectedHead = argv.shift();
      if (!SHA.test(expectedHead ?? ''))
        throw new Error('Expected head must be a full Git SHA');
    } else if (
      ['--check', '--source-check', '--dry-run'].includes(flag) &&
      mode === 'deploy'
    )
      mode = flag.slice(2);
    else throw new Error(`Unsupported argument: ${flag}`);
  }
  const head = checkSource(expectedHead);
  if (mode === 'source-check') return;
  const config = CONFIGS[surface];
  if (mode !== 'dry-run') {
    const id = activeDeployment(
      JSON.parse(
        wrangler(['deployments', 'list', '-c', config, '--json'], true)
      )
    );
    const version = JSON.parse(
      wrangler(['versions', 'view', id, '-c', config, '--json'], true)
    );
    if (version.id !== id)
      throw new Error('Version lookup does not match the active deployment');
    const baseline = JSON.parse(
      readFileSync(
        new URL('./deployment-baseline.json', import.meta.url),
        'utf8'
      )
    );
    const source = deployedSource(version, surface, baseline);
    git(['merge-base', '--is-ancestor', source, head]);
    console.log(
      JSON.stringify({ surface, version: id, source, intendedSource: head })
    );
    if (mode === 'check') return;
  }
  // Build the tracked processor identity before upload so a stale generated
  // hash cannot be silently published under the clean commit's source tag.
  if (surface === 'artwork')
    execFileSync(process.execPath, ['scripts/cd-artwork/build.mjs'], {
      cwd: ROOT,
      stdio: 'inherit',
    });
  checkSource(head);
  wrangler([
    'deploy',
    '-c',
    config,
    '--tag',
    `git-${head}`,
    '--message',
    `Source: https://github.com/pdugan20/rewind/commit/${head}`,
    ...(mode === 'dry-run' ? ['--dry-run'] : []),
  ]);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    main();
  } catch (error) {
    // Captured provider output may include account details. Report the guard
    // failure without copying CLI buffers into shared logs.
    console.error(
      `[deploy-worker] ${error.status !== undefined ? 'Git or Wrangler verification failed; inspect the target read-only before retrying' : error.message}`
    );
    process.exitCode = 1;
  }
}
