CREATE TABLE `checkins` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer DEFAULT 1 NOT NULL,
	`foursquare_id` text NOT NULL,
	`venue_id` text,
	`venue_name` text NOT NULL,
	`venue_category` text,
	`venue_city` text,
	`venue_state` text,
	`venue_country` text,
	`lat` real,
	`lng` real,
	`checked_in_at` text NOT NULL,
	`shout` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_checkins_foursquare_id` ON `checkins` (`foursquare_id`);--> statement-breakpoint
CREATE INDEX `idx_checkins_user_id` ON `checkins` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_checkins_checked_in_at` ON `checkins` (`checked_in_at`);--> statement-breakpoint
CREATE INDEX `idx_checkins_timeline` ON `checkins` (`user_id`,`checked_in_at`);--> statement-breakpoint
CREATE INDEX `idx_checkins_venue_id` ON `checkins` (`venue_id`);