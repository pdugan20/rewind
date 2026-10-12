import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  VERSION,
  readPixels,
  png,
  checkGeometry,
  repairHub,
  applyTemplateHub,
} from './pixels.mjs';

export const hash = (bytes) =>
  crypto.createHash('sha256').update(bytes).digest('hex');
export function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, stable(value[k])])
    );
  return value;
}
export async function registry(root) {
  const processorHash = hash(
    Buffer.concat(
      await Promise.all([
        fs.readFile(new URL('./pixels.mjs', import.meta.url)),
        fs.readFile(new URL('./registry.mjs', import.meta.url)),
      ])
    )
  );
  await fs.mkdir(path.join(root, 'objects'), { recursive: true });
  await fs.mkdir(path.join(root, 'sources'), { recursive: true });
  const db = new DatabaseSync(path.join(root, 'registry.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS albums (id TEXT PRIMARY KEY, metadata TEXT NOT NULL, active TEXT, pinned INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS assets (id TEXT PRIMARY KEY, album TEXT NOT NULL REFERENCES albums(id), cache_key TEXT NOT NULL, origin TEXT NOT NULL, state TEXT NOT NULL, object_hash TEXT, provenance TEXT NOT NULL, created TEXT NOT NULL, UNIQUE(album,cache_key));
    CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, album TEXT NOT NULL, asset TEXT, action TEXT NOT NULL, reviewer TEXT, at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS discovery (album TEXT PRIMARY KEY REFERENCES albums(id), outcome TEXT NOT NULL, checked TEXT NOT NULL, next_check TEXT NOT NULL, evidence TEXT NOT NULL);
  `);
  async function object(bytes) {
    const id = hash(bytes),
      file = path.join(root, 'objects', id + '.png');
    try {
      await fs.writeFile(file, bytes, { flag: 'wx' });
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    if (hash(await fs.readFile(file)) !== id)
      throw Error('Cached object integrity failed');
    return id;
  }
  async function ingest(input, templateBytes) {
    if (
      !input.id ||
      !['retail_cd_face', 'album_cover', 'generic_cdr'].includes(input.origin)
    )
      throw Error('Identity and explicit source origin required');
    const original = await fs.readFile(input.sourcePath);
    const master = input.masterPath
      ? await fs.readFile(input.masterPath)
      : original;
    const patch = input.patchPath ? await fs.readFile(input.patchPath) : null;
    if (
      input.origin === 'album_cover' &&
      input.masterPath &&
      input.processing?.model &&
      (!input.processing.sourceHash || !input.processing.masterHash)
    )
      throw Error(
        'Prepared composition requires recorded source and master hashes'
      );
    if (
      input.processing?.sourceHash &&
      input.processing.sourceHash !== hash(original)
    )
      throw Error('Prepared composition does not match this source hash');
    if (
      input.processing?.masterHash &&
      input.processing.masterHash !== hash(master)
    )
      throw Error('Prepared composition hash differs from recorded output');
    for (const bytes of [
      original,
      master,
      patch,
      input.origin === 'album_cover' ? templateBytes : null,
    ].filter(Boolean)) {
      const file = path.join(root, 'sources', hash(bytes));
      try {
        await fs.writeFile(file, bytes, { flag: 'wx' });
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
      }
      if (hash(await fs.readFile(file)) !== hash(bytes))
        throw Error('Stored source integrity failed');
    }
    // Paths are not cache identity; source bytes, masks and processing settings are.
    const provenance = {
      source: input.source ?? null,
      identity: input.identity ?? null,
      sourceHash: hash(original),
      masterHash: hash(master),
      patchHash: patch ? hash(patch) : null,
      origin: input.origin,
      processing: input.processing ?? null,
      region: input.region ?? null,
      version: VERSION,
      processorHash,
      templateHash: input.origin === 'album_cover' ? hash(templateBytes) : null,
      materialEvidence: input.materialEvidence ?? null,
    };
    const key = hash(JSON.stringify(stable(provenance))),
      id = hash(input.id + ':' + key);
    db.prepare(
      'INSERT INTO albums(id,metadata) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET metadata=excluded.metadata'
    ).run(
      input.id,
      JSON.stringify({
        artist: input.artist,
        title: input.title,
        identity: input.identity ?? null,
      })
    );
    const existing = db.prepare('SELECT * FROM assets WHERE id=?').get(id);
    if (existing) {
      if (
        existing.object_hash &&
        hash(
          await fs.readFile(
            path.join(root, 'objects', existing.object_hash + '.png')
          )
        ) !== existing.object_hash
      )
        throw Error('Cached object integrity failed');
      return { ...existing, cacheHit: true };
    }
    const now = new Date().toISOString();
    let image = null,
      state = 'pending',
      verification = null;
    if (input.origin === 'album_cover') {
      if (!input.masterPath || !input.processing?.model) {
        const cover = readPixels(original);
        state =
          Math.max(cover.width, cover.height) < 660
            ? 'needs_better_source'
            : 'needs_composition';
      } else if (!checkGeometry(readPixels(master)).pass)
        state = 'needs_registration';
      else {
        const result = applyTemplateHub(
          readPixels(master),
          readPixels(templateBytes)
        );
        image = result.image;
        verification = result.verification;
      }
    } else if (!checkGeometry(readPixels(master)).pass) {
      state = 'needs_registration';
    } else if (
      input.origin === 'retail_cd_face' &&
      (!patch || !input.region || !input.materialEvidence)
    ) {
      state = 'needs_material_review';
    } else if (patch) {
      const result = repairHub(
        readPixels(master),
        readPixels(patch),
        input.region
      );
      image = result.image;
      verification = result.verification;
    } else {
      image = readPixels(master);
    }
    let objectHash = null;
    if (image) {
      const geometry = checkGeometry(image);
      if (!geometry.pass)
        throw Error(
          'Generated candidate fails geometry: ' + JSON.stringify(geometry)
        );
      provenance.verification = { ...verification, geometry };
      objectHash = await object(png(image));
    }
    db.prepare('INSERT OR IGNORE INTO assets VALUES(?,?,?,?,?,?,?,?)').run(
      id,
      input.id,
      key,
      input.origin,
      state,
      objectHash,
      JSON.stringify(provenance),
      now
    );
    // Cover/generic origins remain eligible for future retail discovery. No paid
    // generation happens during discovery, and no candidate activates itself.
    if (input.origin !== 'retail_cd_face')
      db.prepare('INSERT OR IGNORE INTO discovery VALUES(?,?,?,?,?)').run(
        input.id,
        'not_checked',
        now,
        now,
        '{}'
      );
    return {
      ...db.prepare('SELECT * FROM assets WHERE id=?').get(id),
      cacheHit: false,
    };
  }
  function review(id, decision, reviewer, { activate = false } = {}) {
    if (!['accepted', 'rejected'].includes(decision) || !reviewer?.trim())
      throw Error('Explicit decision and reviewer required');
    const asset = db.prepare('SELECT * FROM assets WHERE id=?').get(id);
    if (
      !asset ||
      !asset.object_hash ||
      !['pending', 'accepted', 'rejected'].includes(asset.state)
    )
      throw Error('Only validated candidates can be reviewed');
    const album = db
      .prepare('SELECT * FROM albums WHERE id=?')
      .get(asset.album);
    if (activate && (decision !== 'accepted' || album.pinned))
      throw Error('Activation requires acceptance and an unpinned album');
    if (decision === 'rejected' && album.active === id)
      throw Error('Choose a replacement before rejecting the active asset');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('UPDATE assets SET state=? WHERE id=?').run(decision, id);
      if (activate)
        db.prepare('UPDATE albums SET active=? WHERE id=?').run(
          id,
          asset.album
        );
      db.prepare(
        'INSERT INTO events(album,asset,action,reviewer,at) VALUES(?,?,?,?,?)'
      ).run(
        asset.album,
        id,
        activate ? 'accepted-and-activated' : decision,
        reviewer,
        new Date().toISOString()
      );
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  function recordDiscovery(album, evidence, now = new Date()) {
    if (!db.prepare('SELECT id FROM albums WHERE id=?').get(album))
      throw Error('Unknown album');
    if (
      ![
        'found',
        'not_found',
        'ambiguous',
        'error',
        'identity_required',
        'invalid_release',
      ].includes(evidence.outcome)
    )
      throw Error('Invalid discovery outcome');
    const jitter = parseInt(hash(album).slice(0, 4), 16) % (24 * 3600);
    const seconds =
      evidence.outcome === 'error'
        ? Math.max(3600, evidence.retryAfterSeconds || 0)
        : 30 * 86400 + jitter;
    const next = new Date(now.getTime() + seconds * 1000).toISOString();
    db.prepare(
      'INSERT INTO discovery VALUES(?,?,?,?,?) ON CONFLICT(album) DO UPDATE SET outcome=excluded.outcome,checked=excluded.checked,next_check=excluded.next_check,evidence=excluded.evidence'
    ).run(
      album,
      evidence.outcome,
      now.toISOString(),
      next,
      JSON.stringify(evidence)
    );
    return { ...evidence, nextCheck: next };
  }
  const snapshot = () => ({
    albums: db.prepare('SELECT * FROM albums ORDER BY id').all(),
    assets: db.prepare('SELECT * FROM assets ORDER BY album,created').all(),
    discovery: db.prepare('SELECT * FROM discovery ORDER BY album').all(),
    events: db.prepare('SELECT * FROM events ORDER BY id').all(),
  });
  const due = (now = new Date(), limit = 10) =>
    db
      .prepare(
        'SELECT a.id,a.metadata,d.* FROM albums a JOIN discovery d ON a.id=d.album WHERE d.next_check<=? ORDER BY d.next_check LIMIT ?'
      )
      .all(now.toISOString(), Math.max(1, Math.min(50, limit)));
  return {
    root,
    db,
    ingest,
    review,
    recordDiscovery,
    snapshot,
    due,
    close: () => db.close(),
    objectPath: (id) => path.join(root, 'objects', id + '.png'),
  };
}
