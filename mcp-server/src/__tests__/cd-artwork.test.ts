import { describe, it, expect, vi } from 'vitest';
import { RewindClient } from '../client.js';
import { albumCdArtwork } from '../tools/cd-artwork.js';
const h = 'a'.repeat(64);
const art = {
  album_id: 1,
  asset_id: h,
  sha256: h,
  image_url: `https://api.rewind.rest/v1/listening/cd-artwork/assets/${h}.png`,
  source_kind: 'retail',
  release_id: 'e9b0f69e-ee3d-36ed-8c12-f8ee65f87e45',
  medium_position: 1,
  source: 'https://coverartarchive.org/release/example',
  geometry: { canvas: 1024, center: 512, outer_radius: 480, hole_radius: 60 },
  alpha: 'material',
  review: 'accepted',
  thumbhash: null,
  dominant_color: '#000000',
  accent_color: '#ffffff',
};
describe('optional album CD attachment', () => {
  it('returns accepted artwork for the requested album', async () => {
    const client = new RewindClient('https://api.test', 'rw_synthetic');
    vi.spyOn(client, 'get').mockResolvedValue({ artwork: art });
    expect(await albumCdArtwork(client, 1)).toEqual(art);
  });
  it('accepts reviewed-source artwork without fabricating release or medium identifiers', async () => {
    const client = new RewindClient('https://api.test', 'rw_synthetic');
    const reviewed = {
      ...art,
      release_id: null,
      medium_position: null,
      identity_type: 'reviewed_source',
    };
    vi.spyOn(client, 'get').mockResolvedValue({ artwork: reviewed });
    expect(await albumCdArtwork(client, 1)).toEqual(reviewed);
  });
  it('preserves compatibility with an unavailable or older artwork service', async () => {
    const client = new RewindClient('https://api.test', 'rw_synthetic');
    vi.spyOn(client, 'get').mockRejectedValue(Error('unavailable'));
    expect(await albumCdArtwork(client, 1)).toBeNull();
  });
  it('rejects another album, pending art, incorrect geometry and unsafe image URLs', async () => {
    for (const item of [
      { ...art, album_id: 2 },
      { ...art, review: 'pending' },
      { ...art, geometry: { ...art.geometry, hole_radius: 30 } },
      { ...art, image_url: 'https://untrusted.example/asset.png' },
    ]) {
      const client = new RewindClient('https://api.test', 'rw_synthetic');
      vi.spyOn(client, 'get').mockResolvedValue({ artwork: item });
      expect(await albumCdArtwork(client, 1)).toBeNull();
    }
  });
});
