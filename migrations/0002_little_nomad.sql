CREATE TABLE `strava_activities` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer DEFAULT 1 NOT NULL,
	`strava_id` integer NOT NULL,
	`name` text NOT NULL,
	`sport_type` text DEFAULT 'Run' NOT NULL,
	`workout_type` integer DEFAULT 0,
	`distance_meters` real DEFAULT 0 NOT NULL,
	`distance_miles` real DEFAULT 0 NOT NULL,
	`moving_time_seconds` integer DEFAULT 0 NOT NULL,
	`elapsed_time_seconds` integer DEFAULT 0 NOT NULL,
	`total_elevation_gain_meters` real DEFAULT 0 NOT NULL,
	`total_elevation_gain_feet` real DEFAULT 0 NOT NULL,
	`start_date` text NOT NULL,
	`start_date_local` text NOT NULL,
	`timezone` text,
	`start_lat` real,
	`start_lng` real,
	`city` text,
	`state` text,
	`country` text,
	`average_speed_ms` real,
	`max_speed_ms` real,
	`pace_min_per_mile` real,
	`pace_formatted` text,
	`average_heartrate` real,
	`max_heartrate` real,
	`average_cadence` real,
	`calories` integer,
	`suffer_score` integer,
	`map_polyline` text,
	`gear_id` text,
	`achievement_count` integer DEFAULT 0,
	`pr_count` integer DEFAULT 0,
	`is_race` integer DEFAULT 0 NOT NULL,
	`is_deleted` integer DEFAULT 0 NOT NULL,
	`strava_url` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_strava_activities_strava_id` ON `strava_activities` (`strava_id`);--> statement-breakpoint
CREATE INDEX `idx_strava_activities_user_id` ON `strava_activities` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_strava_activities_start_date` ON `strava_activities` (`start_date`);--> statement-breakpoint
CREATE INDEX `idx_strava_activities_city` ON `strava_activities` (`city`);--> statement-breakpoint
CREATE INDEX `idx_strava_activities_gear_id` ON `strava_activities` (`gear_id`);--> statement-breakpoint
CREATE INDEX `idx_strava_activities_workout_type` ON `strava_activities` (`workout_type`);--> statement-breakpoint
CREATE INDEX `idx_strava_activities_is_deleted` ON `strava_activities` (`is_deleted`);--> statement-breakpoint
CREATE TABLE `strava_gear` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer DEFAULT 1 NOT NULL,
	`strava_gear_id` text NOT NULL,
	`name` text NOT NULL,
	`brand` text,
	`model` text,
	`distance_meters` real DEFAULT 0 NOT NULL,
	`distance_miles` real DEFAULT 0 NOT NULL,
	`is_retired` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_strava_gear_strava_gear_id` ON `strava_gear` (`strava_gear_id`);--> statement-breakpoint
CREATE INDEX `idx_strava_gear_user_id` ON `strava_gear` (`user_id`);--> statement-breakpoint
CREATE TABLE `strava_lifetime_stats` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer DEFAULT 1 NOT NULL,
	`total_runs` integer DEFAULT 0 NOT NULL,
	`total_distance_miles` real DEFAULT 0 NOT NULL,
	`total_elevation_feet` real DEFAULT 0 NOT NULL,
	`total_duration_seconds` integer DEFAULT 0 NOT NULL,
	`avg_pace_formatted` text,
	`years_active` integer DEFAULT 0 NOT NULL,
	`first_run` text,
	`eddington_number` integer DEFAULT 0 NOT NULL,
	`current_streak_days` integer DEFAULT 0 NOT NULL,
	`current_streak_start` text,
	`current_streak_end` text,
	`longest_streak_days` integer DEFAULT 0 NOT NULL,
	`longest_streak_start` text,
	`longest_streak_end` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_strava_lifetime_stats_user_id` ON `strava_lifetime_stats` (`user_id`);--> statement-breakpoint
CREATE TABLE `strava_personal_records` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer DEFAULT 1 NOT NULL,
	`distance` text NOT NULL,
	`distance_label` text NOT NULL,
	`time_seconds` integer NOT NULL,
	`time_formatted` text NOT NULL,
	`pace_formatted` text NOT NULL,
	`date` text NOT NULL,
	`activity_strava_id` integer NOT NULL,
	`activity_name` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_strava_prs_unique` ON `strava_personal_records` (`user_id`,`distance`);--> statement-breakpoint
CREATE INDEX `idx_strava_prs_user_id` ON `strava_personal_records` (`user_id`);--> statement-breakpoint
CREATE TABLE `strava_splits` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer DEFAULT 1 NOT NULL,
	`activity_strava_id` integer NOT NULL,
	`split_number` integer NOT NULL,
	`distance_meters` real NOT NULL,
	`distance_miles` real NOT NULL,
	`moving_time_seconds` integer NOT NULL,
	`elapsed_time_seconds` integer NOT NULL,
	`elevation_difference_meters` real,
	`elevation_difference_feet` real,
	`average_speed_ms` real,
	`pace_min_per_mile` real,
	`pace_formatted` text,
	`average_heartrate` real,
	`average_cadence` real
);
--> statement-breakpoint
CREATE INDEX `idx_strava_splits_activity` ON `strava_splits` (`activity_strava_id`);--> statement-breakpoint
CREATE INDEX `idx_strava_splits_user_id` ON `strava_splits` (`user_id`);--> statement-breakpoint
CREATE TABLE `strava_tokens` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer DEFAULT 1 NOT NULL,
	`access_token` text NOT NULL,
	`refresh_token` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_strava_tokens_user_id` ON `strava_tokens` (`user_id`);--> statement-breakpoint
CREATE TABLE `strava_year_summaries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer DEFAULT 1 NOT NULL,
	`year` integer NOT NULL,
	`total_runs` integer DEFAULT 0 NOT NULL,
	`total_distance_miles` real DEFAULT 0 NOT NULL,
	`total_elevation_feet` real DEFAULT 0 NOT NULL,
	`total_duration_seconds` integer DEFAULT 0 NOT NULL,
	`avg_pace_formatted` text,
	`longest_run_miles` real DEFAULT 0 NOT NULL,
	`race_count` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_strava_year_summaries_unique` ON `strava_year_summaries` (`user_id`,`year`);--> statement-breakpoint
CREATE INDEX `idx_strava_year_summaries_user_id` ON `strava_year_summaries` (`user_id`);