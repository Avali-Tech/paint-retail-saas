CREATE TYPE "public"."brand_statement_amount_mode" AS ENUM('debit_credit', 'signed');--> statement-breakpoint
CREATE TYPE "public"."brand_statement_date_format" AS ENUM('dd-mm-yyyy', 'mm-dd-yyyy', 'yyyy-mm-dd', 'dd-mon-yyyy');--> statement-breakpoint
CREATE TYPE "public"."brand_statement_grn_basis" AS ENUM('with_gst', 'taxable');--> statement-breakpoint
CREATE TYPE "public"."brand_statement_line_kind" AS ENUM('opening', 'invoice', 'credit_note', 'debit_note', 'payment', 'other');--> statement-breakpoint
CREATE TYPE "public"."brand_statement_match_source" AS ENUM('auto', 'manual', 'explained', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."brand_statement_sign_convention" AS ENUM('debit_positive', 'credit_positive');--> statement-breakpoint
CREATE TYPE "public"."brand_statement_status" AS ENUM('active', 'discarded');--> statement-breakpoint
CREATE TABLE "brand_statement_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"statement_id" uuid NOT NULL,
	"row_number" integer NOT NULL,
	"line_date" date NOT NULL,
	"kind" "brand_statement_line_kind" NOT NULL,
	"document_number" text,
	"type_text" text,
	"reference" text,
	"description" text,
	"amount_paise" bigint NOT NULL,
	CONSTRAINT "brand_statement_lines_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "brand_statement_lines_statement_id_unique" UNIQUE("organization_id","id","statement_id"),
	CONSTRAINT "brand_statement_lines_row_unique" UNIQUE("statement_id","row_number"),
	CONSTRAINT "brand_statement_lines_values" CHECK ("brand_statement_lines"."row_number" >= 1 and abs("brand_statement_lines"."amount_paise") <= 100000000000
        and ("brand_statement_lines"."amount_paise" <> 0 or "brand_statement_lines"."kind" = 'opening')
        and ("brand_statement_lines"."document_number" is null or char_length("brand_statement_lines"."document_number") between 1 and 60)
        and ("brand_statement_lines"."type_text" is null or char_length("brand_statement_lines"."type_text") between 1 and 60)
        and ("brand_statement_lines"."reference" is null or char_length("brand_statement_lines"."reference") between 1 and 120)
        and ("brand_statement_lines"."description" is null or char_length("brand_statement_lines"."description") between 1 and 300))
);
--> statement-breakpoint
ALTER TABLE "brand_statement_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "brand_statement_matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"statement_id" uuid NOT NULL,
	"line_id" uuid NOT NULL,
	"source" "brand_statement_match_source" NOT NULL,
	"goods_receipt_id" uuid,
	"benefit_receipt_id" uuid,
	"difference_paise" bigint,
	"note" text,
	"member_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "brand_statement_matches_target" CHECK (num_nonnulls("brand_statement_matches"."goods_receipt_id", "brand_statement_matches"."benefit_receipt_id")
          = case when "brand_statement_matches"."source" = 'explained' then 0 else 1 end
        and ("brand_statement_matches"."difference_paise" is null) = ("brand_statement_matches"."source" in ('explained', 'rejected'))
        and ("brand_statement_matches"."source" <> 'explained' or "brand_statement_matches"."note" is not null)
        and ("brand_statement_matches"."note" is null or char_length("brand_statement_matches"."note") between 1 and 500)
        and ("brand_statement_matches"."source" = 'auto') = ("brand_statement_matches"."member_id" is null))
);
--> statement-breakpoint
ALTER TABLE "brand_statement_matches" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "brand_statement_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"supplier_party_id" uuid NOT NULL,
	"brand_id" uuid,
	"header_rows_to_skip" integer DEFAULT 0 NOT NULL,
	"date_column" text NOT NULL,
	"document_column" text NOT NULL,
	"type_column" text,
	"reference_column" text,
	"description_column" text,
	"amount_mode" "brand_statement_amount_mode" NOT NULL,
	"debit_column" text,
	"credit_column" text,
	"amount_column" text,
	"sign_convention" "brand_statement_sign_convention" DEFAULT 'debit_positive' NOT NULL,
	"date_format" "brand_statement_date_format" DEFAULT 'dd-mm-yyyy' NOT NULL,
	"type_rules" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"date_window_days" integer DEFAULT 7 NOT NULL,
	"amount_tolerance_paise" bigint DEFAULT 100 NOT NULL,
	"grn_amount_basis" "brand_statement_grn_basis" DEFAULT 'with_gst' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by_member_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "brand_statement_templates_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "brand_statement_templates_text" CHECK ("brand_statement_templates"."name" = btrim("brand_statement_templates"."name") and char_length("brand_statement_templates"."name") between 1 and 80
        and char_length("brand_statement_templates"."date_column") between 1 and 60
        and char_length("brand_statement_templates"."document_column") between 1 and 60
        and ("brand_statement_templates"."type_column" is null or char_length("brand_statement_templates"."type_column") between 1 and 60)
        and ("brand_statement_templates"."reference_column" is null or char_length("brand_statement_templates"."reference_column") between 1 and 60)
        and ("brand_statement_templates"."description_column" is null or char_length("brand_statement_templates"."description_column") between 1 and 60)
        and ("brand_statement_templates"."debit_column" is null or char_length("brand_statement_templates"."debit_column") between 1 and 60)
        and ("brand_statement_templates"."credit_column" is null or char_length("brand_statement_templates"."credit_column") between 1 and 60)
        and ("brand_statement_templates"."amount_column" is null or char_length("brand_statement_templates"."amount_column") between 1 and 60)),
	CONSTRAINT "brand_statement_templates_amount_columns" CHECK (("brand_statement_templates"."amount_mode" = 'debit_credit') = ("brand_statement_templates"."debit_column" is not null)
        and ("brand_statement_templates"."amount_mode" = 'debit_credit') = ("brand_statement_templates"."credit_column" is not null)
        and ("brand_statement_templates"."amount_mode" = 'signed') = ("brand_statement_templates"."amount_column" is not null)),
	CONSTRAINT "brand_statement_templates_ranges" CHECK ("brand_statement_templates"."header_rows_to_skip" between 0 and 50
        and "brand_statement_templates"."date_window_days" between 0 and 60
        and "brand_statement_templates"."amount_tolerance_paise" between 0 and 100000
        and jsonb_typeof("brand_statement_templates"."type_rules") = 'object')
);
--> statement-breakpoint
ALTER TABLE "brand_statement_templates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "brand_statements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"number" text NOT NULL,
	"template_id" uuid NOT NULL,
	"supplier_party_id" uuid NOT NULL,
	"brand_id" uuid,
	"period_from" date NOT NULL,
	"period_to" date NOT NULL,
	"opening_balance_paise" bigint,
	"closing_balance_paise" bigint,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"storage_key" text,
	"status" "brand_statement_status" DEFAULT 'active' NOT NULL,
	"matched_at" timestamp with time zone,
	"uploaded_by_member_id" uuid NOT NULL,
	"discarded_at" timestamp with time zone,
	"discarded_by_member_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "brand_statements_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "brand_statements_number_unique" UNIQUE("organization_id","number"),
	CONSTRAINT "brand_statements_storage_key_unique" UNIQUE("storage_key"),
	CONSTRAINT "brand_statements_number_format" CHECK ("brand_statements"."number" ~ '^BS-[0-9]{6,}$'),
	CONSTRAINT "brand_statements_period" CHECK ("brand_statements"."period_to" >= "brand_statements"."period_from" and "brand_statements"."period_to" - "brand_statements"."period_from" < 366),
	CONSTRAINT "brand_statements_file" CHECK ("brand_statements"."size_bytes" > 0 and "brand_statements"."sha256" ~ '^[0-9a-f]{64}$'
        and char_length("brand_statements"."file_name") between 1 and 120),
	CONSTRAINT "brand_statements_discarded" CHECK (("brand_statements"."status" = 'discarded') = ("brand_statements"."discarded_at" is not null)
        and ("brand_statements"."discarded_at" is null) = ("brand_statements"."discarded_by_member_id" is null))
);
--> statement-breakpoint
ALTER TABLE "brand_statements" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "brand_statement_lines" ADD CONSTRAINT "brand_statement_lines_statement_fk" FOREIGN KEY ("organization_id","statement_id") REFERENCES "public"."brand_statements"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_statement_matches" ADD CONSTRAINT "brand_statement_matches_line_fk" FOREIGN KEY ("organization_id","line_id","statement_id") REFERENCES "public"."brand_statement_lines"("organization_id","id","statement_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_statement_matches" ADD CONSTRAINT "brand_statement_matches_goods_receipt_fk" FOREIGN KEY ("organization_id","goods_receipt_id") REFERENCES "public"."goods_receipts"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_statement_matches" ADD CONSTRAINT "brand_statement_matches_benefit_receipt_fk" FOREIGN KEY ("organization_id","benefit_receipt_id") REFERENCES "public"."brand_benefit_receipts"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_statement_matches" ADD CONSTRAINT "brand_statement_matches_member_fk" FOREIGN KEY ("organization_id","member_id") REFERENCES "public"."organization_members"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_statement_templates" ADD CONSTRAINT "brand_statement_templates_organization_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_statement_templates" ADD CONSTRAINT "brand_statement_templates_supplier_fk" FOREIGN KEY ("organization_id","supplier_party_id") REFERENCES "public"."parties"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_statement_templates" ADD CONSTRAINT "brand_statement_templates_brand_fk" FOREIGN KEY ("organization_id","brand_id") REFERENCES "public"."brands"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_statement_templates" ADD CONSTRAINT "brand_statement_templates_created_by_fk" FOREIGN KEY ("organization_id","created_by_member_id") REFERENCES "public"."organization_members"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_statements" ADD CONSTRAINT "brand_statements_organization_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_statements" ADD CONSTRAINT "brand_statements_template_fk" FOREIGN KEY ("organization_id","template_id") REFERENCES "public"."brand_statement_templates"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_statements" ADD CONSTRAINT "brand_statements_supplier_fk" FOREIGN KEY ("organization_id","supplier_party_id") REFERENCES "public"."parties"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_statements" ADD CONSTRAINT "brand_statements_brand_fk" FOREIGN KEY ("organization_id","brand_id") REFERENCES "public"."brands"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_statements" ADD CONSTRAINT "brand_statements_uploaded_by_fk" FOREIGN KEY ("organization_id","uploaded_by_member_id") REFERENCES "public"."organization_members"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_statements" ADD CONSTRAINT "brand_statements_discarded_by_fk" FOREIGN KEY ("organization_id","discarded_by_member_id") REFERENCES "public"."organization_members"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "brand_statement_matches_line_unique" ON "brand_statement_matches" USING btree ("line_id") WHERE "brand_statement_matches"."source" <> 'rejected';--> statement-breakpoint
CREATE UNIQUE INDEX "brand_statement_matches_grn_unique" ON "brand_statement_matches" USING btree ("organization_id","goods_receipt_id") WHERE "brand_statement_matches"."source" <> 'rejected' and "brand_statement_matches"."goods_receipt_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "brand_statement_matches_receipt_unique" ON "brand_statement_matches" USING btree ("organization_id","benefit_receipt_id") WHERE "brand_statement_matches"."source" <> 'rejected' and "brand_statement_matches"."benefit_receipt_id" is not null;--> statement-breakpoint
CREATE INDEX "brand_statement_matches_statement_idx" ON "brand_statement_matches" USING btree ("organization_id","statement_id");--> statement-breakpoint
CREATE UNIQUE INDEX "brand_statement_templates_name_unique" ON "brand_statement_templates" USING btree ("organization_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "brand_statements_file_unique" ON "brand_statements" USING btree ("organization_id","supplier_party_id","sha256") WHERE "brand_statements"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "brand_statements_period_unique" ON "brand_statements" USING btree ("organization_id","supplier_party_id","period_from","period_to") WHERE "brand_statements"."status" = 'active';--> statement-breakpoint
CREATE INDEX "brand_statements_supplier_idx" ON "brand_statements" USING btree ("organization_id","supplier_party_id","period_from");--> statement-breakpoint
CREATE POLICY "brand_statement_lines_tenant_isolation" ON "brand_statement_lines" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("brand_statement_lines"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("brand_statement_lines"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "brand_statement_matches_tenant_isolation" ON "brand_statement_matches" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("brand_statement_matches"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("brand_statement_matches"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "brand_statement_templates_tenant_isolation" ON "brand_statement_templates" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("brand_statement_templates"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("brand_statement_templates"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "brand_statements_tenant_isolation" ON "brand_statements" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("brand_statements"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("brand_statements"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);