import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY_PATH = join(ROOT, '.github', 'security-exceptions.json');
const REPOSITORY = 'pdugan20/rewind';
const REPOSITORY_ID = 1178236034;

const REGISTRY_KEYS = new Set(['schemaVersion', 'exceptions']);
const EXCEPTION_KEYS = new Set([
  'alertNumber',
  'owner',
  'dismissalReason',
  'reason',
  'dismissedAt',
  'reviewedAt',
  'expiresAt',
  'package',
  'manifestPath',
  'lockedVersion',
  'scope',
  'relationship',
  'advisory',
  'dependencyPath',
]);
const PACKAGE_KEYS = new Set(['ecosystem', 'name']);
const ADVISORY_KEYS = new Set(['ghsa', 'cve', 'vulnerableVersionRange']);
const PATH_ENTRY_KEYS = new Set(['name', 'version']);

function exactKeys(value, expected, label, problems) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    problems.push(`${label} must be an object`);
    return false;
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    problems.push(`${label} keys must be exactly ${wanted.join(', ')}`);
    return false;
  }
  return true;
}

function lockPathFor(name) {
  return `node_modules/${name}`;
}

function parseStableSemver(version) {
  const match = String(version).match(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
  );
  if (!match) throw new Error(`unsupported non-stable semver: ${version}`);
  return match.slice(1).map(Number);
}

