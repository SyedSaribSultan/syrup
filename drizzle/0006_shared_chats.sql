CREATE TABLE `shared_chats` (
	`id` text PRIMARY KEY NOT NULL,
	`directory` text NOT NULL,
	`session_id` text NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`snapshot` text NOT NULL,
	`models` text DEFAULT '[]' NOT NULL,
	`message_count` integer DEFAULT 0 NOT NULL,
	`bytes` integer DEFAULT 0 NOT NULL,
	`redactions` integer DEFAULT 0 NOT NULL,
	`views` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE INDEX `shared_chats_session_idx` ON `shared_chats` (`session_id`);--> statement-breakpoint
CREATE INDEX `shared_chats_created_idx` ON `shared_chats` (`created_at`);