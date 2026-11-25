CREATE TABLE "application_drafts" (
	"job_id" integer PRIMARY KEY NOT NULL,
	"model" text NOT NULL,
	"cover_letter" text NOT NULL,
	"answers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"skipped" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "application_drafts" ADD CONSTRAINT "application_drafts_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;