function compareStableSemver(left, right) {
  const a = parseStableSemver(left);
  const b = parseStableSemver(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

function vulnerableCeiling(range) {
  const match = String(range).match(/^<=\s*(\d+\.\d+\.\d+)$/);
  if (!match) throw new Error(`unsupported vulnerable range: ${range}`);
  return match[1];
}

function validateDependencyPath(exception, lockfile, label, problems) {
  const packages = lockfile?.packages;
  if (
    lockfile?.lockfileVersion !== 3 ||
    !packages ||
    typeof packages !== 'object' ||
    Array.isArray(packages)
  ) {
    problems.push(`${label} requires an npm lockfileVersion 3 package graph`);
    return;
  }

  const path = exception.dependencyPath;
  if (!Array.isArray(path) || path.length < 2) {
    problems.push(`${label}.dependencyPath must contain a transitive path`);
    return;
  }
  for (const [index, entry] of path.entries()) {
    if (
      !exactKeys(
        entry,
        PATH_ENTRY_KEYS,
        `${label}.dependencyPath[${index}]`,
        problems
      )
    ) {
      continue;
    }
    if (typeof entry.name !== 'string' || typeof entry.version !== 'string') {
      problems.push(
        `${label}.dependencyPath[${index}] must name an exact version`
      );
      continue;
    }
    const locked = packages[lockPathFor(entry.name)];
    if (!locked || locked.version !== entry.version) {
      problems.push(
        `${label}.dependencyPath[${index}] no longer resolves ${entry.name}@${entry.version}`
      );
      continue;
    }
    if (locked.dev !== true) {
      problems.push(
        `${label}.dependencyPath[${index}] is no longer development-only`
      );
    }
  }

  const root = packages[''] ?? {};
  const first = path[0]?.name;
  if (
    root.devDependencies?.[first] === undefined ||
    root.dependencies?.[first] !== undefined ||
    root.optionalDependencies?.[first] !== undefined
  ) {
    problems.push(
      `${label}.dependencyPath must begin at an exact root devDependency`
    );
  }

  for (let index = 0; index < path.length - 1; index += 1) {
    const parent = packages[lockPathFor(path[index].name)] ?? {};
    const childName = path[index + 1].name;
    if (
      parent.dependencies?.[childName] === undefined &&
      parent.optionalDependencies?.[childName] === undefined
    ) {
      problems.push(
        `${label}.dependencyPath edge ${path[index].name} -> ${childName} no longer exists`
      );
    }
  }

  const targetName = exception.package?.name;
  const target = path.at(-1);
  if (
    target?.name !== targetName ||
    target?.version !== exception.lockedVersion
  ) {
    problems.push(
      `${label}.dependencyPath must terminate at the locked vulnerable package`
    );
  }
  const rootSections = [
    root.dependencies,
    root.devDependencies,
    root.optionalDependencies,
  ];
  if (rootSections.some((section) => section?.[targetName] !== undefined)) {
    problems.push(`${label} is no longer transitive`);
  }

  const targetEntries = Object.entries(packages).filter(([packagePath]) =>
    packagePath.endsWith(`node_modules/${targetName}`)
  );
  if (targetEntries.length !== 1) {
    problems.push(
      `${label} must resolve exactly one vulnerable package instance`
    );
  }
  for (const [, locked] of targetEntries) {
    if (locked.version !== exception.lockedVersion || locked.dev !== true) {
      problems.push(
        `${label} vulnerable package version or development scope changed`
      );
    }
  }
}

export function validateSecurityExceptionRegistry({
  registry,
  lockfile,
  now = new Date(),
}) {
  const problems = [];
  if (!exactKeys(registry, REGISTRY_KEYS, 'registry', problems))
    return problems;
  if (registry.schemaVersion !== 1)
    problems.push('registry.schemaVersion must be 1');
  if (!Array.isArray(registry.exceptions)) {
    problems.push('registry.exceptions must be an array');
    return problems;
  }

  const alertNumbers = new Set();
  for (const [index, exception] of registry.exceptions.entries()) {
    const label = `registry.exceptions[${index}]`;
    if (!exactKeys(exception, EXCEPTION_KEYS, label, problems)) continue;
    if (
      !Number.isInteger(exception.alertNumber) ||
      exception.alertNumber <= 0
    ) {
      problems.push(`${label}.alertNumber must be a positive integer`);
    } else if (alertNumbers.has(exception.alertNumber)) {
      problems.push(`${label}.alertNumber must be unique`);
    }
    alertNumbers.add(exception.alertNumber);
    if (!/^[A-Za-z0-9-]+$/.test(exception.owner ?? '')) {
      problems.push(`${label}.owner must name an accountable GitHub owner`);
    }
    if (exception.dismissalReason !== 'tolerable_risk') {
      problems.push(`${label}.dismissalReason must remain tolerable_risk`);
    }
    if (typeof exception.reason !== 'string' || exception.reason.length < 80) {
      problems.push(`${label}.reason must record the bounded risk rationale`);
    }
    const dismissedAt = Date.parse(exception.dismissedAt);
    const reviewedAt = Date.parse(exception.reviewedAt);
    const expiresAt = Date.parse(exception.expiresAt);
    if (
      !Number.isFinite(dismissedAt) ||
      !Number.isFinite(reviewedAt) ||
      !Number.isFinite(expiresAt)
    ) {
      problems.push(
        `${label} must use valid ISO dismissal, review, and expiry timestamps`
      );
    } else {
      if (reviewedAt < dismissedAt || reviewedAt > now.getTime()) {
        problems.push(
          `${label}.reviewedAt must follow dismissal and not be future-dated`
        );
      }
      if (expiresAt <= reviewedAt) {
        problems.push(`${label}.expiresAt must follow the latest review`);
      }
      if (expiresAt - reviewedAt > 32 * 24 * 60 * 60 * 1000) {
        problems.push(`${label}.expiresAt must be within 32 days of review`);
      }
      if (now.getTime() >= expiresAt)
        problems.push(`${label} is expired and requires re-evaluation`);
    }
    if (
      !exactKeys(exception.package, PACKAGE_KEYS, `${label}.package`, problems)
    ) {
      continue;
    }
    if (
      exception.package.ecosystem !== 'npm' ||
      typeof exception.package.name !== 'string' ||
      !exception.package.name
    ) {
      problems.push(`${label}.package must identify an npm dependency`);
    }
    if (
      exception.manifestPath !== 'package-lock.json' ||
      exception.scope !== 'development' ||
      exception.relationship !== 'transitive'
    ) {
      problems.push(
        `${label} must remain a transitive development-only root-lock exception`
      );
    }
    if (
      !exactKeys(
        exception.advisory,
        ADVISORY_KEYS,
        `${label}.advisory`,
        problems
      )
    ) {
      continue;
    }
    if (!/^GHSA-[a-z0-9-]+$/.test(exception.advisory.ghsa ?? '')) {
      problems.push(`${label}.advisory.ghsa must be a GHSA identifier`);
    }
    if (!/^CVE-\d{4}-\d+$/.test(exception.advisory.cve ?? '')) {
      problems.push(`${label}.advisory.cve must be a CVE identifier`);
    }
    try {
      const ceiling = vulnerableCeiling(
        exception.advisory.vulnerableVersionRange
      );
      if (ceiling !== exception.lockedVersion) {
        problems.push(
          `${label} locked version must equal the vulnerable range ceiling`
        );
      }
      parseStableSemver(exception.lockedVersion);
    } catch (error) {
      problems.push(`${label}: ${error.message}`);
    }
    validateDependencyPath(exception, lockfile, label, problems);
  }
  return problems;
}

async function fetchResponse(url, { fetchImpl, token }) {
  const headers = {
    Accept: url.startsWith('https://api.github.com/')
      ? 'application/vnd.github+json'
      : 'application/json',
    'User-Agent': 'rewind-security-exception-check',
  };
  if (url.startsWith('https://api.github.com/')) {
    headers['X-GitHub-Api-Version'] = '2026-03-10';
  }
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetchImpl(url, {
    headers,
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return { data: await response.json(), headers: response.headers };
}

async function fetchJson(url, options) {
  return (await fetchResponse(url, options)).data;
}

async function fetchDismissedAlerts({ fetchImpl, token }) {
  const alerts = [];
  const visited = new Set();
  let url = `https://api.github.com/repos/${REPOSITORY}/dependabot/alerts?state=dismissed&per_page=100`;
  for (let page = 1; page <= 100; page += 1) {
    if (visited.has(url)) throw new Error('dismissed alert pagination looped');
    visited.add(url);
    const { data: batch, headers } = await fetchResponse(url, {
      fetchImpl,
      token,
    });
    if (!Array.isArray(batch)) {
      throw new Error('dismissed alert inventory was not an array');
    }
    alerts.push(...batch);
    const link = headers?.get?.('link') ?? headers?.get?.('Link') ?? '';
    const next = String(link)
      .split(',')
      .map((entry) => entry.trim())
      .find((entry) => /;\s*rel="next"$/.test(entry));
    if (!next) return alerts;
    const match = next.match(/^<([^>]+)>;\s*rel="next"$/);
    if (!match) throw new Error('dismissed alert next link was malformed');
    const candidate = new URL(match[1]);
    const allowedKeys = new Set(['state', 'per_page', 'after']);
    const allowedPaths = new Set([
      `/repos/${REPOSITORY}/dependabot/alerts`,
      `/repositories/${REPOSITORY_ID}/dependabot/alerts`,
    ]);
    if (
      candidate.origin !== 'https://api.github.com' ||
      !allowedPaths.has(candidate.pathname) ||
      candidate.searchParams.get('state') !== 'dismissed' ||
      candidate.searchParams.get('per_page') !== '100' ||
      !candidate.searchParams.get('after') ||
      [...candidate.searchParams.keys()].some((key) => !allowedKeys.has(key))
    ) {
      throw new Error('dismissed alert next link left the exact inventory');
    }
    url = candidate.href;
  }
  throw new Error('dismissed alert inventory exceeded 100 pages');
}

function reconcileDismissedAlerts(registry, alerts, problems) {
  const liveNumbers = alerts.map((alert) => alert?.number);
  if (
    new Set(liveNumbers).size !== liveNumbers.length ||
    liveNumbers.some((number) => !Number.isInteger(number))
  ) {
    problems.push(
      'dismissed alert inventory contains invalid or duplicate numbers'
    );
    return;
  }
  const registeredNumbers = registry.exceptions.map(
    (exception) => exception.alertNumber
  );
  if (
    JSON.stringify([...liveNumbers].sort((left, right) => left - right)) !==
    JSON.stringify([...registeredNumbers].sort((left, right) => left - right))
  ) {
    problems.push(
      'dismissed alert inventory must exactly match the registered exceptions'
    );
  }

  for (const exception of registry.exceptions) {
    const label = `alert #${exception.alertNumber}`;
    const alert = alerts.find(
      (candidate) => candidate?.number === exception.alertNumber
    );
    if (!alert) continue;
    const vulnerability = alert.security_vulnerability;
    if (
      alert.state !== 'dismissed' ||
      alert.dismissed_at !== exception.dismissedAt ||
      alert.dismissed_by?.login !== exception.owner ||
      alert.dismissed_reason !== exception.dismissalReason ||
      alert.dismissed_comment !== exception.reason ||
      alert.fixed_at !== null ||
      alert.auto_dismissed_at !== null ||
      alert.dependency?.package?.ecosystem !== exception.package.ecosystem ||
      alert.dependency?.package?.name !== exception.package.name ||
      alert.dependency?.manifest_path !== exception.manifestPath ||
      alert.dependency?.scope !== exception.scope ||
      alert.dependency?.relationship !== exception.relationship ||
      alert.security_advisory?.ghsa_id !== exception.advisory.ghsa ||
      alert.security_advisory?.cve_id !== exception.advisory.cve ||
      vulnerability?.package?.ecosystem !== exception.package.ecosystem ||
      vulnerability?.package?.name !== exception.package.name ||
      vulnerability?.vulnerable_version_range !==
        exception.advisory.vulnerableVersionRange ||
      vulnerability?.first_patched_version !== null
    ) {
      problems.push(`${label} repository dismissal metadata changed`);
    }
  }
}

export async function verifySecurityExceptionLifecycle({
  registry,
  lockfile,
  now = new Date(),
  fetchImpl = globalThis.fetch,
  token = process.env.GITHUB_TOKEN,
}) {
  const problems = validateSecurityExceptionRegistry({
    registry,
    lockfile,
    now,
  });
  if (problems.length > 0) return problems;

  try {
    const alerts = await fetchDismissedAlerts({ fetchImpl, token });
    reconcileDismissedAlerts(registry, alerts, problems);
  } catch (error) {
    problems.push(`dismissed alert inventory failed closed: ${error.message}`);
    return problems;
  }
  if (problems.length > 0) return problems;

  for (const exception of registry.exceptions) {
    const label = `alert #${exception.alertNumber}`;
    try {
      const advisory = await fetchJson(
        `https://api.github.com/advisories/${exception.advisory.ghsa}`,
        { fetchImpl, token }
      );
      if (
        advisory.ghsa_id !== exception.advisory.ghsa ||
        advisory.cve_id !== exception.advisory.cve ||
        advisory.withdrawn_at !== null
      ) {
        problems.push(`${label} advisory identity or status changed`);
      }
      const vulnerability = advisory.vulnerabilities?.find(
        (candidate) =>
          candidate?.package?.ecosystem === exception.package.ecosystem &&
          candidate?.package?.name === exception.package.name
      );
      if (!vulnerability) {
        problems.push(
          `${label} advisory no longer contains the registered package`
        );
      } else {
        if (
          vulnerability.vulnerable_version_range !==
          exception.advisory.vulnerableVersionRange
        ) {
          problems.push(`${label} vulnerable version range changed`);
        }
        if (vulnerability.first_patched_version !== null) {
          problems.push(
            `${label} now has a patched version and must be remediated`
          );
        }
      }

      const npmMetadata = await fetchJson(
        `https://registry.npmjs.org/${encodeURIComponent(exception.package.name)}`,
        { fetchImpl, token: undefined }
      );
      const versions = npmMetadata?.versions;
      if (
        !versions ||
        typeof versions !== 'object' ||
        Array.isArray(versions) ||
        !Object.hasOwn(versions, exception.lockedVersion)
      ) {
        problems.push(
          `${label} package registry metadata no longer contains the locked version`
        );
        continue;
      }
      const ceiling = vulnerableCeiling(
        exception.advisory.vulnerableVersionRange
      );
      const newerStable = Object.keys(versions).find((version) => {
        try {
          return compareStableSemver(version, ceiling) > 0;
        } catch {
          return false;
        }
      });
      if (newerStable) {
        problems.push(
          `${label} package registry contains ${newerStable}, newer than the vulnerable ceiling ${ceiling}`
        );
      }
    } catch (error) {
      problems.push(
        `${label} live re-evaluation failed closed: ${error.message}`
      );
    }
  }
  return problems;
}

async function main() {
  const registry = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));
  const firstException = registry.exceptions?.[0];
  const lockfile = firstException
    ? JSON.parse(
        readFileSync(join(ROOT, firstException.manifestPath ?? ''), 'utf8')
      )
    : null;
  const offline = process.argv.slice(2).includes('--offline');
  const problems = offline
    ? validateSecurityExceptionRegistry({ registry, lockfile })
    : await verifySecurityExceptionLifecycle({ registry, lockfile });
  if (problems.length > 0) {
    for (const problem of problems)
      console.error(`[security-exception] ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `[security-exception] ${registry.exceptions.length} exception(s) remain bounded${
      offline ? '' : ' and unpatched'
    }`
  );
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  await main();
}
