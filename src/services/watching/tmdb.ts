const TMDB_BASE_URL = 'https://api.themoviedb.org/3';

export interface TmdbMovieDetail {
  id: number;
  title: string;
  year: number | null;
  tagline: string | null;
  overview: string | null;
  runtime: number | null;
  vote_average: number | null;
  imdb_id: string | null;
  poster_path: string | null;
  backdrop_path: string | null;
  genres: { id: number; name: string }[];
  directors: string[];
  content_rating: string | null;
}

export interface TmdbSearchResult {
  id: number;
  title: string;
  release_date: string;
  overview: string;
  poster_path: string | null;
  vote_average: number;
}

interface TmdbRawMovie {
  id: number;
  title: string;
  release_date?: string;
  tagline?: string;
  overview?: string;
  runtime?: number;
  vote_average?: number;
  imdb_id?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  genres?: { id: number; name: string }[];
  credits?: {
    crew?: { job: string; name: string }[];
  };
  releases?: {
    countries?: { iso_3166_1: string; certification: string }[];
  };
}

interface TmdbSearchResponse {
  results: {
    id: number;
    title: string;
    release_date: string;
    overview: string;
    poster_path: string | null;
    vote_average: number;
  }[];
  total_results: number;
}

interface TmdbFindResponse {
  movie_results: {
    id: number;
    title: string;
    release_date: string;
  }[];
}

interface TmdbTvDetail {
  id: number;
  name: string;
  first_air_date?: string;
  overview?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  vote_average?: number;
  content_ratings?: {
    results?: { iso_3166_1: string; rating: string }[];
  };
  number_of_seasons?: number;
  number_of_episodes?: number;
}

export interface TmdbShowDetail {
  id: number;
  title: string;
  year: number | null;
  summary: string | null;
  posterPath: string | null;
  backdropPath: string | null;
  contentRating: string | null;
  tmdbRating: number | null;
  totalSeasons: number;
  totalEpisodes: number;
}

export class TmdbClient {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  private async request<T>(path: string, params?: URLSearchParams): Promise<T> {
    const url = new URL(`${TMDB_BASE_URL}${path}`);
    if (params) {
      params.forEach((value, key) => url.searchParams.set(key, value));
    }

    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(
        `[ERROR] TMDB API error: ${response.status} ${response.statusText} for ${path}`
      );
    }

    return response.json() as Promise<T>;
  }

  async getMovieDetail(tmdbId: number): Promise<TmdbMovieDetail> {
    const params = new URLSearchParams({
      append_to_response: 'credits,releases',
    });

    const raw = await this.request<TmdbRawMovie>(`/movie/${tmdbId}`, params);
    return this.transformMovie(raw);
  }

  async searchMovie(title: string, year?: number): Promise<TmdbSearchResult[]> {
    const params = new URLSearchParams({ query: title });
    if (year) {
      params.set('year', String(year));
    }

    const data = await this.request<TmdbSearchResponse>(
      '/search/movie',
      params
    );
    return data.results.map((r) => ({
      id: r.id,
      title: r.title,
      release_date: r.release_date,
      overview: r.overview,
      poster_path: r.poster_path,
      vote_average: r.vote_average,
    }));
  }

  async findByImdbId(imdbId: string): Promise<number | null> {
    const params = new URLSearchParams({ external_source: 'imdb_id' });
    const data = await this.request<TmdbFindResponse>(
      `/find/${imdbId}`,
      params
    );

    if (data.movie_results.length > 0) {
      return data.movie_results[0].id;
    }
    return null;
  }

  async getTvShowDetail(tmdbId: number): Promise<TmdbShowDetail> {
    const params = new URLSearchParams({
      append_to_response: 'content_ratings',
    });
    const raw = await this.request<TmdbTvDetail>(`/tv/${tmdbId}`, params);

    const usRating = (raw.content_ratings?.results || []).find(
      (r) => r.iso_3166_1 === 'US'
    );

    return {
      id: raw.id,
      title: raw.name,
      year: raw.first_air_date
        ? parseInt(raw.first_air_date.substring(0, 4), 10)
        : null,
      summary: raw.overview || null,
      posterPath: raw.poster_path || null,
      backdropPath: raw.backdrop_path || null,
      contentRating: usRating?.rating || null,
      tmdbRating: raw.vote_average || null,
      totalSeasons: raw.number_of_seasons || 0,
      totalEpisodes: raw.number_of_episodes || 0,
    };
  }

  private transformMovie(raw: TmdbRawMovie): TmdbMovieDetail {
    const directors = (raw.credits?.crew || [])
      .filter((c) => c.job === 'Director')
      .map((c) => c.name);

    const usRelease = (raw.releases?.countries || []).find(
      (c) => c.iso_3166_1 === 'US'
    );

    return {
      id: raw.id,
      title: raw.title,
      year: raw.release_date
        ? parseInt(raw.release_date.substring(0, 4), 10)
        : null,
      tagline: raw.tagline || null,
      overview: raw.overview || null,
      runtime: raw.runtime || null,
      vote_average: raw.vote_average || null,
      imdb_id: raw.imdb_id || null,
      poster_path: raw.poster_path || null,
      backdrop_path: raw.backdrop_path || null,
      genres: raw.genres || [],
      directors,
      content_rating: usRelease?.certification || null,
    };
  }
}

/**
 * Extract TMDB ID from Plex Guid array.
 * Plex format: [{ id: "tmdb://27205" }, { id: "imdb://tt1375666" }]
 */
export function extractTmdbIdFromGuids(guids: { id: string }[]): number | null {
  for (const guid of guids) {
    const match = guid.id.match(/^tmdb:\/\/(\d+)$/);
    if (match) {
      return parseInt(match[1], 10);
    }
  }
  return null;
}

/**
 * Extract IMDB ID from Plex Guid array.
 */
export function extractImdbIdFromGuids(guids: { id: string }[]): string | null {
  for (const guid of guids) {
    const match = guid.id.match(/^imdb:\/\/(tt\d+)$/);
    if (match) {
      return match[1];
    }
  }
  return null;
}

/**
 * Resolve a TMDB ID from Plex Guid array, with IMDB fallback.
 */
export async function resolveTmdbId(
  guids: { id: string }[],
  client: TmdbClient
): Promise<number | null> {
  // Try direct TMDB ID first
  const tmdbId = extractTmdbIdFromGuids(guids);
  if (tmdbId) return tmdbId;

  // Fallback to IMDB ID lookup
  const imdbId = extractImdbIdFromGuids(guids);
  if (imdbId) {
    return client.findByImdbId(imdbId);
  }

  return null;
}
