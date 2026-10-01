CREATE TYPE "public"."document_category" AS ENUM('gst_certificate', 'pan_card', 'trade_licence', 'cancelled_cheque', 'contract', 'quotation', 'invoice', 'delivery_challan', 'photo', 'other');--> statement-breakpoint
CREATE TYPE "public"."document_record_type" AS ENUM('party', 'product', 'store', 'purchase_order', 'goods_receipt', 'transfer', 'stock_count');--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"record_type" "document_record_type" NOT NULL,
	"record_id" uuid NOT NULL,
	"category" "document_category" NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"storage_key" text NOT NULL,
	"uploaded_by_member_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_by_member_id" uuid,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "documents_storage_key_unique" UNIQUE("storage_key"),
	CONSTRAINT "documents_size_positive" CHECK ("documents"."size_bytes" > 0),
	CONSTRAINT "documents_sha256_format" CHECK ("documents"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "documents_deleted_together" CHECK (("documents"."deleted_at" is null) = ("documents"."deleted_by_member_id" is null))
);
--> statement-breakpoint
ALTER TABLE "documents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_uploaded_by_fk" FOREIGN KEY ("organization_id","uploaded_by_member_id") REFERENCES "public"."organization_members"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_deleted_by_fk" FOREIGN KEY ("organization_id","deleted_by_member_id") REFERENCES "public"."organization_members"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "documents_record_idx" ON "documents" USING btree ("organization_id","record_type","record_id") WHERE "documents"."deleted_at" is null;--> statement-breakpoint
CREATE POLICY "documents_tenant_isolation" ON "documents" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("documents"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("documents"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);