CREATE TABLE `logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` integer NOT NULL,
	`level` text DEFAULT 'info' NOT NULL,
	`source` text NOT NULL,
	`event` text NOT NULL,
	`session_id` text,
	`directory` text,
	`data` text
);
--> statement-breakpoint
CREATE INDEX `logs_ts_idx` ON `logs` (`ts`);--> statement-breakpoint
CREATE INDEX `logs_session_idx` ON `logs` (`session_id`);
