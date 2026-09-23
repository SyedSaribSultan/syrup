CREATE TABLE `memories` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text DEFAULT 'note' NOT NULL,
	`title` text NOT NULL,
	`content` text NOT NULL,
	`tags` text DEFAULT '' NOT NULL,
	`session_id` text,
	`source` text DEFAULT 'agent' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE VIRTUAL TABLE `memories_fts` USING fts5(`id` UNINDEXED, `title`, `content`, `tags`, tokenize = 'porter unicode61');--> statement-breakpoint
CREATE TRIGGER `memories_ai` AFTER INSERT ON `memories` BEGIN
  INSERT INTO `memories_fts`(`id`, `title`, `content`, `tags`) VALUES (new.`id`, new.`title`, new.`content`, new.`tags`);
END;--> statement-breakpoint
CREATE TRIGGER `memories_ad` AFTER DELETE ON `memories` BEGIN
  DELETE FROM `memories_fts` WHERE `id` = old.`id`;
END;--> statement-breakpoint
CREATE TRIGGER `memories_au` AFTER UPDATE ON `memories` BEGIN
  DELETE FROM `memories_fts` WHERE `id` = old.`id`;
  INSERT INTO `memories_fts`(`id`, `title`, `content`, `tags`) VALUES (new.`id`, new.`title`, new.`content`, new.`tags`);
END;
