export interface Env {
  // Cloudflare bindings
  DB: D1Database;
  IMAGES: R2Bucket;
  IMAGE_TRANSFORMS: ImagesBinding;
  VECTORIZE_READING: VectorizeIndex;
  REWIND_CACHE: KVNamespace;

  // OG fallback scrapers for DataDome/PerimeterX-protected sources
  // (NYT, WSJ, Bloomberg, Reuters). Optional — calls skip if unset.
  SCRAPER_API_KEY?: string;
  OPENGRAPH_IO_KEY?: string;

  // System
  ALLOWED_ORIGINS: string;

  // Last.fm
  LASTFM_API_KEY: string;
  LASTFM_USERNAME: string;

  // Strava
  STRAVA_CLIENT_ID: string;
  STRAVA_CLIENT_SECRET: string;
  STRAVA_WEBHOOK_VERIFY_TOKEN: string;

  // Plex
  PLEX_URL: string;
  PLEX_TOKEN: string;
  PLEX_WEBHOOK_SECRET: string;
  PLEX_OWNER_ACCOUNT_TITLE: string;

  // TMDB (shared across watching sources)
  TMDB_API_KEY: string;

  // Letterboxd
  LETTERBOXD_USERNAME: string;

  // Discogs
  DISCOGS_PERSONAL_TOKEN: string;
  DISCOGS_USERNAME: string;

  // Trakt
  TRAKT_CLIENT_ID: string;
  TRAKT_CLIENT_SECRET: string;

  // Foursquare (places domain). Non-expiring v2 user token captured once
  // via browser OAuth; sync and cron skip when unset.
  FOURSQUARE_ACCESS_TOKEN?: string;

  // Google (Calendar + Gmail for the attending domain)
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;

  // setlist.fm (concert enrichment for the attending domain).
  // Free API key via https://www.setlist.fm/settings/api — optional;
  // concerts get loaded without setlist data when this is unset.
  SETLIST_FM_API_KEY?: string;

  // Instapaper
  INSTAPAPER_CONSUMER_KEY: string;
  INSTAPAPER_CONSUMER_SECRET: string;
  INSTAPAPER_ACCESS_TOKEN: string;
  INSTAPAPER_ACCESS_TOKEN_SECRET: string;

  // Images
  APPLE_MUSIC_DEVELOPER_TOKEN: string;
  FANART_TV_API_KEY: string;

  // Voyage AI (semantic search embeddings)
  VOYAGE_API_KEY: string;
}
