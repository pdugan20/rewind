/**
 * Generate the per-domain MCP tool reference pages for the Mintlify docs.
 *
 * Source of truth: mcp-server/mcp-manifest.snapshot.json (the drift-checked
 * manifest of every registered tool with its description + JSON-Schema input).
 * Tool -> domain grouping is derived by scanning which mcp-server/src/tools/*.ts
 * (or server.ts) file registers each tool, so it cannot drift from the code.
 *
 * Output: docs-mintlify/reference/mcp-tools/{index,<domain>}.mdx
 *
 * Usage:
 *   npx tsx scripts/gen-mcp-reference.ts          # write the pages
 *   npx tsx scripts/gen-mcp-reference.ts --check   # fail if pages are stale
 *
 * These pages are GENERATED -- never hand-edit them. Change the tool
 * (and run `npm run mcp:update` to refresh the manifest), then regenerate.
 */

import {
  readFileSync,
  writeFileSync,
  readdirSync,
  mkdirSync,
  unlinkSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = join(ROOT, 'mcp-server', 'mcp-manifest.snapshot.json');
const TOOLS_DIR = join(ROOT, 'mcp-server', 'src', 'tools');
const SERVER_TS = join(ROOT, 'mcp-server', 'src', 'server.ts');
const OUT_DIR = join(ROOT, 'docs-mintlify', 'reference', 'mcp-tools');

interface JsonSchema {
  type?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: (string | number)[];
  default?: unknown;
}
interface Tool {
  name: string;
  description: string;
  inputSchema?: JsonSchema;
}

// Display order + frontmatter for each domain group. `server`-registered
// tools (get_health) are folded into the cross-domain group.
const DOMAINS: {
  key: string;
  title: string;
  icon: string;
  description: string;
}[] = [
  {
    key: 'listening',
    title: 'Listening',
    icon: 'headphones',
    description:
      'MCP tools for your Last.fm and Apple Music listening history.',
  },
  {
    key: 'running',
    title: 'Running',
    icon: 'person-running',
    description: 'MCP tools for your Strava running activities and stats.',
  },
  {
    key: 'watching',
    title: 'Watching',
    icon: 'film',
    description: 'MCP tools for your Plex and Letterboxd movie and TV history.',
  },
  {
    key: 'reading',
    title: 'Reading',
    icon: 'book-open',
    description: 'MCP tools for your Instapaper articles and highlights.',
  },
  {
    key: 'collecting',
    title: 'Collecting',
    icon: 'record-vinyl',
    description:
      'MCP tools for your Discogs vinyl and physical media collections.',
  },
  {
    key: 'attending',
    title: 'Attending',
    icon: 'ticket',
    description: 'MCP tools for the live events and games you have attended.',
  },
  {
    key: 'cross-domain',
    title: 'Cross-domain',
    icon: 'layer-group',
    description:
      'Search, feed, on-this-day, and health tools that span every domain.',
  },
];
// server.ts registrations live with the cross-domain group in the docs.
const FOLD_INTO: Record<string, string> = { server: 'cross-domain' };

function loadManifest(): Tool[] {
  const m = JSON.parse(readFileSync(MANIFEST, 'utf8')) as { tools: Tool[] };
  return m.tools;
}

// name -> domain, from `registerTool('<name>'` in each tools file + server.ts.
function buildToolDomainMap(): Record<string, string> {
  const map: Record<string, string> = {};
  const files = [
    ...readdirSync(TOOLS_DIR)
      .filter(
        (f) =>
          f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'helpers.ts'
      )
      .map((f) => ({ path: join(TOOLS_DIR, f), domain: f.replace('.ts', '') })),
    { path: SERVER_TS, domain: 'server' },
  ];
  for (const { path, domain } of files) {
    const txt = readFileSync(path, 'utf8');
    const re = /registerTool\(\s*['"]([a-z_]+)['"]/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(txt)) !== null) {
      map[match[1]] = FOLD_INTO[domain] ?? domain;
    }
  }
  return map;
}

// MDX treats `{` as an expression and `<` as a tag opener. Tool descriptions
// are plain English that may contain either (e.g. "period in {7day, 1month}"
// or "progress < 0.75"), so escape them with a backslash -- but only OUTSIDE
// inline code spans, where backticks already make them literal.
function escapeMdx(text: string): string {
  let out = '';
  let inCode = false;
  for (const ch of text) {
    if (ch === '`') inCode = !inCode;
    else if (!inCode && (ch === '{' || ch === '}' || ch === '<')) out += '\\';
    out += ch;
  }
  return out;
}

function paramLine(
  name: string,
  schema: JsonSchema,
  required: boolean
): string {
  let type = schema.type ?? 'string';
  if (type === 'array') type = `${schema.items?.type ?? 'string'}[]`;
  let desc = (schema.description ?? '').trim();
  if (schema.enum && schema.enum.length > 0) {
    desc += `${desc ? ' ' : ''}One of: ${schema.enum.map((e) => `\`${e}\``).join(', ')}.`;
  }
  if (schema.default !== undefined) {
    desc += `${desc ? ' ' : ''}Defaults to \`${String(schema.default)}\`.`;
  }
  const req = required ? ' required' : '';
  return `<ParamField path="${name}" type="${type}"${req}>\n${escapeMdx(desc) || 'No description.'}\n</ParamField>`;
}

