DROP INDEX `interactions_vendor_idx`;--> statement-breakpoint
CREATE INDEX `interactions_vendor_idx` ON `interactions` (`vendor_id`,`direction`);--> statement-breakpoint
CREATE INDEX `evidence_source_idx` ON `evidence` (`vendor_id`,`field_path`,`value`,`source_url`);--> statement-breakpoint
CREATE INDEX `proposals_pending_idx` ON `proposals` (`decided_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `schedules_config_uq` ON `schedules` (`config`);--> statement-breakpoint
CREATE INDEX `vendors_next_action_idx` ON `vendors` (`next_action`);--> statement-breakpoint
CREATE INDEX `vendors_owner_idx` ON `vendors` (`owner`);--> statement-breakpoint
CREATE INDEX `vendors_last_verified_idx` ON `vendors` (`last_verified_at`);--> statement-breakpoint
CREATE INDEX `vendors_discovered_via_idx` ON `vendors` (`discovered_via`);--> statement-breakpoint
CREATE INDEX `vendors_first_run_idx` ON `vendors` (`first_seen_run_id`);