CREATE TABLE `collection_listening_xref` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer DEFAULT 1 NOT NULL,
	`collection_id` integer NOT NULL,
	`release_id` integer NOT NULL,
	`lastfm_album_name` text,
	`lastfm_artist_name` text,
	`play_count` integer DEFAULT 0 NOT NULL,
	`last_played` text,
	`match_type` text DEFAULT 'none' NOT NULL,
	`match_confidence` real DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`collection_id`) REFERENCES `discogs_collection`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`release_id`) REFERENCES `discogs_releases`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_collection_listening_xref_unique` ON `collection_listening_xref` (`user_id`,`collection_id`);--> statement-breakpoint
CREATE INDEX `idx_collection_listening_xref_release` ON `collection_listening_xref` (`release_id`);--> statement-breakpoint
CREATE INDEX `idx_collection_listening_xref_play_count` ON `collection_listening_xref` (`play_count`);--> statement-breakpoint
CREATE INDEX `idx_collection_listening_xref_user_id` ON `collection_listening_xref` (`user_id`);--> statement-breakpoint
CREATE TABLE `discogs_artists` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer DEFAULT 1 NOT NULL,
	`discogs_id` integer NOT NULL,
	`name` text NOT NULL,
	`profile_url` text,
	`image_url` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_discogs_artists_discogs_id` ON `discogs_artists` (`user_id`,`discogs_id`);--> statement-breakpoint
CREATE INDEX `idx_discogs_artists_name` ON `discogs_artists` (`name`);--> statement-breakpoint
CREATE INDEX `idx_discogs_artists_user_id` ON `discogs_artists` (`user_id`);--> statement-breakpoint
CREATE TABLE `discogs_collection` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer DEFAULT 1 NOT NULL,
	`release_id` integer NOT NULL,
	`instance_id` integer NOT NULL,
	`folder_id` integer DEFAULT 0 NOT NULL,
	`rating` integer DEFAULT 0,
	`notes` text,
	`date_added` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`release_id`) REFERENCES `discogs_releases`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_discogs_collection_instance` ON `discogs_collection` (`user_id`,`instance_id`);--> statement-breakpoint
CREATE INDEX `idx_discogs_collection_release` ON `discogs_collection` (`release_id`);--> statement-breakpoint
CREATE INDEX `idx_discogs_collection_date_added` ON `discogs_collection` (`date_added`);--> statement-breakpoint
CREATE INDEX `idx_discogs_collection_user_id` ON `discogs_collection` (`user_id`);--> statement-breakpoint
CREATE TABLE `discogs_collection_stats` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer DEFAULT 1 NOT NULL,
	`total_items` integer DEFAULT 0 NOT NULL,
	`by_format` text,
	`wantlist_count` integer DEFAULT 0 NOT NULL,
	`unique_artists` integer DEFAULT 0 NOT NULL,
	`estimated_value` real,
	`top_genre` text,
	`oldest_release_year` integer,
	`newest_release_year` integer,
	`most_collected_artist` text,
	`added_this_year` integer DEFAULT 0 NOT NULL,
	`by_genre` text,
	`by_decade` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_discogs_collection_stats_user` ON `discogs_collection_stats` (`user_id`);--> statement-breakpoint
CREATE TABLE `discogs_release_artists` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`release_id` integer NOT NULL,
	`artist_id` integer NOT NULL,
	FOREIGN KEY (`release_id`) REFERENCES `discogs_releases`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`artist_id`) REFERENCES `discogs_artists`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_discogs_release_artists_unique` ON `discogs_release_artists` (`release_id`,`artist_id`);--> statement-breakpoint
CREATE INDEX `idx_discogs_release_artists_artist` ON `discogs_release_artists` (`artist_id`);--> statement-breakpoint
CREATE TABLE `discogs_releases` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer DEFAULT 1 NOT NULL,
	`discogs_id` integer NOT NULL,
	`title` text NOT NULL,
	`year` integer,
	`cover_url` text,
	`thumb_url` text,
	`discogs_url` text,
	`genres` text,
	`styles` text,
	`formats` text,
	`format_details` text,
	`labels` text,
	`tracklist` text,
	`country` text,
	`community_have` integer,
	`community_want` integer,
	`lowest_price` real,
	`num_for_sale` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_discogs_releases_discogs_id` ON `discogs_releases` (`user_id`,`discogs_id`);--> statement-breakpoint
CREATE INDEX `idx_discogs_releases_year` ON `discogs_releases` (`year`);--> statement-breakpoint
CREATE INDEX `idx_discogs_releases_user_id` ON `discogs_releases` (`user_id`);--> statement-breakpoint
CREATE TABLE `discogs_wantlist` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer DEFAULT 1 NOT NULL,
	`discogs_id` integer NOT NULL,
	`title` text NOT NULL,
	`artists` text,
	`year` integer,
	`cover_url` text,
	`thumb_url` text,
	`discogs_url` text,
	`formats` text,
	`genres` text,
	`notes` text,
	`rating` integer DEFAULT 0,
	`date_added` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_discogs_wantlist_discogs_id` ON `discogs_wantlist` (`user_id`,`discogs_id`);--> statement-breakpoint
CREATE INDEX `idx_discogs_wantlist_date_added` ON `discogs_wantlist` (`date_added`);--> statement-breakpoint
CREATE INDEX `idx_discogs_wantlist_user_id` ON `discogs_wantlist` (`user_id`);