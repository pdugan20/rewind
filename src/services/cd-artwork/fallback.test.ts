import { beforeEach, describe, expect, it } from 'vitest';
import { encode as encodePng } from 'fast-png';
import { env } from 'cloudflare:test';
import type { ArtworkEnv } from './types.js';
import {
  readFallbackArtwork,
  readFallbackAsset,
  seedFallbackArtwork,
} from './fallback.js';
import { sha256 } from './types.js';

const artworkEnv = env as unknown as ArtworkEnv;
const MAX = 8 * 1024 * 1024;

function canonicalPng(seed = 1) {
  const pixels = new Uint8Array(1024 * 1024 * 4);
  for (let y = 0; y < 1024; y++)
    for (let x = 0; x < 1024; x++) {
      const r = Math.hypot(x + 0.5 - 512, y + 0.5 - 512);
      const i = (y * 1024 + x) * 4;
      const inside = r >= 61 && r <= 480;
      pixels[i] = (x + seed) % 256;
      pixels[i + 1] = (y * 3 + seed) % 256;
      pixels[i + 2] = (x + y) % 256;
      pixels[i + 3] = inside ? 255 : 0;
    }
  return encodePng({ width: 1024, height: 1024, data: pixels });
}

beforeEach(async () => {
  const names = [
    'fallback/users/1/descriptor.json',
    'fallback/users/2/descriptor.json',
  ];
  for (const key of names) await artworkEnv.ARTWORK.delete(key);
});

