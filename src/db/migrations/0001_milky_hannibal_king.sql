CREATE TABLE `batches` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`api_key` text,
	`total_documents` integer NOT NULL,
	`completed_documents` integer DEFAULT 0 NOT NULL,
	`failed_documents` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`priority` integer DEFAULT 5 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`completed_at` integer,
	`metadata` text
);
--> statement-breakpoint
CREATE INDEX `batch_status_idx` ON `batches` (`status`);--> statement-breakpoint
CREATE INDEX `batch_created_at_idx` ON `batches` (`created_at`);--> statement-breakpoint
CREATE INDEX `batch_user_id_idx` ON `batches` (`user_id`);--> statement-breakpoint
ALTER TABLE `documents` ADD `batch_id` text;--> statement-breakpoint
CREATE INDEX `batch_id_idx` ON `documents` (`batch_id`);