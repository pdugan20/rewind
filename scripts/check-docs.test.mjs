import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkDocs } from './check-docs.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'rewind-docs-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (file, content) => {
    mkdirSync(join(root, file, '..'), { recursive: true });
    writeFileSync(
      join(root, file),
      typeof content === 'string' ? content : JSON.stringify(content)
    );
  };
  const spec = {
    paths: {
      '/v1/example': { get: {} },
      '/v1/admin/example': { post: { 'x-hidden': true } },
    },
  };
  const saveSpec = () => {
    write('openapi.snapshot.json', spec);
    write('docs-mintlify/openapi.json', spec);
  };
  saveSpec();
  const nav = {
    navigation: {
      tabs: [
        {
          tab: 'API',
          groups: [
            { pages: ['api-reference/example', 'reference/mcp-tools/example'] },
          ],
        },
      ],
    },
  };
  const saveNav = () => write('docs-mintlify/docs.json', nav);
  saveNav();
  write(
    'docs-mintlify/api-reference/example.mdx',
    '---\nopenapi: "GET /v1/example"\n---\n'
  );
  write('docs-mintlify/reference/mcp-tools/example.mdx', '## `get_example`\n');
  write('mcp-server/mcp-manifest.snapshot.json', {
    tools: [{ name: 'get_example' }],
  });
  write('docs/projects/example/README.md', '# Example\n');
  write('docs/projects/archived/old/README.md', '# Historical\n');
  write(
    'docs/README.md',
    '[Example](projects/example/README.md)\n[Old](projects/archived/old/README.md)\n'
  );
  return {
    root,
    write,
    spec,
    saveSpec,
    nav,
    saveNav,
    check: () => checkDocs(root),
  };
}

test('accepts complete coverage, quoted uppercase bindings, and hidden admin operations', (t) => {
  assert.deepEqual(fixture(t).check(), []);
});

test('adding a public operation requires documentation even if snapshots match', (t) => {
  const f = fixture(t);
  f.spec.paths['/v1/new'] = { get: {} };
  f.saveSpec();
  assert.ok(
    f.check().includes('Public API operation is undocumented: get /v1/new')
  );
});

test('a file on disk is not coverage when it is missing from navigation', (t) => {
  const f = fixture(t);
  f.nav.navigation.tabs[0].groups[0].pages.shift();
  f.saveNav();
  assert.ok(
    f.check().includes('Public API operation is undocumented: get /v1/example')
  );
});

test('deleted operations, exposed admin operations, and duplicate bindings fail', (t) => {
  const f = fixture(t);
  f.write(
    'docs-mintlify/api-reference/stale.mdx',
    '---\nopenapi: get /v1/removed\n---\n'
  );
  f.write(
    'docs-mintlify/api-reference/admin.mdx',
    '---\nopenapi: post /v1/admin/example\n---\n'
  );
  f.write(
    'docs-mintlify/api-reference/duplicate.mdx',
    '---\nopenapi: get /v1/example\n---\n'
  );
  f.nav.navigation.tabs[0].groups[0].pages.push(
    'api-reference/stale',
    'api-reference/admin',
    'api-reference/duplicate'
  );
  f.saveNav();
  const errors = f.check();
  for (const message of [
    'Stale API binding: get /v1/removed',
    'Hidden API operation exposed in docs: post /v1/admin/example',
    'Duplicate API binding: get /v1/example',
  ]) {
    assert.ok(errors.includes(message), message);
  }
});

test('missing nav targets and divergent snapshots fail', (t) => {
  const f = fixture(t);
  f.nav.navigation.tabs[0].groups[0].pages.push('missing');
  f.saveNav();
  f.write('docs-mintlify/openapi.json', { paths: {} });
  assert.ok(f.check().some((e) => e.startsWith('OpenAPI snapshots differ')));
  assert.ok(f.check().includes('Navigation page does not exist: missing'));
});

test('malformed YAML fails instead of silently skipping a reference', (t) => {
  const f = fixture(t);
  f.write('docs-mintlify/api-reference/example.mdx', '---\nopenapi: [\n---\n');
  assert.throws(f.check);
});

test('new-domain tools cannot disappear from generated docs', (t) => {
  const f = fixture(t);
  f.write('mcp-server/mcp-manifest.snapshot.json', {
    tools: [{ name: 'get_new_domain' }],
  });
  assert.ok(f.check().includes('MCP tool is undocumented: get_new_domain'));
  assert.ok(f.check().includes('Stale MCP tool documentation: get_example'));
});

test('new projects and removed index targets fail', (t) => {
  const f = fixture(t);
  f.write('docs/projects/new/README.md', '# New\n');
  rmSync(join(f.root, 'docs/projects/example/README.md'));
  assert.ok(
    f.check().includes('Project missing from docs index: projects/new/')
  );
  assert.ok(
    f.check().includes('Broken docs index link: projects/example/README.md')
  );
});

test('nested navigation groups are traversed', (t) => {
  const f = fixture(t);
  const pages = f.nav.navigation.tabs[0].groups[0].pages;
  f.nav.navigation = {
    versions: [
      {
        version: 'v1',
        languages: [
          { language: 'en', tabs: [{ pages: [{ group: 'Nested', pages }] }] },
        ],
      },
    ],
  };
  f.saveNav();
  assert.deepEqual(f.check(), []);
});

test('unsupported binding syntax cannot bypass coverage', (t) => {
  const f = fixture(t);
  f.write(
    'docs-mintlify/api-reference/example.mdx',
    '---\nopenapi: example.json get /v1/example\n---\n'
  );
  assert.ok(f.check().some((e) => e.startsWith('Unsupported OpenAPI binding')));
});
