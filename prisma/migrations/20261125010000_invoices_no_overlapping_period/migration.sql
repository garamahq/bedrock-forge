-- Enforce non-overlapping billing periods per project at the database level (#69).
-- Requires btree_gist so BIGINT project_id can participate in a GiST exclusion constraint.
CREATE EXTENSION IF NOT EXISTS "btree_gist";

ALTER TABLE "invoices"
ADD CONSTRAINT "invoices_no_overlapping_project_period"
EXCLUDE USING gist (
  "project_id" WITH =,
  tstzrange("period_start", "period_end", '[]') WITH &&
);
