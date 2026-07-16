import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ArticleDetail, type ArticlePayload } from './ArticleDetail.js';

describe('ArticleDetail image transforms', () => {
  it('replaces an existing 300x300 transform with the 1440x810 hero transform', () => {
    const payload: ArticlePayload = {
      article: {
        id: 1,
        title: 'Test article',
        author: null,
        url: null,
        instapaper_url: null,
        instapaper_app_url: null,
        domain: 'example.com',
        description: null,
        word_count: null,
        estimated_read_min: null,
        status: 'unread',
        progress: 0,
        saved_at: '2026-07-16T00:00:00.000Z',
        image: {
          cdn_url:
            'https://cdn.rewind.rest/cdn-cgi/image/width=300,height=300,fit=cover,format=auto,quality=85/reading/articles/a%2Fb/original%20hero.jpg?download=1&v=7',
          thumbhash: null,
          dominant_color: null,
          accent_color: null,
        },
      },
      highlights: [],
      highlight_count: 0,
    };

    const markup = renderToStaticMarkup(<ArticleDetail payload={payload} />);

    expect(markup).toContain(
      'https://cdn.rewind.rest/cdn-cgi/image/width=1440,height=810,fit=cover,format=auto,quality=85/reading/articles/a%2Fb/original%20hero.jpg?v=7'
    );
  });
});
