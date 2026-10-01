-- Audit log (roadmap P1-M20): who changed the business's branding, from what to what.
CREATE TRIGGER audit_organization_branding
AFTER INSERT OR UPDATE ON organization_branding
FOR EACH ROW EXECUTE FUNCTION audit_row_change('organization_id', 'branding');
