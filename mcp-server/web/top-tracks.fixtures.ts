import type { TopTracksPayload } from './components/TopTracks.js';
import realData from './fixtures/top-tracks.json' with { type: 'json' };

const real = realData as unknown as TopTracksPayload;

// Variant: same payload but reframed as a 1-month period so we can preview
// the heading "Top Olivia Rodrigo tracks · Last month" alongside the
// "All time" version. Useful for picking the right scope label.
const oneMonth: TopTracksPayload = {
  ...real,
  period: '1month',
  data: real.data.slice(0, 5),
};

// Variant: unfiltered top-tracks (no artist_id) — simulates the
// non-artist-filtered call so we can preview the layout for the global
// top-N case as well.
const unfiltered: TopTracksPayload = {
  ...real,
  artist_id: null,
  data: real.data.map((t, i) => ({
    ...t,
    rank: i + 1,
    // Fake a different artist on alternating tracks so the "by Artist"
    // subtitle renders rather than an album name.
    detail: i % 2 === 0 ? 'Olivia Rodrigo' : 'Sabrina Carpenter',
  })),
};

export const fixtures: Record<string, TopTracksPayload> = {
  default: real,
  '1month': oneMonth,
  unfiltered,
};
