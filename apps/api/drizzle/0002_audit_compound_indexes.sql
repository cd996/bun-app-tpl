DROP INDEX IF EXISTS `idx_audit_actor`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_audit_action`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_audit_resource`;--> statement-breakpoint
CREATE INDEX `idx_audit_actor_created` ON `audit_events` (`actor_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_audit_action_created` ON `audit_events` (`action`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_audit_resource_created` ON `audit_events` (`resource_type`,`resource_id`,`created_at`);
