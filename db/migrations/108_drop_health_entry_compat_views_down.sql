-- Rollback Deploy 2 views only (requires care_items / care_occurrences physical tables).

CREATE VIEW health_entries AS
  SELECT * FROM care_items;

CREATE VIEW health_occurrences AS
  SELECT * FROM care_occurrences;