describe('generic CD artwork fallback', () => {
  it('stores independent per-user descriptors and serves accepted bytes by hash', async () => {
    const png = canonicalPng();
    expect(png.byteLength).toBeLessThanOrEqual(MAX);
    const first = await seedFallbackArtwork(
      artworkEnv,
      1,
      png,
      null,
      'Reviewed canonical generic artwork.'
    );
    const second = await seedFallbackArtwork(
      artworkEnv,
      2,
      png,
      null,
      'Reviewed canonical generic artwork.'
    );
    expect(first).toMatchObject({
      kind: 'generic',
      template: 'sony-cdr',
      alpha: 'material',
      sha256: await sha256(png),
      geometry: {
        canvas: 1024,
        center: 512,
        outer_radius: 480,
        hole_radius: 60,
      },
    });
    expect(await readFallbackArtwork(artworkEnv, 1)).toEqual(first);
    expect(await readFallbackArtwork(artworkEnv, 2)).toEqual(second);
    expect(
      await readFallbackAsset(artworkEnv, `${first.sha256}.png`)
    ).toMatchObject({ mime: 'image/png', sha256: first.sha256, bytes: png });
  });

  it('rejects invalid geometry, bad optional source digests, and stale expected hashes before publishing', async () => {
    const valid = canonicalPng();
    const invalidPixels = new Uint8Array(1024 * 1024 * 4);
    invalidPixels.fill(255);
    const invalid = encodePng({
      width: 1024,
      height: 1024,
      data: invalidPixels,
    });
    await expect(
      seedFallbackArtwork(
        artworkEnv,
        3,
        invalid,
        null,
        'Reviewed canonical generic artwork.'
      )
    ).rejects.toThrow();
    await expect(
      seedFallbackArtwork(
        artworkEnv,
        3,
        valid,
        null,
        'Reviewed canonical generic artwork.',
        { bytes: new Uint8Array([1]), sha256: '0'.repeat(64) }
      )
    ).rejects.toThrow();
    const descriptor = await seedFallbackArtwork(
      artworkEnv,
      3,
      valid,
      null,
      'Reviewed canonical generic artwork.'
    );
    await expect(
      seedFallbackArtwork(
        artworkEnv,
        3,
        canonicalPng(2),
        null,
        'Reviewed canonical generic artwork.'
      )
    ).rejects.toThrow('fallback_stale');
    expect(await readFallbackArtwork(artworkEnv, 3)).toEqual(descriptor);
  });

  it('supports idempotent same-hash writes and permits an expected-hash replacement', async () => {
    const firstPng = canonicalPng();
    const first = await seedFallbackArtwork(
      artworkEnv,
      4,
      firstPng,
      null,
      'Reviewed canonical generic artwork.'
    );
    const repeated = await seedFallbackArtwork(
      artworkEnv,
      4,
      firstPng,
      first.sha256,
      'Reviewed canonical generic artwork.'
    );
    expect(repeated.sha256).toBe(first.sha256);
    const next = await seedFallbackArtwork(
      artworkEnv,
      4,
      canonicalPng(2),
      first.sha256,
      'Second review approved canonical artwork.'
    );
    expect(next.sha256).not.toBe(first.sha256);
    expect(
      await readFallbackAsset(artworkEnv, `${first.sha256}.png`)
    ).not.toBeNull();
  });

  it('keeps a losing descriptor candidate private even after immutable bytes are stored', async () => {
    const candidate = canonicalPng(121);
    const hash = await sha256(candidate);
    const store = artworkEnv.ARTWORK;
    const racedEnv = {
      ...artworkEnv,
      ARTWORK: new Proxy(store, {
        get(target, property) {
          if (property === 'put')
            return async (...args: Parameters<typeof store.put>) => {
              if (args[0] === 'fallback/users/5/descriptor.json') return null;
              return store.put(...args);
            };
          const value = Reflect.get(target, property);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }),
    };
    await expect(
      seedFallbackArtwork(
        racedEnv,
        5,
        candidate,
        null,
        'Reviewed candidate loses descriptor compare-and-swap.'
      )
    ).rejects.toThrow('fallback_stale');
    expect(
      await artworkEnv.IMAGES.head(
        `listening/cd-artwork-fallback/assets/${hash}.png`
      )
    ).not.toBeNull();
    expect(await readFallbackArtwork(artworkEnv, 5)).toBeNull();
    expect(await readFallbackAsset(artworkEnv, `${hash}.png`)).toBeNull();
  });

  it('repairs interrupted public authorization on an idempotent selected-hash retry', async () => {
    const candidate = canonicalPng(122);
    const hash = await sha256(candidate);
    const store = artworkEnv.ARTWORK;
    let interrupted = false;
    const interruptedEnv = {
      ...artworkEnv,
      ARTWORK: new Proxy(store, {
        get(target, property) {
          if (property === 'put')
            return async (...args: Parameters<typeof store.put>) => {
              if (
                args[0] === `fallback/accepted/${hash}.json` &&
                !interrupted
              ) {
                interrupted = true;
                throw Error('synthetic authorization write interruption');
              }
              return store.put(...args);
            };
          const value = Reflect.get(target, property);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }),
    };
    await expect(
      seedFallbackArtwork(
        interruptedEnv,
        6,
        candidate,
        null,
        'Reviewed descriptor survives authorization interruption.'
      )
    ).rejects.toThrow('synthetic authorization write interruption');
    expect((await readFallbackArtwork(artworkEnv, 6))?.sha256).toBe(hash);
    expect(await readFallbackAsset(artworkEnv, `${hash}.png`)).toBeNull();
    await seedFallbackArtwork(
      artworkEnv,
      6,
      candidate,
      hash,
      'Retry the already-selected reviewed descriptor.'
    );
    expect(await readFallbackAsset(artworkEnv, `${hash}.png`)).not.toBeNull();
  });

  it('does not serve unaccepted, malformed, oversized, or corrupted public objects', async () => {
    const hash = 'a'.repeat(64);
    await artworkEnv.IMAGES.put(
      `listening/cd-artwork-fallback/assets/${hash}.png`,
      new Uint8Array([1, 2, 3]),
      { httpMetadata: { contentType: 'image/png' } }
    );
    expect(await readFallbackAsset(artworkEnv, `${hash}.png`)).toBeNull();
    expect(
      await readFallbackAsset(artworkEnv, '../' + `${hash}.png`)
    ).toBeNull();
    expect(
      await readFallbackAsset(artworkEnv, `${'A'.repeat(64)}.png`)
    ).toBeNull();
  });
});
