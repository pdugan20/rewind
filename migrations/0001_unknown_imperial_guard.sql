CREATE TABLE `lastfm_albums` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer DEFAULT 1 NOT NULL,
	`mbid` text,
	`name` text NOT NULL,
	`artist_id` integer NOT NULL,
	`url` text,
	`playcount` integer DEFAULT 0,
	`is_filtered` integer DEFAULT 0,
	`image_key` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`artist_id`) REFERENCES `lastfm_artists`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_lastfm_albums_unique` ON `lastfm_albums` (`name`,`artist_id`);--> statement-breakpoint
CREATE INDEX `idx_lastfm_albums_artist_id` ON `lastfm_albums` (`artist_id`);--> statement-breakpoint
CREATE INDEX `idx_lastfm_albums_user_id` ON `lastfm_albums` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_lastfm_albums_filtered` ON `lastfm_albums` (`is_filtered`);--> statement-breakpoint
CREATE TABLE `lastfm_artists` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer DEFAULT 1 NOT NULL,
	`mbid` text,
	`name` text NOT NULL,
	`url` text,
	`playcount` integer DEFAULT 0,
	`is_filtered` integer DEFAULT 0,
	`image_key` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `lastfm_artists_name_unique` ON `lastfm_artists` (`name`);--> statement-breakpoint
CREATE INDEX `idx_lastfm_artists_user_id` ON `lastfm_artists` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_lastfm_artists_filtered` ON `lastfm_artists` (`is_filtered`);--> statement-breakpoint
CREATE TABLE `lastfm_filters` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer DEFAULT 1 NOT NULL,
	`filter_type` text NOT NULL,
	`pattern` text NOT NULL,
	`scope` text,
	`reason` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_lastfm_filters_type` ON `lastfm_filters` (`filter_type`);--> statement-breakpoint
CREATE INDEX `idx_lastfm_filters_user_id` ON `lastfm_filters` (`user_id`);--> statement-breakpoint
CREATE TABLE `lastfm_scrobbles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer DEFAULT 1 NOT NULL,
	`track_id` integer NOT NULL,
	`scrobbled_at` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`track_id`) REFERENCES `lastfm_tracks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_lastfm_scrobbles_track_id` ON `lastfm_scrobbles` (`track_id`);--> statement-breakpoint
CREATE INDEX `idx_lastfm_scrobbles_scrobbled_at` ON `lastfm_scrobbles` (`scrobbled_at`);--> statement-breakpoint
CREATE INDEX `idx_lastfm_scrobbles_user_id` ON `lastfm_scrobbles` (`user_id`);--> statement-breakpoint
CREATE TABLE `lastfm_top_albums` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer DEFAULT 1 NOT NULL,
	`period` text NOT NULL,
	`rank` integer NOT NULL,
	`album_id` integer NOT NULL,
	`playcount` integer NOT NULL,
	`computed_at` text NOT NULL,
	FOREIGN KEY (`album_id`) REFERENCES `lastfm_albums`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_lastfm_top_albums_unique` ON `lastfm_top_albums` (`period`,`album_id`);--> statement-breakpoint
CREATE INDEX `idx_lastfm_top_albums_period` ON `lastfm_top_albums` (`period`);--> statement-breakpoint
CREATE INDEX `idx_lastfm_top_albums_user_id` ON `lastfm_top_albums` (`user_id`);--> statement-breakpoint
CREATE TABLE `lastfm_top_artists` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer DEFAULT 1 NOT NULL,
	`period` text NOT NULL,
	`rank` integer NOT NULL,
	`artist_id` integer NOT NULL,
	`playcount` integer NOT NULL,
	`computed_at` text NOT NULL,
	FOREIGN KEY (`artist_id`) REFERENCES `lastfm_artists`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_lastfm_top_artists_unique` ON `lastfm_top_artists` (`period`,`artist_id`);--> statement-breakpoint
CREATE INDEX `idx_lastfm_top_artists_period` ON `lastfm_top_artists` (`period`);--> statement-breakpoint
CREATE INDEX `idx_lastfm_top_artists_user_id` ON `lastfm_top_artists` (`user_id`);--> statement-breakpoint
CREATE TABLE `lastfm_top_tracks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer DEFAULT 1 NOT NULL,
	`period` text NOT NULL,
	`rank` integer NOT NULL,
	`track_id` integer NOT NULL,
	`playcount` integer NOT NULL,
	`computed_at` text NOT NULL,
	FOREIGN KEY (`track_id`) REFERENCES `lastfm_tracks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_lastfm_top_tracks_unique` ON `lastfm_top_tracks` (`period`,`track_id`);--> statement-breakpoint
CREATE INDEX `idx_lastfm_top_tracks_period` ON `lastfm_top_tracks` (`period`);--> statement-breakpoint
CREATE INDEX `idx_lastfm_top_tracks_user_id` ON `lastfm_top_tracks` (`user_id`);--> statement-breakpoint
CREATE TABLE `lastfm_tracks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer DEFAULT 1 NOT NULL,
	`mbid` text,
	`name` text NOT NULL,
	`artist_id` integer NOT NULL,
	`album_id` integer,
	`url` text,
	`duration_ms` integer,
	`is_filtered` integer DEFAULT 0,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`artist_id`) REFERENCES `lastfm_artists`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`album_id`) REFERENCES `lastfm_albums`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_lastfm_tracks_unique` ON `lastfm_tracks` (`name`,`artist_id`);--> statement-breakpoint
CREATE INDEX `idx_lastfm_tracks_artist_id` ON `lastfm_tracks` (`artist_id`);--> statement-breakpoint
CREATE INDEX `idx_lastfm_tracks_album_id` ON `lastfm_tracks` (`album_id`);--> statement-breakpoint
CREATE INDEX `idx_lastfm_tracks_user_id` ON `lastfm_tracks` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_lastfm_tracks_filtered` ON `lastfm_tracks` (`is_filtered`);--> statement-breakpoint
CREATE TABLE `lastfm_user_stats` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer DEFAULT 1 NOT NULL,
	`total_scrobbles` integer DEFAULT 0 NOT NULL,
	`unique_artists` integer DEFAULT 0 NOT NULL,
	`unique_albums` integer DEFAULT 0 NOT NULL,
	`unique_tracks` integer DEFAULT 0 NOT NULL,
	`registered_date` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_lastfm_user_stats_user_id` ON `lastfm_user_stats` (`user_id`);