ALTER TABLE `watch_stats` ADD COLUMN `total_shows` integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE `watch_stats` ADD COLUMN `total_episodes_watched` integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE `watch_stats` ADD COLUMN `episodes_this_year` integer NOT NULL DEFAULT 0;
