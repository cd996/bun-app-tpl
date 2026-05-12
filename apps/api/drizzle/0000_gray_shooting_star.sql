CREATE TABLE `pkce_challenges` (
	`state` text PRIMARY KEY NOT NULL,
	`code_verifier` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_pkce_expires` ON `pkce_challenges` (`expires_at`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text NOT NULL,
	`refresh_token` text,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_sessions_user` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_sessions_expires` ON `sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `groups` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_groups_name` ON `groups` (`name`);--> statement-breakpoint
CREATE TABLE `totp_challenges` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text NOT NULL,
	`refresh_token` text,
	`expires_in` integer,
	`redirect_uri` text NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_totp_challenge_expires` ON `totp_challenges` (`expires_at`);--> statement-breakpoint
CREATE TABLE `user_preferences` (
	`user_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `key`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `user_totp_devices` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`secret` text NOT NULL,
	`verified` integer DEFAULT false NOT NULL,
	`last_used_timestep` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_totp_user` ON `user_totp_devices` (`user_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`oauth_sub` text NOT NULL,
	`username` text NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`avatar` text,
	`role` text DEFAULT 'user' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`last_login_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_users_oauth_sub` ON `users` (`oauth_sub`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_users_username` ON `users` (`username`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_users_email` ON `users` (`email`);--> statement-breakpoint
CREATE INDEX `idx_users_status` ON `users` (`status`);--> statement-breakpoint
CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_id` text NOT NULL,
	`actor_name` text NOT NULL,
	`action` text NOT NULL,
	`resource_type` text NOT NULL,
	`resource_id` text NOT NULL,
	`resource_name` text NOT NULL,
	`detail` text,
	`ip` text NOT NULL,
	`user_agent` text NOT NULL,
	`result` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_audit_created` ON `audit_events` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_audit_actor_created` ON `audit_events` (`actor_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_audit_action_created` ON `audit_events` (`action`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_audit_resource_created` ON `audit_events` (`resource_type`,`resource_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `document_attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`filename` text NOT NULL,
	`filepath` text NOT NULL,
	`mimetype` text NOT NULL,
	`size` integer NOT NULL,
	`uploaded_by` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`uploaded_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_document_attachments_doc` ON `document_attachments` (`document_id`);--> statement-breakpoint
CREATE INDEX `idx_document_attachments_uploader` ON `document_attachments` (`uploaded_by`);--> statement-breakpoint
CREATE TABLE `document_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`author_id` text NOT NULL,
	`content` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_document_comments_doc` ON `document_comments` (`document_id`);--> statement-breakpoint
CREATE INDEX `idx_document_comments_author` ON `document_comments` (`author_id`);--> statement-breakpoint
CREATE TABLE `document_shares` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`permission` text DEFAULT 'viewer' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_doc_shares_unique` ON `document_shares` (`document_id`,`target_type`,`target_id`);--> statement-breakpoint
CREATE INDEX `idx_doc_shares_doc` ON `document_shares` (`document_id`);--> statement-breakpoint
CREATE INDEX `idx_doc_shares_target` ON `document_shares` (`target_type`,`target_id`);--> statement-breakpoint
CREATE TABLE `documents` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`content` text,
	`tags` text DEFAULT '[]' NOT NULL,
	`parent_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`creator_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`parent_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`creator_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_documents_creator` ON `documents` (`creator_id`);--> statement-breakpoint
CREATE INDEX `idx_documents_parent` ON `documents` (`parent_id`);--> statement-breakpoint
CREATE TABLE `relation_tuples` (
	`id` text PRIMARY KEY NOT NULL,
	`namespace` text NOT NULL,
	`object_id` text NOT NULL,
	`relation` text NOT NULL,
	`subject_namespace` text NOT NULL,
	`subject_id` text NOT NULL,
	`subject_relation` text,
	`created_by` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_tuples_object` ON `relation_tuples` (`namespace`,`object_id`,`relation`);--> statement-breakpoint
CREATE INDEX `idx_tuples_subject` ON `relation_tuples` (`subject_namespace`,`subject_id`,`subject_relation`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_tuples_unique` ON `relation_tuples` (`namespace`,`object_id`,`relation`,`subject_namespace`,`subject_id`,`subject_relation`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_by` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `todo_attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`todo_id` text NOT NULL,
	`filename` text NOT NULL,
	`filepath` text NOT NULL,
	`mimetype` text NOT NULL,
	`size` integer NOT NULL,
	`uploaded_by` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`todo_id`) REFERENCES `todos`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`uploaded_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_todo_attachments_todo` ON `todo_attachments` (`todo_id`);--> statement-breakpoint
CREATE INDEX `idx_todo_attachments_uploader` ON `todo_attachments` (`uploaded_by`);--> statement-breakpoint
CREATE TABLE `todo_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`todo_id` text NOT NULL,
	`author_id` text NOT NULL,
	`content` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`todo_id`) REFERENCES `todos`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_todo_comments_todo` ON `todo_comments` (`todo_id`);--> statement-breakpoint
CREATE INDEX `idx_todo_comments_author` ON `todo_comments` (`author_id`);--> statement-breakpoint
CREATE TABLE `todos` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`status` text DEFAULT 'open' NOT NULL,
	`priority` text DEFAULT 'medium' NOT NULL,
	`creator_id` text NOT NULL,
	`assignee_id` text,
	`due_date` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`creator_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`assignee_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_todos_creator` ON `todos` (`creator_id`);--> statement-breakpoint
CREATE INDEX `idx_todos_assignee` ON `todos` (`assignee_id`);--> statement-breakpoint
CREATE INDEX `idx_todos_status` ON `todos` (`status`);
--> statement-breakpoint
-- FTS5 indexes for documents (title + content) and todos (title + description).
-- Replaces the previous unindexed `LIKE '%q%'` full-table scan that burned
-- ~30-60 ms per query at 10k rows and would only get worse as data grows.
--
-- The `_fts` tables are content-less (`content=''`); we manage them with
-- triggers so reads from the canonical tables stay authoritative. The id
-- column is kept as the docid (`rowid` mapping is via the `docid` column).
-- We use the unicode61 tokenizer with `remove_diacritics 1` so search is
-- accent-insensitive — matches the operator-friendly UX of the rest of the
-- product.

-- ── Documents FTS ──
CREATE VIRTUAL TABLE IF NOT EXISTS `documents_fts` USING fts5(
  `id` UNINDEXED,
  `title`,
  `content`,
  tokenize = 'unicode61 remove_diacritics 1'
);--> statement-breakpoint

CREATE TRIGGER IF NOT EXISTS `documents_ai` AFTER INSERT ON `documents` BEGIN
  INSERT INTO `documents_fts` (`id`, `title`, `content`) VALUES (new.`id`, new.`title`, new.`content`);
END;--> statement-breakpoint

CREATE TRIGGER IF NOT EXISTS `documents_ad` AFTER DELETE ON `documents` BEGIN
  DELETE FROM `documents_fts` WHERE `id` = old.`id`;
END;--> statement-breakpoint

CREATE TRIGGER IF NOT EXISTS `documents_au` AFTER UPDATE ON `documents` BEGIN
  DELETE FROM `documents_fts` WHERE `id` = old.`id`;
  INSERT INTO `documents_fts` (`id`, `title`, `content`) VALUES (new.`id`, new.`title`, new.`content`);
END;--> statement-breakpoint

-- Backfill existing rows.
INSERT INTO `documents_fts` (`id`, `title`, `content`)
  SELECT `id`, `title`, `content` FROM `documents`
  WHERE NOT EXISTS (SELECT 1 FROM `documents_fts` WHERE `documents_fts`.`id` = `documents`.`id`);--> statement-breakpoint

-- ── Todos FTS ──
CREATE VIRTUAL TABLE IF NOT EXISTS `todos_fts` USING fts5(
  `id` UNINDEXED,
  `title`,
  `description`,
  tokenize = 'unicode61 remove_diacritics 1'
);--> statement-breakpoint

CREATE TRIGGER IF NOT EXISTS `todos_ai` AFTER INSERT ON `todos` BEGIN
  INSERT INTO `todos_fts` (`id`, `title`, `description`) VALUES (new.`id`, new.`title`, COALESCE(new.`description`, ''));
END;--> statement-breakpoint

CREATE TRIGGER IF NOT EXISTS `todos_ad` AFTER DELETE ON `todos` BEGIN
  DELETE FROM `todos_fts` WHERE `id` = old.`id`;
END;--> statement-breakpoint

CREATE TRIGGER IF NOT EXISTS `todos_au` AFTER UPDATE ON `todos` BEGIN
  DELETE FROM `todos_fts` WHERE `id` = old.`id`;
  INSERT INTO `todos_fts` (`id`, `title`, `description`) VALUES (new.`id`, new.`title`, COALESCE(new.`description`, ''));
END;--> statement-breakpoint

INSERT INTO `todos_fts` (`id`, `title`, `description`)
  SELECT `id`, `title`, COALESCE(`description`, '') FROM `todos`
  WHERE NOT EXISTS (SELECT 1 FROM `todos_fts` WHERE `todos_fts`.`id` = `todos`.`id`);
