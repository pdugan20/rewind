import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { JSDOM } from 'jsdom';

for (const page of ['privacy', 'terms', 'dpa']) {
  const source = readFileSync(
    new URL(`../docs-site/src/pages/${page}.mdx`, import.meta.url),
    'utf8'
  );
  const frontmatter = parse(source.match(/^---\n([\s\S]*?)\n---/)[1]);
  const html = readFileSync(
    new URL(`../docs-site/dist/${page}/index.html`, import.meta.url),
    'utf8'
  );
  assert.ok(
    frontmatter.title && frontmatter.lastUpdated,
    `${page}: missing policy metadata`
  );
  const document = new JSDOM(html).window.document;
  assert.equal(
    document.title,
    `${frontmatter.title} - Rewind`,
    `${page}: missing rendered title`
  );
  assert.equal(
    document.querySelector('h1')?.textContent,
    frontmatter.title,
    `${page}: missing visible heading`
  );
  assert.equal(
    document.querySelector('.updated')?.textContent,
    `Last updated: ${frontmatter.lastUpdated}`,
    `${page}: missing update date`
  );
  assert.equal(
    document.querySelectorAll(
      'link[rel=stylesheet][href^="/"], script[src^="/"]'
    ).length,
    0,
    `${page}: apex policy proxy needs a route for new local assets`
  );
}
console.log(
  'All three built policy pages have titles, headings, and update dates.'
);
