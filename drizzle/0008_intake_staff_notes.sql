ALTER TABLE "intake_requests" ADD COLUMN "staff_notes" text;--> statement-breakpoint
ALTER TABLE "intake_requests" ADD COLUMN "staff_notes_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "intake_requests" ADD COLUMN "staff_notes_updated_by" uuid;--> statement-breakpoint
ALTER TABLE "intake_requests" ADD CONSTRAINT "intake_requests_staff_notes_updated_by_accounts_id_fk" FOREIGN KEY ("staff_notes_updated_by") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;