CREATE TABLE `activity_feed` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer DEFAULT 1 NOT NULL,
	`domain` text NOT NULL,
	`event_type` text NOT NULL,
	`occurred_at` text NOT NULL,
	`title` text NOT NULL,
	`subtitle` text,
	`image_key` text,
	`source_id` text NOT NULL,
	`metadata` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_activity_feed_domain` ON `activity_feed` (`domain`);--> statement-breakpoint
CREATE INDEX `idx_activity_feed_occurred_at` ON `activity_feed` (`occurred_at`);--> statement-breakpoint
CREATE INDEX `idx_activity_feed_event_type` ON `activity_feed` (`event_type`);--> statement-breakpoint
CREATE INDEX `idx_activity_feed_user_id` ON `activity_feed` (`user_id`);--> statement-breakpoint
CREATE TABLE `api_keys` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer DEFAULT 1 NOT NULL,
	`key_hash` text NOT NULL,
	`key_prefix` text NOT NULL,
	`key_hint` text NOT NULL,
	`name` text NOT NULL,
	`scope` text DEFAULT 'read' NOT NULL,
	`rate_limit_rpm` integer DEFAULT 60 NOT NULL,
	`last_used_at` text,
	`request_count` integer DEFAULT 0 NOT NULL,
	`expires_at` text,
	`is_active` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_key_hash_unique` ON `api_keys` (`key_hash`);--> statement-breakpoint
CREATE INDEX `idx_api_keys_key_hash` ON `api_keys` (`key_hash`);--> statement-breakpoint
CREATE INDEX `idx_api_keys_user_id` ON `api_keys` (`user_id`);--> statement-breakpoint
CREATE TABLE `images` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer DEFAULT 1 NOT NULL,
	`domain` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`r2_key` text NOT NULL,
	`source` text NOT NULL,
	`source_url` text,
	`width` integer,
	`height` integer,
	`thumbhash` text,
	`dominant_color` text,
	`accent_color` text,
	`is_override` integer DEFAULT 0 NOT NULL,
	`override_at` text,
	`image_version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_images_unique` ON `images` (`domain`,`entity_type`,`entity_id`);--> statement-breakpoint
CREATE INDEX `idx_images_domain` ON `images` (`domain`);--> statement-breakpoint
CREATE INDEX `idx_images_entity` ON `images` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE INDEX `idx_images_user_id` ON `images` (`user_id`);--> statement-breakpoint
CREATE TABLE `revalidation_hooks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer DEFAULT 1 NOT NULL,
	`url` text NOT NULL,
	`domain` text NOT NULL,
	`secret` text NOT NULL,
	`is_active` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_revalidation_hooks_user_id` ON `revalidation_hooks` (`user_id`);--> statement-breakpoint
CREATE TABLE `sync_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer DEFAULT 1 NOT NULL,
	`domain` text NOT NULL,
	`sync_type` text NOT NULL,
	`status` text NOT NULL,
	`started_at` text NOT NULL,
	`completed_at` text,
	`items_synced` integer DEFAULT 0,
	`error` text,
	`metadata` text
);
--> statement-breakpoint
CREATE INDEX `idx_sync_runs_domain` ON `sync_runs` (`domain`);--> statement-breakpoint
CREATE INDEX `idx_sync_runs_started_at` ON `sync_runs` (`started_at`);--> statement-breakpoint
CREATE INDEX `idx_sync_runs_user_id` ON `sync_runs` (`user_id`);--> statement-breakpoint
CREATE TABLE `webhook_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer DEFAULT 1 NOT NULL,
	`event_source` text NOT NULL,
	`event_id` text NOT NULL,
	`event_type` text,
	`processed_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_webhook_events_unique` ON `webhook_events` (`event_source`,`event_id`);--> statement-breakpoint
CREATE INDEX `idx_webhook_events_source` ON `webhook_events` (`event_source`);--> statement-breakpoint
CREATE INDEX `idx_webhook_events_user_id` ON `webhook_events` (`user_id`);