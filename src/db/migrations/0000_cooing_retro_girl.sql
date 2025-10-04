CREATE TABLE `documents` (
	`id` text PRIMARY KEY NOT NULL,
	`file_name` text NOT NULL,
	`mime_type` text NOT NULL,
	`file_size` integer NOT NULL,
	`s3_key` text NOT NULL,
	`content` text,
	`metadata` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`error` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`processed_at` integer,
	`archived_at` integer,
	`retention_days` integer DEFAULT 365 NOT NULL,
	`user_id` text,
	`api_key` text
);
--> statement-breakpoint
CREATE INDEX `status_idx` ON `documents` (`status`);--> statement-breakpoint
CREATE INDEX `created_at_idx` ON `documents` (`created_at`);--> statement-breakpoint
CREATE INDEX `user_id_idx` ON `documents` (`user_id`);--> statement-breakpoint
CREATE TABLE `job_queue` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`type` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 3 NOT NULL,
	`payload` text,
	`result` text,
	`error` text,
	`worker_id` text,
	`scheduled_at` integer DEFAULT (unixepoch()) NOT NULL,
	`started_at` integer,
	`completed_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `job_status_idx` ON `job_queue` (`status`);--> statement-breakpoint
CREATE INDEX `scheduled_at_idx` ON `job_queue` (`scheduled_at`);--> statement-breakpoint
CREATE INDEX `priority_idx` ON `job_queue` (`priority`);--> statement-breakpoint
CREATE INDEX `worker_idx` ON `job_queue` (`worker_id`);--> statement-breakpoint
CREATE TABLE `usage` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`user_id` text,
	`api_key` text,
	`operation` text NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`base_cost_cents` integer NOT NULL,
	`margin_rate` integer DEFAULT 30 NOT NULL,
	`total_cost_cents` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `document_id_idx` ON `usage` (`document_id`);--> statement-breakpoint
CREATE INDEX `usage_user_id_idx` ON `usage` (`user_id`);--> statement-breakpoint
CREATE INDEX `usage_created_at_idx` ON `usage` (`created_at`);--> statement-breakpoint
CREATE TABLE `workers` (
	`id` text PRIMARY KEY NOT NULL,
	`pid` integer NOT NULL,
	`hostname` text NOT NULL,
	`started_at` integer DEFAULT (unixepoch()) NOT NULL,
	`last_heartbeat` integer DEFAULT (unixepoch()) NOT NULL,
	`status` text DEFAULT 'active' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `worker_status_idx` ON `workers` (`status`);--> statement-breakpoint
CREATE INDEX `heartbeat_idx` ON `workers` (`last_heartbeat`);