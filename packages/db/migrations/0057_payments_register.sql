CREATE TYPE "public"."accounting_export_format" AS ENUM('tally_xml', 'xlsx');--> statement-breakpoint
CREATE TYPE "public"."cheque_status" AS ENUM('pending', 'cleared', 'bounced');--> statement-breakpoint
CREATE TYPE "public"."payment_direction" AS ENUM('in', 'out');--> statement-breakpoint
CREATE TYPE "public"."payment_mode_kind" AS ENUM('cash', 'upi', 'card', 'bank_transfer', 'cheque', 'other');--> statement-breakpoint
CREATE TYPE "public"."register_movement_kind" AS ENUM('pay_in', 'pay_out', 'bank_deposit');--> statement-breakpoint
CREATE TYPE "public"."register_session_status" AS ENUM('open', 'closed');--> statement-breakpoint
CREATE TYPE "public"."tally_ledger_purpose" AS ENUM('sales', 'composition_sales', 'output_cgst', 'output_sgst', 'output_igst', 'output_cess', 'round_off', 'party', 'walk_in', 'payment_mode');--> statement-breakpoint
CREATE TYPE "public"."tax_nature" AS ENUM('taxable', 'nil_rated', 'exempt', 'non_gst');--> statement-breakpoint
ALTER TYPE "public"."document_category" ADD VALUE 'receipt';--> statement-breakpoint
ALTER TYPE "public"."document_category" ADD VALUE 'accounting_export';--> statement-breakpoint
ALTER TYPE "public"."document_record_type" ADD VALUE 'tax_document';--> statement-breakpoint
ALTER TYPE "public"."document_record_type" ADD VALUE 'payment';--> statement-breakpoint
ALTER TYPE "public"."document_record_type" ADD VALUE 'register_session';--> statement-breakpoint
ALTER TYPE "public"."document_record_type" ADD VALUE 'accounting_export';--> statement-breakpoint
ALTER TYPE "public"."notification_event" ADD VALUE 'cheque_bounced';--> statement-breakpoint
ALTER TYPE "public"."notification_event" ADD VALUE 'register_variance';--> statement-breakpoint
CREATE TABLE "accounting_exports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"period_from" date NOT NULL,
	"period_to" date NOT NULL,
	"kinds" text[] NOT NULL,
	"format" "accounting_export_format" NOT NULL,
	"document_id" uuid,
	"voucher_count" integer DEFAULT 0 NOT NULL,
	"created_by_member_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounting_exports_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "accounting_exports_period" CHECK ("accounting_exports"."period_from" <= "accounting_exports"."period_to"),
	CONSTRAINT "accounting_exports_kinds" CHECK (cardinality("accounting_exports"."kinds") between 1 and 4
        and "accounting_exports"."kinds" <@ array['sales', 'credit_note', 'debit_note', 'receipt']::text[]),
	CONSTRAINT "accounting_exports_voucher_count" CHECK ("accounting_exports"."voucher_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "accounting_exports" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"payment_id" uuid,
	"credit_note_id" uuid,
	"document_id" uuid,
	"party_ledger_id" uuid,
	"refund_payment_id" uuid,
	"amount_paise" bigint NOT NULL,
	"reverses_allocation_id" uuid,
	"created_by_member_id" uuid,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "allocations_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "allocations_reverses_unique" UNIQUE("reverses_allocation_id"),
	CONSTRAINT "allocations_one_source" CHECK (num_nonnulls("allocations"."payment_id", "allocations"."credit_note_id") = 1),
	CONSTRAINT "allocations_one_target" CHECK (num_nonnulls("allocations"."document_id", "allocations"."party_ledger_id", "allocations"."refund_payment_id") = 1),
	CONSTRAINT "allocations_amount_sign" CHECK ("allocations"."amount_paise" <> 0
        and ("allocations"."reverses_allocation_id" is null) = ("allocations"."amount_paise" > 0)),
	CONSTRAINT "allocations_not_self" CHECK ("allocations"."payment_id" <> "allocations"."refund_payment_id")
);
--> statement-breakpoint
ALTER TABLE "allocations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ledger_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"purpose" "tally_ledger_purpose" NOT NULL,
	"rate_bps" integer,
	"nature" "tax_nature",
	"supply_type" "supply_type",
	"store_id" uuid,
	"mode_kind" "payment_mode_kind",
	"mode_id" uuid,
	"party_id" uuid,
	"tally_ledger_name" text NOT NULL,
	"tally_group" text,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_mappings_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "ledger_mappings_name_length" CHECK (char_length("ledger_mappings"."tally_ledger_name") between 1 and 200),
	CONSTRAINT "ledger_mappings_rate_range" CHECK ("ledger_mappings"."rate_bps" between 0 and 10000),
	CONSTRAINT "ledger_mappings_group" CHECK ("ledger_mappings"."tally_group" in ('Sales Accounts', 'Duties & Taxes', 'Indirect Expenses',
        'Sundry Debtors', 'Cash-in-Hand', 'Bank Accounts', 'Current Assets')),
	CONSTRAINT "ledger_mappings_match_fits_purpose" CHECK (case
        when "ledger_mappings"."purpose" in ('party', 'walk_in') then num_nonnulls("ledger_mappings"."rate_bps", "ledger_mappings"."nature", "ledger_mappings"."supply_type", "ledger_mappings"."mode_kind", "ledger_mappings"."mode_id") = 0
        when "ledger_mappings"."purpose" = 'payment_mode' then num_nonnulls("ledger_mappings"."rate_bps", "ledger_mappings"."nature", "ledger_mappings"."supply_type", "ledger_mappings"."party_id") = 0
        else num_nonnulls("ledger_mappings"."mode_kind", "ledger_mappings"."mode_id", "ledger_mappings"."party_id") = 0
      end)
);
--> statement-breakpoint
ALTER TABLE "ledger_mappings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "payment_modes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"kind" "payment_mode_kind" NOT NULL,
	"name" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_modes_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "payment_modes_organization_id_kind_unique" UNIQUE("organization_id","id","kind"),
	CONSTRAINT "payment_modes_name_length" CHECK (char_length("payment_modes"."name") between 1 and 60)
);
--> statement-breakpoint
ALTER TABLE "payment_modes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"number" text NOT NULL,
	"direction" "payment_direction" NOT NULL,
	"party_id" uuid NOT NULL,
	"mode_id" uuid NOT NULL,
	"mode_kind" "payment_mode_kind" NOT NULL,
	"amount_paise" bigint NOT NULL,
	"tendered_paise" bigint,
	"received_on" date NOT NULL,
	"reference" text,
	"cheque_date" date,
	"cheque_status" "cheque_status",
	"cheque_cleared_on" date,
	"cheque_bounced_on" date,
	"bounce_reason" text,
	"register_session_id" uuid,
	"gateway_reference" text,
	"note" text,
	"voucher_number" text,
	"voucher_fy" text,
	"voucher_series_id" uuid,
	"supplier_gstin" text,
	"created_by_member_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "payments_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "payments_organization_id_party_unique" UNIQUE("organization_id","id","party_id"),
	CONSTRAINT "payments_organization_number_unique" UNIQUE("organization_id","number"),
	CONSTRAINT "payments_voucher_unique" UNIQUE("organization_id","supplier_gstin","voucher_fy","voucher_number"),
	CONSTRAINT "payments_amount_positive" CHECK ("payments"."amount_paise" > 0),
	CONSTRAINT "payments_number_format" CHECK ("payments"."number" ~ '^R[CF]-[0-9]{6,}$'),
	CONSTRAINT "payments_tendered" CHECK ("payments"."tendered_paise" is null or ("payments"."mode_kind" = 'cash' and "payments"."direction" = 'in'
        and "payments"."tendered_paise" >= "payments"."amount_paise")),
	CONSTRAINT "payments_cheque" CHECK (("payments"."mode_kind" = 'cheque' and "payments"."direction" = 'in') = ("payments"."cheque_status" is not null)
        and ("payments"."cheque_status" is not null) = ("payments"."cheque_date" is not null)
        and ("payments"."cheque_status" is not distinct from 'cleared') = ("payments"."cheque_cleared_on" is not null)
        and ("payments"."cheque_status" is not distinct from 'bounced') = ("payments"."cheque_bounced_on" is not null)
        and ("payments"."cheque_status" is not distinct from 'bounced') = ("payments"."bounce_reason" is not null)),
	CONSTRAINT "payments_voucher" CHECK (("payments"."voucher_number" is null) = ("payments"."voucher_fy" is null)
        and ("payments"."voucher_number" is null) = ("payments"."voucher_series_id" is null)
        and ("payments"."voucher_number" is null) = ("payments"."supplier_gstin" is null)
        and "payments"."voucher_number" ~ '^[A-Z0-9/-]{1,16}$'
        and "payments"."voucher_fy" ~ '^[0-9]{4}-[0-9]{2}$'),
	CONSTRAINT "payments_text_lengths" CHECK (char_length("payments"."reference") <= 100 and char_length("payments"."note") <= 500
        and char_length("payments"."gateway_reference") <= 200 and char_length("payments"."bounce_reason") <= 500)
);
--> statement-breakpoint
ALTER TABLE "payments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "register_cash_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"kind" "register_movement_kind" NOT NULL,
	"amount_paise" bigint NOT NULL,
	"reason" text NOT NULL,
	"created_by_member_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "register_cash_movements_amount_positive" CHECK ("register_cash_movements"."amount_paise" > 0),
	CONSTRAINT "register_cash_movements_reason_length" CHECK (char_length("register_cash_movements"."reason") between 1 and 200)
);
--> statement-breakpoint
ALTER TABLE "register_cash_movements" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "register_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"register_code" text NOT NULL,
	"status" "register_session_status" DEFAULT 'open' NOT NULL,
	"opened_by_member_id" uuid NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"opening_float_paise" bigint NOT NULL,
	"opening_note" text,
	"closed_by_member_id" uuid,
	"closed_at" timestamp with time zone,
	"expected_cash_paise" bigint,
	"counted_cash_paise" bigint,
	"variance_paise" bigint,
	"denominations" jsonb,
	"closing_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "register_sessions_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "register_sessions_organization_id_store_unique" UNIQUE("organization_id","id","store_id"),
	CONSTRAINT "register_sessions_code_format" CHECK ("register_sessions"."register_code" ~ '^[A-Z0-9-]{1,20}$'),
	CONSTRAINT "register_sessions_float" CHECK ("register_sessions"."opening_float_paise" >= 0),
	CONSTRAINT "register_sessions_closed" CHECK (("register_sessions"."status" = 'closed') = ("register_sessions"."closed_at" is not null)
        and ("register_sessions"."status" = 'closed') = ("register_sessions"."closed_by_member_id" is not null)
        and ("register_sessions"."status" = 'closed') = ("register_sessions"."expected_cash_paise" is not null)
        and ("register_sessions"."status" = 'closed') = ("register_sessions"."counted_cash_paise" is not null)
        and ("register_sessions"."status" = 'closed') = ("register_sessions"."variance_paise" is not null)),
	CONSTRAINT "register_sessions_variance" CHECK ("register_sessions"."counted_cash_paise" >= 0
        and "register_sessions"."variance_paise" = "register_sessions"."counted_cash_paise" - "register_sessions"."expected_cash_paise")
);
--> statement-breakpoint
ALTER TABLE "register_sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sales_settings" ADD COLUMN "cash_needs_register" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_settings" ADD COLUMN "register_variance_alert_paise" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tax_documents" ADD COLUMN "scheme_reference" text;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_organization_id_id_unique" UNIQUE("organization_id","id");--> statement-breakpoint
ALTER TABLE "party_ledger" ADD CONSTRAINT "party_ledger_organization_id_party_unique" UNIQUE("organization_id","id","party_id");--> statement-breakpoint
ALTER TABLE "tax_documents" ADD CONSTRAINT "tax_documents_organization_id_party_unique" UNIQUE("organization_id","id","party_id");--> statement-breakpoint
ALTER TABLE "accounting_exports" ADD CONSTRAINT "accounting_exports_document_fk" FOREIGN KEY ("organization_id","document_id") REFERENCES "public"."documents"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_exports" ADD CONSTRAINT "accounting_exports_created_by_fk" FOREIGN KEY ("organization_id","created_by_member_id") REFERENCES "public"."organization_members"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_party_fk" FOREIGN KEY ("organization_id","party_id") REFERENCES "public"."parties"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_payment_fk" FOREIGN KEY ("organization_id","payment_id","party_id") REFERENCES "public"."payments"("organization_id","id","party_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_credit_note_fk" FOREIGN KEY ("organization_id","credit_note_id","party_id") REFERENCES "public"."tax_documents"("organization_id","id","party_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_document_fk" FOREIGN KEY ("organization_id","document_id","party_id") REFERENCES "public"."tax_documents"("organization_id","id","party_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_party_ledger_fk" FOREIGN KEY ("organization_id","party_ledger_id","party_id") REFERENCES "public"."party_ledger"("organization_id","id","party_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_refund_fk" FOREIGN KEY ("organization_id","refund_payment_id","party_id") REFERENCES "public"."payments"("organization_id","id","party_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_reverses_fk" FOREIGN KEY ("organization_id","reverses_allocation_id") REFERENCES "public"."allocations"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_created_by_fk" FOREIGN KEY ("organization_id","created_by_member_id") REFERENCES "public"."organization_members"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_mappings" ADD CONSTRAINT "ledger_mappings_organization_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_mappings" ADD CONSTRAINT "ledger_mappings_store_fk" FOREIGN KEY ("organization_id","store_id") REFERENCES "public"."stores"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_mappings" ADD CONSTRAINT "ledger_mappings_mode_fk" FOREIGN KEY ("organization_id","mode_id") REFERENCES "public"."payment_modes"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_mappings" ADD CONSTRAINT "ledger_mappings_party_fk" FOREIGN KEY ("organization_id","party_id") REFERENCES "public"."parties"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_modes" ADD CONSTRAINT "payment_modes_organization_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_store_fk" FOREIGN KEY ("organization_id","store_id") REFERENCES "public"."stores"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_party_fk" FOREIGN KEY ("organization_id","party_id") REFERENCES "public"."parties"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_mode_fk" FOREIGN KEY ("organization_id","mode_id","mode_kind") REFERENCES "public"."payment_modes"("organization_id","id","kind") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_register_session_fk" FOREIGN KEY ("organization_id","register_session_id","store_id") REFERENCES "public"."register_sessions"("organization_id","id","store_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_voucher_series_fk" FOREIGN KEY ("organization_id","voucher_series_id") REFERENCES "public"."document_series"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_created_by_fk" FOREIGN KEY ("organization_id","created_by_member_id") REFERENCES "public"."organization_members"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "register_cash_movements" ADD CONSTRAINT "register_cash_movements_session_fk" FOREIGN KEY ("organization_id","session_id") REFERENCES "public"."register_sessions"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "register_cash_movements" ADD CONSTRAINT "register_cash_movements_created_by_fk" FOREIGN KEY ("organization_id","created_by_member_id") REFERENCES "public"."organization_members"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "register_sessions" ADD CONSTRAINT "register_sessions_store_fk" FOREIGN KEY ("organization_id","store_id") REFERENCES "public"."stores"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "register_sessions" ADD CONSTRAINT "register_sessions_opened_by_fk" FOREIGN KEY ("organization_id","opened_by_member_id") REFERENCES "public"."organization_members"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "register_sessions" ADD CONSTRAINT "register_sessions_closed_by_fk" FOREIGN KEY ("organization_id","closed_by_member_id") REFERENCES "public"."organization_members"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounting_exports_created_idx" ON "accounting_exports" USING btree ("organization_id","created_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "allocations_payment_idx" ON "allocations" USING btree ("payment_id") WHERE "allocations"."payment_id" is not null;--> statement-breakpoint
CREATE INDEX "allocations_credit_note_idx" ON "allocations" USING btree ("credit_note_id") WHERE "allocations"."credit_note_id" is not null;--> statement-breakpoint
CREATE INDEX "allocations_document_idx" ON "allocations" USING btree ("document_id") WHERE "allocations"."document_id" is not null;--> statement-breakpoint
CREATE INDEX "allocations_party_ledger_idx" ON "allocations" USING btree ("party_ledger_id") WHERE "allocations"."party_ledger_id" is not null;--> statement-breakpoint
CREATE INDEX "allocations_refund_idx" ON "allocations" USING btree ("refund_payment_id") WHERE "allocations"."refund_payment_id" is not null;--> statement-breakpoint
CREATE INDEX "allocations_party_idx" ON "allocations" USING btree ("organization_id","party_id");--> statement-breakpoint
CREATE INDEX "ledger_mappings_purpose_idx" ON "ledger_mappings" USING btree ("organization_id","purpose","position");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_modes_name_unique" ON "payment_modes" USING btree ("organization_id",lower("name"));--> statement-breakpoint
CREATE INDEX "payments_party_idx" ON "payments" USING btree ("organization_id","party_id","received_on");--> statement-breakpoint
CREATE INDEX "payments_store_received_idx" ON "payments" USING btree ("organization_id","store_id","received_on" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "payments_organization_created_idx" ON "payments" USING btree ("organization_id","created_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "payments_register_session_idx" ON "payments" USING btree ("register_session_id") WHERE "payments"."register_session_id" is not null;--> statement-breakpoint
CREATE INDEX "register_cash_movements_session_idx" ON "register_cash_movements" USING btree ("organization_id","session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "register_sessions_one_open" ON "register_sessions" USING btree ("organization_id","store_id","register_code") WHERE "register_sessions"."status" = 'open';--> statement-breakpoint
CREATE INDEX "register_sessions_store_opened_idx" ON "register_sessions" USING btree ("organization_id","store_id","opened_at" DESC NULLS FIRST);--> statement-breakpoint
ALTER TABLE "sales_settings" ADD CONSTRAINT "sales_settings_variance_alert" CHECK ("sales_settings"."register_variance_alert_paise" >= 0);--> statement-breakpoint
CREATE POLICY "accounting_exports_tenant_isolation" ON "accounting_exports" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("accounting_exports"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("accounting_exports"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "allocations_tenant_isolation" ON "allocations" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("allocations"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("allocations"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ledger_mappings_tenant_isolation" ON "ledger_mappings" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("ledger_mappings"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("ledger_mappings"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_modes_tenant_isolation" ON "payment_modes" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("payment_modes"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("payment_modes"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payments_tenant_isolation" ON "payments" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("payments"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("payments"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "register_cash_movements_tenant_isolation" ON "register_cash_movements" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("register_cash_movements"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("register_cash_movements"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "register_sessions_tenant_isolation" ON "register_sessions" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("register_sessions"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("register_sessions"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);