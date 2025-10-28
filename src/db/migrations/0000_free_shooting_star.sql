CREATE TABLE `batches` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`api_key` text,
	`total_documents` integer NOT NULL,
	`completed_documents` integer DEFAULT 0 NOT NULL,
	`failed_documents` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`priority` integer DEFAULT 5 NOT NULL,
	`batch_type` text DEFAULT 'local' NOT NULL,
	`mistral_batch_job_id` text,
	`mistral_input_file_id` text,
	`mistral_output_file_id` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`completed_at` integer,
	`metadata` text
);
--> statement-breakpoint
CREATE INDEX `batch_status_idx` ON `batches` (`status`);--> statement-breakpoint
CREATE INDEX `batch_created_at_idx` ON `batches` (`created_at`);--> statement-breakpoint
CREATE INDEX `batch_user_id_idx` ON `batches` (`user_id`);--> statement-breakpoint
CREATE INDEX `mistral_batch_job_idx` ON `batches` (`mistral_batch_job_id`);--> statement-breakpoint
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
	`api_key` text,
	`batch_id` text
);
--> statement-breakpoint
CREATE INDEX `status_idx` ON `documents` (`status`);--> statement-breakpoint
CREATE INDEX `created_at_idx` ON `documents` (`created_at`);--> statement-breakpoint
CREATE INDEX `user_id_idx` ON `documents` (`user_id`);--> statement-breakpoint
CREATE INDEX `batch_id_idx` ON `documents` (`batch_id`);--> statement-breakpoint
CREATE INDEX `doc_batch_status_idx` ON `documents` (`batch_id`,`status`);--> statement-breakpoint
CREATE INDEX `doc_api_key_created_idx` ON `documents` (`api_key`,`created_at`);--> statement-breakpoint
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
CREATE INDEX `claim_job_idx` ON `job_queue` (`status`,`scheduled_at`,`priority`);--> statement-breakpoint
CREATE INDEX `cleanup_job_idx` ON `job_queue` (`status`,`started_at`);--> statement-breakpoint
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
CREATE INDEX `api_key_time_idx` ON `usage` (`api_key`,`created_at`);--> statement-breakpoint
CREATE INDEX `user_id_time_idx` ON `usage` (`user_id`,`created_at`);