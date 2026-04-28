// Shared shape for a watched film. The grid poster card that once
// lived here was retired when PosterGrid switched to a single list
// view with Reviewed / Watched tabs; only the type is still load-
// bearing across the watching surfaces (PosterGrid, recent-watches
// fixtures + entry, MCP tool).
export type Watch = {
  movie: {
    id: number;
    title: string;
    year: number | null;
    director: string | null;
    summary?: string | null;
    tagline?: string | null;
    image: {
      cdn_url?: string | null;
      url?: string | null;
      thumbhash?: string | null;
      dominant_color?: string | null;
      accent_color?: string | null;
    } | null;
  };
  watched_at: string;
  user_rating: number | null;
  rewatch: boolean;
  review: string | null;
  review_url: string | null;
};
