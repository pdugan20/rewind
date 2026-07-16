import { describe, expect, it } from 'vitest';
import { rewriteCdnImageUrl } from './cdn-image.js';

describe('rewriteCdnImageUrl', () => {
  it('wraps a raw CDN source path in the requested transform', () => {
    expect(
      rewriteCdnImageUrl(
        'https://cdn.rewind.rest/reading/articles/a%2Fb/original%20hero.jpg?download=1&v=9',
        'width=160,height=160,fit=cover,format=auto,quality=85'
      )
    ).toBe(
      'https://cdn.rewind.rest/cdn-cgi/image/width=160,height=160,fit=cover,format=auto,quality=85/reading/articles/a%2Fb/original%20hero.jpg?v=9'
    );
  });
});
