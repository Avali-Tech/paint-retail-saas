-- Audit log (roadmap P1-M20): who merged a duplicate party into which one.
CREATE TRIGGER audit_party_merges
AFTER UPDATE ON parties
FOR EACH ROW EXECUTE FUNCTION audit_row_change('id', 'merged_into_id');
