import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const METHODS = new Set([
  'get',
  'put',
  'post',
  'delete',
  'options',
  'head',
  'patch',
  'trace',
]);

function filesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

function navPages(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(navPages);
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) =>
    [
      'pages',
      'tabs',
      'groups',
      'dropdowns',
      'anchors',
      'versions',
      'languages',
    ].includes(key)
      ? navPages(child)
      : []
  );
}

/** Read-only checks. Pass a fixture root in tests; never import product runtime. */
export function checkDocs(root = ROOT) {
  const errors = [];
  const read = (path) => readFileSync(join(root, path), 'utf8');
  const spec = JSON.parse(read('openapi.snapshot.json'));
  if (read('openapi.snapshot.json') !== read('docs-mintlify/openapi.json')) {
    errors.push('OpenAPI snapshots differ. Run npm run spec:update.');
  }
  const publicOperations = new Set();
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const [method, operation] of Object.entries(item)) {
      if (METHODS.has(method) && !item['x-hidden'] && !operation['x-hidden']) {
        publicOperations.add(`${method} ${path}`);
      }
    }
  }
  const pages = navPages(
    JSON.parse(read('docs-mintlify/docs.json')).navigation
  );
  const nav = new Set(pages);
  for (const page of pages) {
    if (/^https?:\/\//.test(page)) continue;
    if (!existsSync(join(root, 'docs-mintlify', `${page}.mdx`))) {
      errors.push(`Navigation page does not exist: ${page}`);
    }
  }
  const documented = new Set();
  for (const file of filesUnder(join(root, 'docs-mintlify'))) {
    if (!file.endsWith('.mdx')) continue;
    const source = readFileSync(file, 'utf8');
    const frontmatter = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    if (!frontmatter) continue;
    const metadata = parse(frontmatter[1]);
    if (metadata?.openapi === undefined) continue;
    const binding = String(metadata.openapi).trim();
    const match = binding.match(
      /^(get|put|post|delete|options|head|patch|trace)\s+(\/\S+)$/i
    );
    if (!match) {
      errors.push(`Unsupported OpenAPI binding in ${file}: ${binding}`);
      continue;
    }
    const method = match[1].toLowerCase();
    const path = match[2];
    const key = `${method} ${path}`;
    if (!spec.paths[path]?.[method]) errors.push(`Stale API binding: ${key}`);
    else if (!publicOperations.has(key))
      errors.push(`Hidden API operation exposed in docs: ${key}`);
    const page = file
      .slice(join(root, 'docs-mintlify').length + 1, -4)
      .replaceAll('\\', '/');
    if (!nav.has(page))
      errors.push(`API page is missing from navigation: ${page}`);
    else {
      if (documented.has(key)) errors.push(`Duplicate API binding: ${key}`);
      documented.add(key);
    }
  }
  for (const key of publicOperations) {
    if (!documented.has(key))
      errors.push(`Public API operation is undocumented: ${key}`);
  }

  // The generator can otherwise silently omit tools assigned to a new domain.
  const manifest = JSON.parse(read('mcp-server/mcp-manifest.snapshot.json'));
  const headings = new Set();
  for (const file of filesUnder(
    join(root, 'docs-mintlify/reference/mcp-tools')
  )) {
    if (!file.endsWith('.mdx')) continue;
    const page = file
      .slice(join(root, 'docs-mintlify').length + 1, -4)
      .replaceAll('\\', '/');
    if (!nav.has(page))
      errors.push(`MCP reference is missing from navigation: ${page}`);
    for (const match of readFileSync(file, 'utf8').matchAll(
      /^## `([^`]+)`\s*$/gm
    )) {
      if (headings.has(match[1]))
        errors.push(`Duplicate MCP tool documentation: ${match[1]}`);
      headings.add(match[1]);
    }
  }
  const tools = new Set(manifest.tools.map((tool) => tool.name));
  for (const tool of tools) {
    if (!headings.has(tool)) errors.push(`MCP tool is undocumented: ${tool}`);
  }
  for (const tool of headings) {
    if (!tools.has(tool)) errors.push(`Stale MCP tool documentation: ${tool}`);
  }

  // Check the maintained index, not historical prose and archived command examples.
  const index = read('docs/README.md');
  const links = [...index.matchAll(/\]\(([^\s)]+)\)/g)].map(
    (match) => match[1]
  );
  for (const target of links) {
    if (/^(?:[a-z]+:|#)/i.test(target)) continue;
    if (!existsSync(resolve(root, 'docs', target.split('#')[0]))) {
      errors.push(`Broken docs index link: ${target}`);
    }
  }
  for (const directory of ['projects', 'projects/archived']) {
    for (const entry of readdirSync(join(root, 'docs', directory), {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory() || entry.name === 'archived') continue;
      const prefix = `${directory}/${entry.name}/`;
      if (!links.some((target) => target.startsWith(prefix))) {
        errors.push(`Project missing from docs index: ${prefix}`);
      }
    }
  }
  return errors;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const errors = checkDocs();
    if (errors.length) {
      for (const error of errors) console.error(`[DOCS] ${error}`);
      process.exitCode = 1;
    } else {
      console.log(
        'Documentation coverage, navigation, snapshots, and project index are current.'
      );
    }
  } catch (error) {
    console.error(`[DOCS] ${error.message}`);
    process.exitCode = 1;
  }
}
