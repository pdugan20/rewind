CREATE TABLE `lately_snapshots` (
	`user_id` integer PRIMARY KEY NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`snapshot` text,
	`pending` text,
	`policy` text DEFAULT '' NOT NULL,
	`lease_token` text,
	`lease_until` integer DEFAULT 0 NOT NULL,
	`last_started_at` integer DEFAULT 0 NOT NULL
);
