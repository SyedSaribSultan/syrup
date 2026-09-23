ALTER TABLE `provider_keys` ADD `hint` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `provider_keys` ADD `active` integer DEFAULT 0 NOT NULL;