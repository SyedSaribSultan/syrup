CREATE TABLE `router_events` (
	`id` text PRIMARY KEY NOT NULL,
	`ts` integer NOT NULL,
	`alias` text NOT NULL,
	`provider_id` text NOT NULL,
	`model_id` text NOT NULL,
	`key_id` text,
	`tier` text DEFAULT 'free' NOT NULL,
	`status` text NOT NULL,
	`http_status` integer,
	`attempts` integer DEFAULT 1 NOT NULL,
	`latency_ms` integer DEFAULT 0 NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cost` real DEFAULT 0 NOT NULL,
	`error` text
);
