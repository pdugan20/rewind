// Shared shape for top-album / top-artist row data. The grid card that
// once lived here was retired when AlbumGrid dropped the list/grid
// toggle in favor of a single list view; only the type is still load-
// bearing across the listening surfaces (AlbumGrid, ArtistGrid,
// ArtistCard, top-*.fixtures.ts, top-*.tsx).
export type TopItem = {
  rank: number;
  id: number;
  name: string;
  detail: string; // artist name for albums, genre/short desc for artists
  playcount: number;
  image: {
    cdn_url?: string | null;
    url?: string | null;
    thumbhash?: string | null;
    dominant_color?: string | null;
    accent_color?: string | null;
  } | null;
  url: string;
  apple_music_url: string | null;
  preview_url?: string | null;
  sparkline?: {
    granularity: 'day' | 'week';
    points: number[];
  };
};
