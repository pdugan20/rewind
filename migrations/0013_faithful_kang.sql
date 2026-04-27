CREATE TABLE `mlb_teams` (
	`id` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`abbreviation` text NOT NULL,
	`team_code` text,
	`league` text DEFAULT 'mlb' NOT NULL,
	`primary_color` text,
	`secondary_color` text,
	`logo_image_key` text,
	`active` integer DEFAULT 1 NOT NULL,
	`synced_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_mlb_teams_abbr` ON `mlb_teams` (`abbreviation`);--> statement-breakpoint
CREATE INDEX `idx_mlb_teams_active` ON `mlb_teams` (`active`);