// A tool's `description` is written for the model: the first sentence is a
// human summary, the rest is steering (examples, anti-hallucination notes).
// Reference pages show only that first sentence; the full text stays in the
// tool definition where the model reads it.
function summarize(description: string): string {
  // Break at the first sentence end, allowing the next chunk to start with a
  // markdown/quote marker (these descriptions follow sentence one with bold
  // steering like ". **Use this when...**").
  const first = description
    .trim()
    .split(/\.\s+(?=[*_`"A-Z])/)[0]
    .trim();
  return /[.!?]$/.test(first) ? first : `${first}.`;
}

function toolSection(tool: Tool): string {
  const lines: string[] = [
    `## \`${tool.name}\``,
    '',
    escapeMdx(summarize(tool.description)),
    '',
  ];
  const props = tool.inputSchema?.properties ?? {};
  const required = new Set(tool.inputSchema?.required ?? []);
  const names = Object.keys(props).sort();
  if (names.length === 0) {
    lines.push('This tool takes no parameters.', '');
  } else {
    for (const n of names) {
      lines.push(paramLine(n, props[n], required.has(n)), '');
    }
  }
  return lines.join('\n');
}

function domainPage(
  domain: { key: string; title: string; icon: string; description: string },
  tools: Tool[]
): string {
  const fm = [
    '---',
    `title: ${domain.title}`,
    `icon: ${domain.icon}`,
    `description: ${domain.description}`,
    '---',
    '',
    '{/* Generated by scripts/gen-mcp-reference.ts. Do not edit by hand; change the tool and run `npm run docs:gen-mcp`. */}',
    '',
  ].join('\n');
  const body = tools
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(toolSection)
    .join('\n');
  return `${fm}\n${body}`.replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

function generate(): Record<string, string> {
  const tools = loadManifest();
  const toolDomain = buildToolDomainMap();
  const byDomain: Record<string, Tool[]> = {};
  for (const t of tools) {
    const d = toolDomain[t.name] ?? 'cross-domain';
    (byDomain[d] ??= []).push(t);
  }
  // One page per domain. The Tools nav group itself is the index, so there is
  // no generated overview page (the MCP overview covers the concept).
  const files: Record<string, string> = {};
  for (const d of DOMAINS) {
    files[`${d.key}.mdx`] = domainPage(d, byDomain[d.key] ?? []);
  }
  return files;
}

function main(): void {
  const check = process.argv.includes('--check');
  const files = generate();
  mkdirSync(OUT_DIR, { recursive: true });
  let stale = false;
  for (const [name, content] of Object.entries(files)) {
    const path = join(OUT_DIR, name);
    let current = '';
    try {
      current = readFileSync(path, 'utf8');
    } catch {
      current = '';
    }
    if (current !== content) {
      stale = true;
      if (check) {
        console.error(`[STALE] ${name} differs from generated output`);
      } else {
        writeFileSync(path, content);
        console.log(`[WRITE] reference/mcp-tools/${name}`);
      }
    }
  }
  // The dir is fully generated, so remove any page we no longer emit.
  for (const name of readdirSync(OUT_DIR)) {
    if (name.endsWith('.mdx') && !(name in files)) {
      stale = true;
      if (check) {
        console.error(`[STALE] ${name} is not generated and should be removed`);
      } else {
        unlinkSync(join(OUT_DIR, name));
        console.log(`[REMOVE] reference/mcp-tools/${name}`);
      }
    }
  }
  if (check && stale) {
    console.error('MCP tool reference is stale. Run: npm run docs:gen-mcp');
    process.exit(1);
  }
  if (check) console.log('MCP tool reference is up to date.');
  if (!check && !stale) console.log('MCP tool reference already up to date.');
}

main();
