/**
 * In-app deep link for a care notification tied to a care item.
 * When [healthOccurrenceId] is set, opens the occurrence screen with `source=notification`.
 * Returns null when pet or entry id is missing.
 */
export function buildNotificationDeepLink(
  petId,
  healthEntryId,
  healthOccurrenceId = null,
) {
  if (!petId || !healthEntryId) return null;
  if (healthOccurrenceId) {
    return `/pet/${petId}/events/${healthEntryId}/occurrences/${healthOccurrenceId}?source=notification`;
  }
  return `/pet/${petId}/events/${healthEntryId}`;
}