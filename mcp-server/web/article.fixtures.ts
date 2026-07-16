import type { ArticlePayload } from './components/ArticleDetail.js';
import realData from './fixtures/article.json' with { type: 'json' };

const real = realData as unknown as ArticlePayload;

const noImageFixture: ArticlePayload = {
  article: {
    id: 5099,
    title: 'A short note from a personal blog',
    author: null,
    url: 'https://small-blog.example.com/post/2',
    instapaper_url: 'https://www.instapaper.com/read/5099',
    instapaper_app_url: null,
    domain: 'small-blog.example.com',
    description:
      'Some sources never extract an OG image — the article still saves cleanly, the card just renders without a hero.',
    word_count: 620,
    estimated_read_min: 3,
    status: 'unread',
    progress: 0,
    saved_at: '2026-04-22T08:12:00Z',
    image: null,
  },
  highlights: [],
  highlight_count: 0,
};

const inProgressFixture: ArticlePayload = {
  article: {
    id: 4990,
    title:
      'On long-form attention: why the brain does not actually want to read 12,000 words on a phone',
    author: 'D. Hasan',
    url: 'https://example.com/long-form-attention',
    instapaper_url: 'https://www.instapaper.com/read/4990',
    instapaper_app_url: 'instapaper://read/4990',
    domain: 'aeon.co',
    description:
      'The "deep reading" debate is older than the smartphone. What changed is not your brain — it is the situational architecture around the act of reading.',
    word_count: 11820,
    estimated_read_min: 49,
    status: 'reading',
    progress: 0.42,
    saved_at: '2026-04-10T18:00:00Z',
    image: {
      cdn_url: 'https://cdn.rewind.rest/reading/articles/4990',
      url: 'https://cdn.aeon.co/2026/04/long-form-hero.jpg',
      thumbhash: 'KBgKDYJ4eHmXhoeEd4eIeIB4d3iIA4eHd4iIeIeIA4eHeId4iH',
      dominant_color: '#1a1a2e',
      accent_color: '#e94560',
    },
  },
  highlights: [
    {
      id: 13001,
      text: 'The phone is not a reading device pretending to be a phone — it is a phone pretending to be a reading device.',
      note: null,
      created_at: '2026-04-11T11:02:00Z',
    },
  ],
  highlight_count: 1,
};

const archivedWithQuoteFixture: ArticlePayload = {
  article: {
    id: 1121,
    title: 'Ichiro Suzuki, Mariners resolve internal battle',
    author: null,
    url: 'http://www.espn.com/espn/feature/story/_/id/22624561/ichiro-suzuki-return-seattle-mariners-resolve-internal-battle',
    instapaper_url: 'https://www.instapaper.com/read/1026945010',
    instapaper_app_url: 'instapaper://read/1026945010',
    domain: 'espn.com',
    description:
      "How five days in February reveal what Seattle's signing of Ichiro cannot. The future Hall of Famer is haunted by the life he can't escape.",
    word_count: 4647,
    estimated_read_min: 20,
    status: 'finished',
    progress: 1,
    saved_at: '2018-03-15T05:00:00.000Z',
    image: {
      cdn_url:
        'https://cdn.rewind.rest/cdn-cgi/image/width=300,height=300,fit=cover,format=auto,quality=85/reading/articles/1121/original.jpg?v=1',
      url: null,
      thumbhash: 'XPcNDwJ3mHegZ4dGmTiHqGl4+Dhob4ME',
      dominant_color: '#132132',
      accent_color: '#a297a5',
    },
  },
  highlights: [
    {
      id: 4284,
      text: 'Japanese home run king Sadaharu Oh wrote in his memoir: "Baseball in America is a game that is born in spring and dies in autumn. In Japan it is bound to winter as the heart is to the body."',
      note: null,
      created_at: '2018-03-08T21:31:26.000Z',
    },
  ],
  highlight_count: 1,
};

const archivedNoHighlightsFixture: ArticlePayload = {
  article: {
    id: 5111,
    title: 'A quick read I finished but never highlighted',
    author: 'Casey Wong',
    url: 'https://example.com/quick-read',
    instapaper_url: 'https://www.instapaper.com/read/5111',
    instapaper_app_url: 'instapaper://read/5111',
    domain: 'medium.com',
    description:
      'Sometimes you read a thing all the way through and there is nothing to highlight — the card should still feel complete.',
    word_count: 1240,
    estimated_read_min: 5,
    status: 'archived',
    progress: 1,
    saved_at: '2026-03-30T22:18:00Z',
    image: {
      cdn_url: 'https://cdn.rewind.rest/reading/articles/5111',
      url: null,
      thumbhash: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      dominant_color: '#3a3a3a',
      accent_color: '#9a9a9a',
    },
  },
  highlights: [],
  highlight_count: 0,
};

export const fixtures: Record<string, ArticlePayload> = {
  default: real,
  'no-image': noImageFixture,
  'in-progress': inProgressFixture,
  'archived-with-quote': archivedWithQuoteFixture,
  'archived-no-highlights': archivedNoHighlightsFixture,
};
