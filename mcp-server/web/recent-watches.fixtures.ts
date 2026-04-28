import type { Watch } from './components/PosterCard.js';
import realData from './fixtures/recent-watches.json' with { type: 'json' };

export type RecentWatchesPayload = {
  items: Watch[];
};

const real = realData as unknown as RecentWatchesPayload;

export const fixtures: Record<string, RecentWatchesPayload> = {
  default: real,

  'no-images': {
    items: [
      {
        movie: {
          id: 1,
          title: 'A Movie With No Poster',
          year: 2025,
          director: 'Unknown Director',
          image: null,
        },
        watched_at: '2026-04-01T20:00:00Z',
        user_rating: 3,
        rewatch: false,
        review: null,
        review_url: null,
      },
      {
        movie: {
          id: 2,
          title:
            'A Truly Extremely Long Movie Title That Should Wrap Or Truncate Gracefully',
          year: 2024,
          director: 'Some Director With An Unusually Long Name',
          image: { dominant_color: '#5a3a8a' },
        },
        watched_at: '2026-03-28T19:00:00Z',
        user_rating: 4.5,
        rewatch: true,
        review:
          'A surprisingly tender second act gives way to one of the more memorable closing shots of the year.',
        review_url: 'https://letterboxd.com/example/film/long-title/',
      },
    ],
  },

  empty: { items: [] },
};
