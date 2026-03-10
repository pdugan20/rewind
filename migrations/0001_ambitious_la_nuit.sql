CREATE TABLE `directors` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `directors_name_unique` ON `directors` (`name`);--> statement-breakpoint
CREATE TABLE `genres` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `genres_name_unique` ON `genres` (`name`);--> statement-breakpoint
CREATE TABLE `movie_directors` (
	`movie_id` integer NOT NULL,
	`director_id` integer NOT NULL,
	PRIMARY KEY(`movie_id`, `director_id`),
	FOREIGN KEY (`movie_id`) REFERENCES `movies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`director_id`) REFERENCES `directors`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_movie_directors_director_id` ON `movie_directors` (`director_id`);--> statement-breakpoint
CREATE TABLE `movie_genres` (
	`movie_id` integer NOT NULL,
	`genre_id` integer NOT NULL,
	PRIMARY KEY(`movie_id`, `genre_id`),
	FOREIGN KEY (`movie_id`) REFERENCES `movies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`genre_id`) REFERENCES `genres`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_movie_genres_genre_id` ON `movie_genres` (`genre_id`);--> statement-breakpoint
CREATE TABLE `movies` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer DEFAULT 1 NOT NULL,
	`plex_rating_key` text,
	`title` text NOT NULL,
	`year` integer,
	`tmdb_id` integer,
	`imdb_id` text,
	`tagline` text,
	`summary` text,
	`content_rating` text,
	`runtime` integer,
	`poster_path` text,
	`backdrop_path` text,
	`tmdb_rating` real,
	`image_key` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `movies_plex_rating_key_unique` ON `movies` (`plex_rating_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `movies_tmdb_id_unique` ON `movies` (`tmdb_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `movies_imdb_id_unique` ON `movies` (`imdb_id`);--> statement-breakpoint
CREATE INDEX `idx_movies_year` ON `movies` (`year`);--> statement-breakpoint
CREATE INDEX `idx_movies_tmdb_id` ON `movies` (`tmdb_id`);--> statement-breakpoint
CREATE INDEX `idx_movies_user_id` ON `movies` (`user_id`);--> statement-breakpoint
CREATE TABLE `plex_episodes_watched` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer DEFAULT 1 NOT NULL,
	`show_id` integer NOT NULL,
	`season_number` integer NOT NULL,
	`episode_number` integer NOT NULL,
	`title` text,
	`watched_at` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`show_id`) REFERENCES `plex_shows`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_plex_episodes_watched_show_id` ON `plex_episodes_watched` (`show_id`);--> statement-breakpoint
CREATE INDEX `idx_plex_episodes_watched_watched_at` ON `plex_episodes_watched` (`watched_at`);--> statement-breakpoint
CREATE INDEX `idx_plex_episodes_watched_user_id` ON `plex_episodes_watched` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_plex_episodes_unique` ON `plex_episodes_watched` (`show_id`,`season_number`,`episode_number`,`watched_at`);--> statement-breakpoint
CREATE TABLE `plex_shows` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer DEFAULT 1 NOT NULL,
	`plex_rating_key` text NOT NULL,
	`title` text NOT NULL,
	`year` integer,
	`tmdb_id` integer,
	`summary` text,
	`image_key` text,
	`total_seasons` integer,
	`total_episodes` integer,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `plex_shows_plex_rating_key_unique` ON `plex_shows` (`plex_rating_key`);--> statement-breakpoint
CREATE INDEX `idx_plex_shows_user_id` ON `plex_shows` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_plex_shows_tmdb_id` ON `plex_shows` (`tmdb_id`);--> statement-breakpoint
CREATE TABLE `watch_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer DEFAULT 1 NOT NULL,
	`movie_id` integer NOT NULL,
	`watched_at` text NOT NULL,
	`source` text DEFAULT 'plex' NOT NULL,
	`user_rating` real,
	`percent_complete` real,
	`rewatch` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`movie_id`) REFERENCES `movies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_watch_history_movie_id` ON `watch_history` (`movie_id`);--> statement-breakpoint
CREATE INDEX `idx_watch_history_watched_at` ON `watch_history` (`watched_at`);--> statement-breakpoint
CREATE INDEX `idx_watch_history_user_id` ON `watch_history` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_watch_history_source` ON `watch_history` (`source`);--> statement-breakpoint
CREATE TABLE `watch_stats` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer DEFAULT 1 NOT NULL,
	`total_movies` integer DEFAULT 0 NOT NULL,
	`total_watch_time_s` integer DEFAULT 0 NOT NULL,
	`movies_this_year` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_watch_stats_user_id` ON `watch_stats` (`user_id`);