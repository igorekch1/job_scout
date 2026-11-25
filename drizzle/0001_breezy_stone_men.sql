ALTER TABLE "tracker_entries" ADD COLUMN "tracker" text DEFAULT 'postgres' NOT NULL;--> statement-breakpoint
ALTER TABLE "tracker_entries" ADD COLUMN "external_ref" text;--> statement-breakpoint
ALTER TABLE "tracker_entries" ADD COLUMN "external_url" text;