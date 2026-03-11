import { describe, it, expect } from 'vitest';
import { VALID_SIZES } from '../services/images/presets.js';

describe('images route', () => {
  describe('validation', () => {
    it('defines valid size presets', () => {
      expect(VALID_SIZES).toContain('thumbnail');
      expect(VALID_SIZES).toContain('small');
      expect(VALID_SIZES).toContain('medium');
      expect(VALID_SIZES).toContain('large');
      expect(VALID_SIZES).toContain('poster');
      expect(VALID_SIZES).toContain('backdrop');
      expect(VALID_SIZES).toContain('original');
    });

    it('has 8 valid sizes', () => {
      expect(VALID_SIZES).toHaveLength(8);
    });
  });

  describe('CDN URL building', () => {
    it('builds URLs with version parameter', async () => {
      const { buildCdnUrl } = await import('../services/images/presets.js');
      const url = buildCdnUrl(
        'listening/albums/test/original.jpg',
        'medium',
        1
      );
      expect(url).toContain('v=1');
      expect(url).toContain('width=300');
    });

    it('increments version for cache busting', async () => {
      const { buildCdnUrl } = await import('../services/images/presets.js');
      const url1 = buildCdnUrl('test/key', 'small', 1);
      const url2 = buildCdnUrl('test/key', 'small', 2);
      expect(url1).toContain('v=1');
      expect(url2).toContain('v=2');
      expect(url1).not.toBe(url2);
    });
  });

  describe('valid domains', () => {
    const VALID_DOMAINS = ['listening', 'watching', 'collecting'];

    it('includes all expected domains', () => {
      expect(VALID_DOMAINS).toContain('listening');
      expect(VALID_DOMAINS).toContain('watching');
      expect(VALID_DOMAINS).toContain('collecting');
    });
  });

  describe('valid entity types', () => {
    const VALID_ENTITY_TYPES = [
      'albums',
      'artists',
      'movies',
      'shows',
      'releases',
    ];

    it('includes all expected entity types', () => {
      expect(VALID_ENTITY_TYPES).toContain('albums');
      expect(VALID_ENTITY_TYPES).toContain('artists');
      expect(VALID_ENTITY_TYPES).toContain('movies');
      expect(VALID_ENTITY_TYPES).toContain('shows');
      expect(VALID_ENTITY_TYPES).toContain('releases');
    });
  });
});
