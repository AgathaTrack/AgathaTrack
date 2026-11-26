DROP INDEX IF EXISTS idx_notifications_health_occurrence_id;

ALTER TABLE notifications DROP COLUMN IF EXISTS health_occurrence_id;