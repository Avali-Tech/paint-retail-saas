-- Audit log (roadmap P1-M20) for contracts (P1-M24): who created a contract,
-- and who changed its status, dates or value.
CREATE TRIGGER audit_contracts
AFTER INSERT OR UPDATE ON contracts
FOR EACH ROW EXECUTE FUNCTION audit_row_change('id', 'status', 'start_date', 'end_date', 'renewal_date', 'value_paise', 'termination_reason');
