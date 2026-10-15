-- Painter points from invoices (MVP 3 round 2a, P2-M36;
-- docs/mvp-3/credit-and-receivables.md §3.4, §6.5): audit log (roadmap P1-M20)
-- of the rules that decide how many points a painter earns.
CREATE TRIGGER audit_loyalty_earn_rules
AFTER INSERT OR UPDATE OR DELETE ON loyalty_earn_rules
FOR EACH ROW EXECUTE FUNCTION audit_row_change('id', 'name', 'basis', 'points', 'per_paise', 'per_millilitres', 'brand_id', 'multiplier_bps', 'valid_from', 'valid_until', 'is_active');
