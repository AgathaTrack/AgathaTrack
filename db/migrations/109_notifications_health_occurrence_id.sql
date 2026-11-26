-- Care notification taps deep-link to the occurrence screen (DEBT-D-NOTIF / #1540).

ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS health_occurrence_id UUID REFERENCES care_occurrences(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_notifications_health_occurrence_id
  ON notifications (health_occurrence_id)
  WHERE health_occurrence_id IS NOT NULL;