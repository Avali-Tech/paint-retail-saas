ALTER TABLE "parties" ADD COLUMN "merged_into_id" uuid;--> statement-breakpoint
ALTER TABLE "parties" ADD COLUMN "merged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "parties" ADD COLUMN "merged_by_member_id" uuid;--> statement-breakpoint
ALTER TABLE "parties" ADD CONSTRAINT "parties_merged_into_fk" FOREIGN KEY ("organization_id","merged_into_id") REFERENCES "public"."parties"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parties" ADD CONSTRAINT "parties_merged_by_fk" FOREIGN KEY ("organization_id","merged_by_member_id") REFERENCES "public"."organization_members"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parties" ADD CONSTRAINT "parties_merge_complete" CHECK (("parties"."merged_into_id" is null) = ("parties"."merged_at" is null) and ("parties"."merged_at" is null) = ("parties"."merged_by_member_id" is null));--> statement-breakpoint
ALTER TABLE "parties" ADD CONSTRAINT "parties_not_merged_into_self" CHECK ("parties"."merged_into_id" <> "parties"."id");--> statement-breakpoint
ALTER TABLE "parties" ADD CONSTRAINT "parties_merged_inactive" CHECK ("parties"."merged_into_id" is null or not "parties"."is_active");