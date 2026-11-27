-- DEBT-D-RENAME Deploy 2 (#2405): drop compatibility views; server SQL targets care_items / care_occurrences.

DROP VIEW IF EXISTS health_occurrences;
DROP VIEW IF EXISTS health_entries;