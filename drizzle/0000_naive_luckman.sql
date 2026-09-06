CREATE TABLE `events` (
	`event_id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`vendor_id` text NOT NULL,
	`from_status` text,
	`to_status` text NOT NULL,
	`from_stage` text,
	`to_stage` text,
	`actor` text NOT NULL,
	`reason` text,
	`confidence` real,
	`evidence_ref` text,
	`payload` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`vendor_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `events_vendor_idx` ON `events` (`vendor_id`,`event_id`);--> statement-breakpoint
CREATE TABLE `evidence` (
	`evidence_id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`vendor_id` text NOT NULL,
	`field_path` text NOT NULL,
	`value` text,
	`source_url` text,
	`snippet` text,
	`extraction_method` text NOT NULL,
	`confidence` real DEFAULT 0 NOT NULL,
	`proxy` integer DEFAULT false NOT NULL,
	`verified` integer DEFAULT false NOT NULL,
	`attested_by` text,
	`observed_at` text NOT NULL,
	FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`vendor_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `evidence_vendor_field_idx` ON `evidence` (`vendor_id`,`field_path`);--> statement-breakpoint
CREATE INDEX `evidence_verified_idx` ON `evidence` (`verified`);--> statement-breakpoint
CREATE TABLE `interactions` (
	`interaction_id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`vendor_id` text NOT NULL,
	`gmail_thread_id` text,
	`direction` text NOT NULL,
	`sent_at` text,
	`subject` text,
	`body_text` text,
	`llm_summary` text,
	FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`vendor_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `interactions_vendor_idx` ON `interactions` (`vendor_id`);--> statement-breakpoint
CREATE INDEX `interactions_thread_idx` ON `interactions` (`gmail_thread_id`);--> statement-breakpoint
CREATE TABLE `proposals` (
	`proposal_id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`vendor_id` text NOT NULL,
	`interaction_id` integer,
	`to_status` text,
	`to_stage` text,
	`confidence` real,
	`evidence_snippet` text,
	`decided_by` text,
	`decided_at` text,
	FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`vendor_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`interaction_id`) REFERENCES `interactions`(`interaction_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `proposals_vendor_idx` ON `proposals` (`vendor_id`);--> statement-breakpoint
CREATE TABLE `runs` (
	`run_id` text PRIMARY KEY NOT NULL,
	`input_type` text NOT NULL,
	`adapter` text NOT NULL,
	`vendor_type` text NOT NULL,
	`query` text NOT NULL,
	`ruleset_version` text NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`counts` text DEFAULT '{}' NOT NULL,
	`raw_payload_path` text
);
--> statement-breakpoint
CREATE TABLE `schedules` (
	`schedule_id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`config` text NOT NULL,
	`cron` text NOT NULL,
	`last_run_id` text,
	`enabled` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`last_run_id`) REFERENCES `runs`(`run_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `tags` (
	`tag_id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`vendor_id` text NOT NULL,
	`dimension` text NOT NULL,
	`value` text NOT NULL,
	`source_badge` text NOT NULL,
	`evidence_id` integer,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`vendor_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`evidence_id`) REFERENCES `evidence`(`evidence_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tags_vendor_dimension_value_uq` ON `tags` (`vendor_id`,`dimension`,`value`);--> statement-breakpoint
CREATE INDEX `tags_dimension_value_idx` ON `tags` (`dimension`,`value`);--> statement-breakpoint
CREATE TABLE `vendors` (
	`vendor_id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`vendor_type` text NOT NULL,
	`primary_domain` text,
	`contact_email` text,
	`registration_country` text,
	`ownership_country` text,
	`parent_entity` text,
	`collection_countries` text DEFAULT '[]' NOT NULL,
	`attributes` text DEFAULT '{}' NOT NULL,
	`screen_result` text,
	`screen_reasons` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'Identified' NOT NULL,
	`diligence_stage` text,
	`status_confidence` real,
	`coverage_confidence` real,
	`next_action` text,
	`owner` text,
	`due_at` text,
	`first_seen_run_id` text,
	`discovered_via` text,
	`last_verified_at` text,
	`discovered_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`first_seen_run_id`) REFERENCES `runs`(`run_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `vendors_status_idx` ON `vendors` (`status`);--> statement-breakpoint
CREATE INDEX `vendors_type_idx` ON `vendors` (`vendor_type`);--> statement-breakpoint
CREATE INDEX `vendors_domain_idx` ON `vendors` (`primary_domain`);--> statement-breakpoint
CREATE INDEX `vendors_screen_idx` ON `vendors` (`screen_result`);