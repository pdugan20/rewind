-- Add Apple Music enrichment columns to lastfm tables
ALTER TABLE `lastfm_artists` ADD `apple_music_id` integer;
ALTER TABLE `lastfm_artists` ADD `apple_music_url` text;
ALTER TABLE `lastfm_artists` ADD `itunes_enriched_at` text;

ALTER TABLE `lastfm_albums` ADD `apple_music_id` integer;
ALTER TABLE `lastfm_albums` ADD `apple_music_url` text;
ALTER TABLE `lastfm_albums` ADD `itunes_enriched_at` text;

ALTER TABLE `lastfm_tracks` ADD `apple_music_id` integer;
ALTER TABLE `lastfm_tracks` ADD `apple_music_url` text;
ALTER TABLE `lastfm_tracks` ADD `preview_url` text;
ALTER TABLE `lastfm_tracks` ADD `itunes_enriched_at` text;
