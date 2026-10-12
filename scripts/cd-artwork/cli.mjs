import fs from 'node:fs/promises';
import path from 'node:path';
import { registry } from './registry.mjs';
import { discover } from './discovery.mjs';

const [command, root, ...args] = process.argv.slice(2);
if (!command || !root)
  throw Error(
    'Usage: node scripts/cd-artwork/cli.mjs <ingest|status|due|recheck|review> <local-store> [arguments]'
  );
const store = await registry(root);
try {
  if (command === 'ingest') {
    const manifestPath = path.resolve(args[0]),
      manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    const dir = path.dirname(manifestPath),
      template = await fs.readFile(path.resolve(dir, manifest.template));
    const result = [];
    for (const entry of manifest.inputs) {
      const input = { ...entry };
      for (const key of ['sourcePath', 'masterPath', 'patchPath'])
        if (input[key]) input[key] = path.resolve(dir, input[key]);
      result.push(await store.ingest(input, template));
    }
    console.log(
      JSON.stringify(
        result.map(({ id, album, state, cacheHit, object_hash }) => ({
          id,
          album,
          state,
          cacheHit,
          object_hash,
        })),
        null,
        2
      )
    );
  } else if (command === 'status')
    console.log(JSON.stringify(store.snapshot(), null, 2));
  else if (command === 'due') console.log(JSON.stringify(store.due(), null, 2));
  else if (command === 'recheck') {
    // Explicit album or bounded due queue. Calls only public MB/CAA reads.
    const snapshot = store.snapshot();
    const albums = args[0]
      ? snapshot.albums.filter((a) => a.id === args[0])
      : store.due();
    if (args[0] && !albums.length) throw Error('Unknown album');
    for (const album of albums) {
      const result = await discover(JSON.parse(album.metadata).identity);
      console.log(
        JSON.stringify({
          album: album.id,
          ...store.recordDiscovery(album.id, result),
        })
      );
    }
  } else if (command === 'review') {
    const [id, decision, reviewer, activate] = args;
    store.review(id, decision, reviewer, {
      activate: activate === '--activate',
    });
    console.log(
      JSON.stringify({ id, decision, activated: activate === '--activate' })
    );
  } else throw Error('Unknown command');
} finally {
  store.close();
}
