-- Trakt physical media collection tables
CREATE TABLE `trakt_tokens` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer DEFAULT 1 NOT NULL,
	`access_token` text NOT NULL,
	`refresh_token` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_trakt_tokens_user_id` ON `trakt_tokens` (`user_id`);
--> statement-breakpoint
CREATE TABLE `trakt_collection` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer DEFAULT 1 NOT NULL,
	`movie_id` integer NOT NULL,
	`trakt_id` integer NOT NULL,
	`media_type` text NOT NULL,
	`resolution` text,
	`hdr` text,
	`audio` text,
	`audio_channels` text,
	`collected_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`movie_id`) REFERENCES `movies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_trakt_collection_unique` ON `trakt_collection` (`user_id`,`trakt_id`,`media_type`);
--> statement-breakpoint
CREATE INDEX `idx_trakt_collection_movie` ON `trakt_collection` (`movie_id`);
--> statement-breakpoint
CREATE INDEX `idx_trakt_collection_media_type` ON `trakt_collection` (`media_type`);
--> statement-breakpoint
CREATE INDEX `idx_trakt_collection_collected_at` ON `trakt_collection` (`collected_at`);
--> statement-breakpoint
CREATE INDEX `idx_trakt_collection_user_id` ON `trakt_collection` (`user_id`);
--> statement-breakpoint
CREATE TABLE `trakt_collection_stats` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer DEFAULT 1 NOT NULL,
	`total_items` integer DEFAULT 0 NOT NULL,
	`by_format` text,
	`by_resolution` text,
	`by_hdr` text,
	`by_genre` text,
	`by_decade` text,
	`added_this_year` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_trakt_collection_stats_user` ON `trakt_collection_stats` (`user_id`);
