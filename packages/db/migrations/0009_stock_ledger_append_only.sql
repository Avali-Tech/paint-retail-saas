-- The stock ledger is a permanent record: entries can be added, never changed
-- or removed. Corrections are new entries (adjustment, count_correction).

-- 1. Tenants may only read and insert.
REVOKE UPDATE, DELETE ON stock_ledger FROM app_tenant;--> statement-breakpoint

-- 2. Nobody may change or remove an entry, whatever their role.
CREATE FUNCTION stock_ledger_reject_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'stock_ledger is append-only: record a correcting entry instead'
    USING ERRCODE = 'restrict_violation';
END
$$;--> statement-breakpoint

CREATE TRIGGER stock_ledger_append_only
BEFORE UPDATE OR DELETE ON stock_ledger
FOR EACH ROW EXECUTE FUNCTION stock_ledger_reject_change();--> statement-breakpoint

CREATE TRIGGER stock_ledger_no_truncate
BEFORE TRUNCATE ON stock_ledger
FOR EACH STATEMENT EXECUTE FUNCTION stock_ledger_reject_change();
