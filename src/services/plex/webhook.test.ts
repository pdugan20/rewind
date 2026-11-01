import { describe, it, expect } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { verifyPlexWebhook, type PlexWebhookPayload } from './webhook.js';

function createTestPayload(
  overrides: Partial<PlexWebhookPayload> = {}
): PlexWebhookPayload {
  return {
    event: 'media.scrobble',
    user: true,
    owner: true,
    Account: { id: 12345678, title: 'TestUser' },
    Server: { title: 'TestServer', uuid: 'test-server-uuid' },
    Player: {
      local: true,
      publicAddress: '127.0.0.1',
      title: 'Test Player',
      uuid: 'test-player-uuid',
    },
    Metadata: {
      librarySectionType: 'movie',
      ratingKey: '12345',
      type: 'movie',
      title: 'Inception',
      year: 2010,
      summary: 'A thief who steals corporate secrets...',
      rating: 8.8,
      audienceRating: 9.1,
      contentRating: 'PG-13',
      duration: 8880000,
      studio: 'Warner Bros.',
      Guid: [{ id: 'imdb://tt1375666' }, { id: 'tmdb://27205' }],
      Genre: [{ tag: 'Science Fiction' }, { tag: 'Action' }],
      Director: [{ tag: 'Christopher Nolan' }],
    },
    ...overrides,
  };
}

describe('verifyPlexWebhook', () => {
  it('accepts matching server UUID', () => {
    const payload = createTestPayload();
    expect(verifyPlexWebhook(payload, 'test-server-uuid')).toBe(true);
  });

  it('rejects non-matching server UUID', () => {
    const payload = createTestPayload();
    expect(verifyPlexWebhook(payload, 'wrong-uuid')).toBe(false);
  });

  it('rejects a same-length UUID that differs', () => {
    const payload = createTestPayload();
    expect(verifyPlexWebhook(payload, 'test-server-uuiX')).toBe(false);
  });

  it('rejects every payload when the secret is empty', () => {
    const payload = createTestPayload();
    expect(verifyPlexWebhook(payload, '')).toBe(false);
  });

  it('rejects a payload without a server UUID', () => {
    const payload = createTestPayload();
    const withoutServer = {
      ...payload,
      Server: undefined,
    } as unknown as PlexWebhookPayload;
    expect(verifyPlexWebhook(withoutServer, 'test-server-uuid')).toBe(false);
  });
});

describe('PlexWebhookPayload structure', () => {
  it('creates valid test payload with correct structure', () => {
    const payload = createTestPayload();
    expect(payload.event).toBe('media.scrobble');
    expect(payload.Metadata.type).toBe('movie');
    expect(payload.Metadata.title).toBe('Inception');
    expect(payload.Metadata.year).toBe(2010);
    expect(payload.Metadata.Guid).toHaveLength(2);
    expect(payload.Metadata.Genre).toHaveLength(2);
    expect(payload.Metadata.Director).toHaveLength(1);
  });

  it('creates episode payload', () => {
    const payload = createTestPayload({
      Metadata: {
        librarySectionType: 'show',
        ratingKey: '67890',
        type: 'episode',
        title: 'Pilot',
        grandparentTitle: 'Breaking Bad',
        grandparentRatingKey: '11111',
        parentIndex: 1,
        index: 1,
        Guid: [{ id: 'tmdb://1396' }],
      },
    });

    expect(payload.Metadata.type).toBe('episode');
    expect(payload.Metadata.grandparentTitle).toBe('Breaking Bad');
    expect(payload.Metadata.parentIndex).toBe(1);
    expect(payload.Metadata.index).toBe(1);
  });
});
describe('POST /webhooks/plex', () => {
  it('rejects webhooks when PLEX_WEBHOOK_SECRET is not configured', async () => {
    expect(
      (env as unknown as Record<string, unknown>).PLEX_WEBHOOK_SECRET
    ).toBeFalsy();
    const form = new FormData();
    form.set('payload', JSON.stringify(createTestPayload()));

    const res = await SELF.fetch('http://localhost/v1/webhooks/plex', {
      method: 'POST',
      body: form,
    });

    expect(res.status).toBe(403);
  });
});
