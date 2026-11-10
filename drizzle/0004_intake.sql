CREATE TABLE "intake_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"intake_request_id" uuid NOT NULL,
	"from_status" "intake_status",
	"to_status" "intake_status" NOT NULL,
	"actor_type" "actor_type" NOT NULL,
	"actor_account_id" uuid,
	"note" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "intake_requests" ADD CONSTRAINT "intake_requests_org_id_uq" UNIQUE("organization_id","id");--> statement-breakpoint
ALTER TABLE "intake_requests" ADD COLUMN "service_type" text;--> statement-breakpoint
ALTER TABLE "intake_requests" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "intake_events" ADD CONSTRAINT "intake_events_actor_account_id_accounts_id_fk" FOREIGN KEY ("actor_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_events" ADD CONSTRAINT "intake_events_request_fk" FOREIGN KEY ("organization_id","intake_request_id") REFERENCES "public"."intake_requests"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "intake_events_request_idx" ON "intake_events" USING btree ("organization_id","intake_request_id","occurred_at");--> statement-breakpoint
ALTER TABLE "intake_requests" ADD CONSTRAINT "intake_requests_created_by_accounts_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;
