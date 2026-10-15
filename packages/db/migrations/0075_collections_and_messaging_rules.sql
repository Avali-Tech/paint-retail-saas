-- Collections, party messaging and stored statement links (MVP 3 round 2a,
-- P2-M11, P2-M32, P2-M12; docs/mvp-3/credit-and-receivables.md §3.5): rules the
-- tables of 0074 keep.

-- 1. A promise keeps what was promised and only moves forward: open → kept,
-- broken or cancelled, once. Tenants never delete one.
REVOKE DELETE, TRUNCATE ON promises_to_pay FROM app_tenant;--> statement-breakpoint
CREATE FUNCTION promises_to_pay_forward_only() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  settled text[] := ARRAY['status', 'paid_paise', 'closed_at', 'closed_by_member_id', 'cancel_reason'];
BEGIN
  IF (to_jsonb(NEW) - settled) IS DISTINCT FROM (to_jsonb(OLD) - settled) THEN
    RAISE EXCEPTION 'a promise to pay keeps what was promised: record a new one instead'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NOT (OLD.status = 'open' AND NEW.status IN ('kept', 'broken', 'cancelled')) THEN
    RAISE EXCEPTION 'a % promise to pay cannot become %', OLD.status, NEW.status
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER promises_to_pay_forward_only
BEFORE UPDATE ON promises_to_pay
FOR EACH ROW EXECUTE FUNCTION promises_to_pay_forward_only();--> statement-breakpoint

-- 2. An escalation is a record: only its acknowledgement is written, once.
REVOKE DELETE, TRUNCATE ON collection_escalations FROM app_tenant;--> statement-breakpoint
CREATE FUNCTION collection_escalations_acknowledge_once() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  acknowledged text[] := ARRAY['acknowledged_by_member_id', 'acknowledged_at', 'acknowledge_note'];
BEGIN
  IF (to_jsonb(NEW) - acknowledged) IS DISTINCT FROM (to_jsonb(OLD) - acknowledged)
     OR OLD.acknowledged_at IS NOT NULL THEN
    RAISE EXCEPTION 'an escalation is only acknowledged, once'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER collection_escalations_acknowledge_once
BEFORE UPDATE ON collection_escalations
FOR EACH ROW EXECUTE FUNCTION collection_escalations_acknowledge_once();--> statement-breakpoint

-- 3. Append-only records: the daily collections runs (as credit_hold_runs, 0070)
-- and consent, whose history is the evidence (DPDP Act 2023; [CA-3]).
REVOKE UPDATE, DELETE, TRUNCATE ON collection_runs FROM app_tenant;--> statement-breakpoint
CREATE FUNCTION collection_runs_reject_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'collection_runs is append-only'
    USING ERRCODE = 'restrict_violation';
END
$$;--> statement-breakpoint
CREATE TRIGGER collection_runs_append_only
BEFORE UPDATE OR DELETE ON collection_runs
FOR EACH ROW EXECUTE FUNCTION collection_runs_reject_change();--> statement-breakpoint
CREATE TRIGGER collection_runs_no_truncate
BEFORE TRUNCATE ON collection_runs
FOR EACH STATEMENT EXECUTE FUNCTION collection_runs_reject_change();--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON messaging_consents FROM app_tenant;--> statement-breakpoint
CREATE FUNCTION messaging_consents_reject_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'messaging_consents is append-only: record the new choice instead'
    USING ERRCODE = 'restrict_violation';
END
$$;--> statement-breakpoint
CREATE TRIGGER messaging_consents_append_only
BEFORE UPDATE OR DELETE ON messaging_consents
FOR EACH ROW EXECUTE FUNCTION messaging_consents_reject_change();--> statement-breakpoint
CREATE TRIGGER messaging_consents_no_truncate
BEFORE TRUNCATE ON messaging_consents
FOR EACH STATEMENT EXECUTE FUNCTION messaging_consents_reject_change();--> statement-breakpoint

