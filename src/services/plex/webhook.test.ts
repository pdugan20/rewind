import { describe, it, expect } from 'vitest';
import { SELF } from 'cloudflare:test';
import { verifyPlexWebhookToken, type PlexWebhookPayload } from './webhook.js';

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

describe('verifyPlexWebhookToken', () => {
  it('accepts the matching token', () => {
    expect(verifyPlexWebhookToken('url-token-1234', 'url-token-1234')).toBe(
      true
    );
  });

  it('rejects a different token of the same length', () => {
    expect(verifyPlexWebhookToken('url-token-1235', 'url-token-1234')).toBe(
      false
    );
  });

  it('rejects a missing token', () => {
    expect(verifyPlexWebhookToken(undefined, 'url-token-1234')).toBe(false);
  });

  it('rejects every request when no token is configured', () => {
    expect(verifyPlexWebhookToken('', '')).toBe(false);
    expect(verifyPlexWebhookToken('anything', undefined)).toBe(false);
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
  const post = (url: string, payload = createTestPayload()) => {
    const form = new FormData();
    form.set('payload', JSON.stringify(payload));
    return SELF.fetch(url, { method: 'POST', body: form });
  };

  it('accepts a webhook with the correct URL token', async () => {
    const res = await post(
      'http://localhost/v1/webhooks/plex?token=test-webhook-token',
      createTestPayload({ event: 'media.pause' })
    );
    expect(res.status).toBe(200);
  });

  it('rejects a webhook without the URL token', async () => {
    const res = await post('http://localhost/v1/webhooks/plex');
    expect(res.status).toBe(403);
  });

  it('rejects the matching server UUID without the URL token', async () => {
    const res = await post(
      'http://localhost/v1/webhooks/plex?token=test-server-uuid'
    );
    expect(res.status).toBe(403);
  });

  it('rejects a webhook with the wrong URL token', async () => {
    const res = await post(
      'http://localhost/v1/webhooks/plex?token=test-webhook-tokeX'
    );
    expect(res.status).toBe(403);
  });
});
