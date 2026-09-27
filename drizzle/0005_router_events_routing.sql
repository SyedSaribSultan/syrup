ALTER TABLE `router_events` ADD `session_id` text;--> statement-breakpoint
ALTER TABLE `router_events` ADD `ttft_ms` integer;--> statement-breakpoint
ALTER TABLE `router_events` ADD `retry_at` integer;--> statement-breakpoint
ALTER TABLE `router_events` ADD `reason` text;--> statement-breakpoint
CREATE INDEX `router_events_ts_idx` ON `router_events` (`ts`);--> statement-breakpoint
CREATE INDEX `router_events_session_idx` ON `router_events` (`session_id`);