-- 4. A queued message keeps what it says and to whom; its status only moves
-- forward: queued → sent / failed / skipped (or queued again for a retry),
-- sent → delivered / read / failed, delivered → read / failed.
REVOKE DELETE, TRUNCATE ON message_outbox FROM app_tenant;--> statement-breakpoint
CREATE FUNCTION message_outbox_forward_only() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  delivery text[] := ARRAY['status', 'skip_reason', 'attempts', 'next_attempt_at', 'last_error',
    'provider', 'provider_ref', 'sent_at'];
BEGIN
  IF (to_jsonb(NEW) - delivery) IS DISTINCT FROM (to_jsonb(OLD) - delivery) THEN
    RAISE EXCEPTION 'a queued message keeps its content: queue a new one instead'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NOT (
    (OLD.status = 'queued' AND NEW.status IN ('queued', 'sent', 'failed', 'skipped'))
    OR (OLD.status = 'sent' AND NEW.status IN ('sent', 'delivered', 'read', 'failed'))
    OR (OLD.status = 'delivered' AND NEW.status IN ('delivered', 'read', 'failed'))
    OR (OLD.status = NEW.status AND OLD.status IN ('read', 'failed', 'skipped'))
  ) THEN
    RAISE EXCEPTION 'a % message cannot become %', OLD.status, NEW.status
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER message_outbox_forward_only
BEFORE UPDATE ON message_outbox
FOR EACH ROW EXECUTE FUNCTION message_outbox_forward_only();--> statement-breakpoint

-- 5. A statement link keeps its party, period and token; it is revoked once,
-- and its open count only grows.
REVOKE DELETE, TRUNCATE ON statement_links FROM app_tenant;--> statement-breakpoint
CREATE FUNCTION statement_links_keep_link() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  changing text[] := ARRAY['revoked_at', 'revoked_by_member_id', 'opened_count', 'last_opened_at'];
BEGIN
  IF (to_jsonb(NEW) - changing) IS DISTINCT FROM (to_jsonb(OLD) - changing)
     OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at)
     OR NEW.opened_count < OLD.opened_count THEN
    RAISE EXCEPTION 'a statement link is only revoked, once, or opened'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER statement_links_keep_link
BEFORE UPDATE ON statement_links
FOR EACH ROW EXECUTE FUNCTION statement_links_keep_link();--> statement-breakpoint

-- 6. Audit log (roadmap P1-M20).
CREATE TRIGGER audit_promises_to_pay
AFTER INSERT OR UPDATE ON promises_to_pay
FOR EACH ROW EXECUTE FUNCTION audit_row_change('id', 'party_id', 'amount_paise', 'promised_on', 'status', 'paid_paise', 'cancel_reason');--> statement-breakpoint
CREATE TRIGGER audit_collection_escalations
AFTER INSERT OR UPDATE ON collection_escalations
FOR EACH ROW EXECUTE FUNCTION audit_row_change('id', 'party_id', 'promise_id', 'acknowledged_by_member_id', 'acknowledge_note');--> statement-breakpoint
CREATE TRIGGER audit_reminder_schedules
AFTER INSERT OR UPDATE OR DELETE ON reminder_schedules
FOR EACH ROW EXECUTE FUNCTION audit_row_change('id', 'offset_days', 'channels', 'is_active');--> statement-breakpoint
CREATE TRIGGER audit_messaging_consents
AFTER INSERT ON messaging_consents
FOR EACH ROW EXECUTE FUNCTION audit_row_change('id', 'party_id', 'channel', 'address', 'state', 'method', 'notice_version', 'language');--> statement-breakpoint
CREATE TRIGGER audit_message_templates
AFTER INSERT OR UPDATE OR DELETE ON message_templates
FOR EACH ROW EXECUTE FUNCTION audit_row_change('id', 'key', 'channel', 'language', 'body', 'provider_template_name', 'is_active');--> statement-breakpoint
CREATE TRIGGER audit_statement_links
AFTER INSERT OR UPDATE ON statement_links
FOR EACH ROW EXECUTE FUNCTION audit_row_change('id', 'party_id', 'from_on', 'to_on', 'language', 'expires_at', 'revoked_at');
