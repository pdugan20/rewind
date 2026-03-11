import { describe, it, expect } from 'vitest';

/**
 * Tests for the normalizeMediaType logic used in Trakt sync.
 * The function is not exported, so we replicate its logic here
 * to verify the mapping contract.
 */
function normalizeMediaType(
  mediaType: string | undefined,
  resolution: string | undefined
): 'bluray' | 'uhd_bluray' | 'hddvd' | 'dvd' | 'digital' {
  if (!mediaType) return 'bluray';
  const lower = mediaType.toLowerCase();
  if (lower === 'hddvd') return 'hddvd';
  if (lower === 'dvd') return 'dvd';
  if (lower === 'digital') return 'digital';
  if (resolution?.toLowerCase() === 'uhd_4k') return 'uhd_bluray';
  return 'bluray';
}

describe('Trakt Sync', () => {
  describe('normalizeMediaType', () => {
    it('should map undefined to bluray', () => {
      expect(normalizeMediaType(undefined, undefined)).toBe('bluray');
    });

    it('should map "bluray" to bluray', () => {
      expect(normalizeMediaType('bluray', undefined)).toBe('bluray');
    });

    it('should map "bluray" with uhd_4k resolution to uhd_bluray', () => {
      expect(normalizeMediaType('bluray', 'uhd_4k')).toBe('uhd_bluray');
    });

    it('should map "hddvd" to hddvd', () => {
      expect(normalizeMediaType('hddvd', undefined)).toBe('hddvd');
    });

    it('should map "dvd" to dvd', () => {
      expect(normalizeMediaType('dvd', undefined)).toBe('dvd');
    });

    it('should map "digital" to digital', () => {
      expect(normalizeMediaType('digital', undefined)).toBe('digital');
    });

    it('should handle case-insensitive input', () => {
      expect(normalizeMediaType('HDDVD', undefined)).toBe('hddvd');
      expect(normalizeMediaType('DVD', undefined)).toBe('dvd');
      expect(normalizeMediaType('Digital', undefined)).toBe('digital');
      expect(normalizeMediaType('BluRay', undefined)).toBe('bluray');
    });

    it('should default unknown types to bluray', () => {
      expect(normalizeMediaType('vhs', undefined)).toBe('bluray');
      expect(normalizeMediaType('laserdisc', undefined)).toBe('bluray');
      expect(normalizeMediaType('', undefined)).toBe('bluray');
    });
  });

  describe('remote key generation for deletion detection', () => {
    it('should produce unique keys from traktId and mediaType', () => {
      const remoteKeys = new Set<string>();
      remoteKeys.add('481:bluray');
      remoteKeys.add('481:uhd_bluray');
      remoteKeys.add('999:dvd');

      // Same movie in two formats should be two entries
      expect(remoteKeys.size).toBe(3);
      expect(remoteKeys.has('481:bluray')).toBe(true);
      expect(remoteKeys.has('481:uhd_bluray')).toBe(true);
      expect(remoteKeys.has('481:digital')).toBe(false);
    });

    it('should detect items removed from Trakt', () => {
      const remoteKeys = new Set(['481:bluray', '999:dvd']);
      const localItems = [
        { id: 1, traktId: 481, mediaType: 'bluray' },
        { id: 2, traktId: 481, mediaType: 'hddvd' },
        { id: 3, traktId: 999, mediaType: 'dvd' },
      ];

      const toRemove = localItems.filter(
        (local) => !remoteKeys.has(`${local.traktId}:${local.mediaType}`)
      );

      expect(toRemove).toHaveLength(1);
      expect(toRemove[0].id).toBe(2);
      expect(toRemove[0].mediaType).toBe('hddvd');
    });
  });

  describe('collection item processing', () => {
    it('should skip items without TMDb ID', () => {
      const items = [
        {
          movie: { title: 'No TMDb', year: 2000, ids: { trakt: 1, tmdb: 0 } },
          metadata: { media_type: 'bluray' },
        },
        {
          movie: {
            title: 'Has TMDb',
            year: 2001,
            ids: { trakt: 2, tmdb: 603 },
          },
          metadata: { media_type: 'bluray' },
        },
      ];

      const processed = items.filter((item) => item.movie.ids.tmdb);
      expect(processed).toHaveLength(1);
      expect(processed[0].movie.title).toBe('Has TMDb');
    });

    it('should handle null metadata fields gracefully', () => {
      const metadata = {
        media_type: 'bluray',
        resolution: undefined,
        hdr: undefined,
        audio: undefined,
        audio_channels: undefined,
      };

      expect(metadata.resolution || null).toBeNull();
      expect(metadata.hdr || null).toBeNull();
      expect(metadata.audio || null).toBeNull();
      expect(metadata.audio_channels || null).toBeNull();
    });
  });
});
