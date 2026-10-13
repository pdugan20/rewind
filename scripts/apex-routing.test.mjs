import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker from '../apex-worker/src/worker.ts';

test('policy URLs serve Pages content without forwarding private request data', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    return new Response('<h1>Policy</h1>', {
      headers: { 'content-type': 'text/html' },
    });
  });
  for (const path of [
    '/privacy',
    '/privacy/',
    '/terms',
    '/terms/',
    '/dpa',
    '/dpa/',
  ]) {
    const response = await worker.fetch(
      new Request(`https://rewind.rest${path}?private=value`, {
        headers: {
          Authorization: 'Bearer test-only',
          Cookie: 'session=test-only',
        },
      })
    );
    assert.equal(response.status, 200);
    assert.equal(await response.text(), '<h1>Policy</h1>');
    assert.deepEqual(calls.at(-1), {
      url: `https://rewind-www.pages.dev${path.replace(/\/$/, '')}/`,
      options: { method: 'GET' },
    });
  }
  await worker.fetch(
    new Request('https://rewind.rest/privacy/', { method: 'HEAD' })
  );
  assert.deepEqual(calls.at(-1).options, { method: 'HEAD' });
  const count = calls.length;
  const rejected = await worker.fetch(
    new Request('https://rewind.rest/dpa/', { method: 'POST', body: 'private' })
  );
  assert.equal(rejected.status, 405);
  assert.equal(rejected.headers.get('allow'), 'GET, HEAD');
  assert.equal(calls.length, count);
});

test('home, transparent icons, and ordinary docs redirects retain their routes', async () => {
  const home = await worker.fetch(new Request('https://rewind.rest/'));
  const html = await home.text();
  assert.match(html, /href="\/privacy\/"/);
  assert.match(html, /href="\/favicon.ico"/);
  assert.doesNotMatch(html, /apple-touch/);
  const icon = await worker.fetch(
    new Request('https://rewind.rest/favicon.svg')
  );
  assert.equal(icon.headers.get('content-type'), 'image/svg+xml');
  assert.equal(
    (
      await worker.fetch(
        new Request('https://rewind.rest/apple-touch-icon.png')
      )
    ).status,
    404
  );
  const docs = await worker.fetch(
    new Request('https://rewind.rest/quickstart?example=1')
  );
  assert.equal(docs.status, 302);
  assert.equal(
    docs.headers.get('location'),
    'https://docs.rewind.rest/quickstart?example=1'
  );
});
