ALTER TABLE "organizations" ADD COLUMN "service_types" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "service_area" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "creation_key" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_created_by_accounts_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "organizations_creation_key_uq" ON "organizations" USING btree ("created_by","creation_key");