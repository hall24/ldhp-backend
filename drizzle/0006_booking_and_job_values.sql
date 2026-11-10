ALTER TABLE "organizations" ADD COLUMN "booking_url" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "job_values_cents" jsonb DEFAULT '{}'::jsonb NOT NULL;