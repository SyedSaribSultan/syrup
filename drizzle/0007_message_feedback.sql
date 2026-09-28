CREATE TABLE `message_feedback` (
	`message_id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`rating` integer NOT NULL,
	`alias` text,
	`provider_id` text,
	`model_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `message_feedback_session_idx` ON `message_feedback` (`session_id`);