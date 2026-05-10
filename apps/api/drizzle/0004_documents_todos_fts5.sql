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
