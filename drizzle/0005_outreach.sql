ALTER TABLE "organizations" ADD COLUMN "reply_to_email" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "mailing_address" text;--> statement-breakpoint
ALTER TABLE "outreach_campaigns" ADD COLUMN "purpose" "consent_purpose" DEFAULT 'service_reminders' NOT NULL;--> statement-breakpoint
ALTER TABLE "outreach_campaigns" ADD COLUMN "service_type" text;--> statement-breakpoint
ALTER TABLE "outreach_campaigns" ADD COLUMN "audience_customer_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "outreach_messages" ADD COLUMN "unsubscribe_token_hash" text;--> statement-breakpoint
ALTER TABLE "outreach_messages" ADD CONSTRAINT "outreach_messages_unsubscribe_token_hash_unique" UNIQUE("unsubscribe_token_hash");