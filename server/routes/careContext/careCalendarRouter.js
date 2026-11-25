import { asyncHandler } from '../../lib/http/asyncHandler.js';
import { loadCareCalendar } from '../../lib/care/calendar/loadCareCalendar.js';
import { validateCareCalendarWindow } from '../../lib/care/calendar/validateCareCalendarWindow.js';
import { resolvePlannedAbsenceTodayIso } from '../../lib/care/plannedAbsence.js';
import { hasPetCapability, PET_CAPABILITIES } from '../../lib/petCapabilityPolicy.js';
import { extractUserId } from '../../lib/requireAuth.js';

export function registerCareCalendarRoutes(router, pool) {
  router.get('/:petId/care-calendar', asyncHandler(async (req, res) => {
    const userId = extractUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { petId } = req.params;
    const { starts_on: startsOn, ends_on: endsOn } = req.query;

    if (!(await hasPetCapability(pool, userId, petId, PET_CAPABILITIES.HEALTH_VIEW))) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const accountTodayIso = await resolvePlannedAbsenceTodayIso(pool, userId);
    const window = validateCareCalendarWindow(startsOn, endsOn, accountTodayIso);
    if (!window.ok) {
      return res.status(400).json({ error: window.error, code: window.code });
    }

    const payload = await loadCareCalendar(
      pool,
      petId,
      window.starts_on,
      window.ends_on,
      req
    );

    return res.json(payload);
  }));
}