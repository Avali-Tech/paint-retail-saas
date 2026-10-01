-- Global search (roadmap P1-M21) finds records by any part of a name, SKU or
-- mobile number (ILIKE '%…%'). Trigram indexes keep that fast as data grows.
-- pg_trgm ships with PostgreSQL and is allowed on Amazon RDS.
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE INDEX parties_display_name_trgm_idx ON parties USING gin (display_name gin_trgm_ops);--> statement-breakpoint
CREATE INDEX parties_phone_trgm_idx ON parties USING gin (phone gin_trgm_ops);--> statement-breakpoint
CREATE INDEX products_name_trgm_idx ON products USING gin (name gin_trgm_ops);--> statement-breakpoint
CREATE INDEX product_variants_sku_trgm_idx ON product_variants USING gin (sku gin_trgm_ops);--> statement-breakpoint
CREATE INDEX leads_title_trgm_idx ON leads USING gin (title gin_trgm_ops);--> statement-breakpoint
CREATE INDEX opportunities_title_trgm_idx ON opportunities USING gin (title gin_trgm_ops);--> statement-breakpoint
CREATE INDEX projects_name_trgm_idx ON projects USING gin (name gin_trgm_ops);
