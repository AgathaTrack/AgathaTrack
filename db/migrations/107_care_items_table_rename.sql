-- DEBT-D-RENAME Deploy 1 (#2405): physical tables care_items / care_occurrences;
-- compatibility views health_entries / health_occurrences for rolling deploy with legacy server SQL.

ALTER TABLE health_entries RENAME TO care_items;
ALTER TABLE health_occurrences RENAME TO care_occurrences;

CREATE VIEW health_entries AS
  SELECT * FROM care_items;

CREATE VIEW health_occurrences AS
  SELECT * FROM care_occurrences;

COMMENT ON VIEW health_entries IS
  'Deploy-1 compatibility view (#2405). Drop after server SQL cuts over to care_items.';
COMMENT ON VIEW health_occurrences IS
  'Deploy-1 compatibility view (#2405). Drop after server SQL cuts over to care_occurrences.';