export interface Env {
  // Cloudflare bindings
  DB: D1Database;
  IMAGES: R2Bucket;
  IMAGE_TRANSFORMS: ImagesBinding;

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

  // Instapaper
  INSTAPAPER_CONSUMER_KEY: string;
  INSTAPAPER_CONSUMER_SECRET: string;
  INSTAPAPER_ACCESS_TOKEN: string;
  INSTAPAPER_ACCESS_TOKEN_SECRET: string;

  // Images
  APPLE_MUSIC_DEVELOPER_TOKEN: string;
  FANART_TV_API_KEY: string;
}
