---
title: Care calendar (read-only)
domain: pet_care
feature_id: care_calendar
status: active
related_prs: [2610]
related_bdd: []
last_updated: 2026-11-27
tags: [pet_care, care, calendar]
---

# Care calendar (read-only)

## Summary / scope

- **Owns:** Month grid of open/projected care beside the care agenda on the Pet Care dashboard and pet profile; `GET /api/pets/:petId/care-calendar`; server-side visibility and calendar DTO.
- **Does not own:** Agenda actions (D-CIE-025), away-plan JSON (`care-period-projection`), cross-pet routes, client-only filtering.
- **Depends on:** Schedule projection (`loadScheduleDataForProjection` + `projectSchedule`), occurrence status helpers, `HEALTH_VIEW`, pet home timezone + account timezone for window caps.

## Vocabulary

EN **Care calendar** / FR **Calendrier de soins** — read-only month view. **Before this month** strip for overdue outside the grid window.

## Requirements

| ID | Rule | Status |
|----|------|--------|
| CARE-CALENDAR-R-001 | Read-only calendar beside agenda; agenda unchanged as action hub | Live |
| CARE-CALENDAR-R-002 | `GET /api/pets/:petId/care-calendar` with inclusive window ≤ 42 days; `starts_on ≥ account_today − 70`; `ends_on ≤ account_today + 366` | Live |
| CARE-CALENDAR-R-003 | Projection via `projectSchedule` path; statuses via `occurrenceDto` / `occurrenceStatus`; retain `uncertainties` for notices | Live |
| CARE-CALENDAR-R-004 | Materialised open rows may open Care date; projected rows informational only | Live |
| CARE-CALENDAR-R-005 | `HEALTH_VIEW` authorization; foster/org/view-only matrix same as health read | Live |
| CARE-CALENDAR-R-006 | Server excludes paused/ended series and done/skipped occurrences | Live |
| CARE-CALENDAR-R-007 | Month chrome uses account `users.timezone` (fallback UTC); wire dates in pet home TZ | Live |
| CARE-CALENDAR-R-008 | Overdue before window in `before_month` strip; day cells upcoming/future only | Live |
| CARE-CALENDAR-R-009 | Fixed-schedule stack: one day marker with count | Live |
| CARE-CALENDAR-R-010 | Multi-pet dashboard: parallel fetch concurrency 4; cancel on month change; per-pet error chip | Live |
| CARE-CALENDAR-R-011 | Empty/sparse month copy EN+FR + release-note expectation for after-it's-done sparsity | Live |
| CARE-CALENDAR-R-012 | Semantics ids `care_calendar_*` on web | Live |
| CARE-CALENDAR-R-017 | `planned_absence_overlays[]` on care-calendar for declarer, Full-access co-visible (R-032), and in-window guest grants; clipped to request window | Live |
| CARE-CALENDAR-R-018 | Absence overlay does not count toward care badges; mixed-day care tap unchanged | Live |
| CARE-CALENDAR-R-019 | Overlay layer distinct from care markers (theme away tokens / semantics) | Live |
| CARE-CALENDAR-R-020 | Absence-only day with `can_open_away_plan` navigates to pet away plan | Live |

## Acceptance criteria

| Given / When / Then | Requirement | Coverage |
|---------------------|-------------|----------|
| Given a carer with HEALTH_VIEW When they request a valid 42-day window Then the API returns days[], before_month, notices, and as_of | CARE-CALENDAR-R-002 | test: server/test/careContext/careCalendarApi.test.js |
| Given a window > 42 inclusive days When requested Then 400 `care_calendar_window_span` | CARE-CALENDAR-R-002 | test: server/test/care/careCalendarWindow.test.js |
| Given dashboard pets excluding passed-away When Calendar tab is selected Then each pet loads via care-calendar with concurrency 4 | CARE-CALENDAR-R-010 | bdd: flutter_app/test/bdd/features/care_calendar.feature#Dashboard calendar tab |
| Given a materialised occurrence When user taps a single-item day Then Care date opens via `openOccurrenceScreen` | CARE-CALENDAR-R-004 | bdd: flutter_app/test/bdd/features/care_calendar.feature#Open Care date from calendar |
| Given after-it's-done sparse projection When future month has no dated slots Then empty-state copy explains sparsity | CARE-CALENDAR-R-011 | test: flutter_app/test/features/pet_care/calendar/care_calendar_empty_month_test.dart |
| Given declarer absence overlapping the request window When care-calendar loads Then `planned_absence_overlays` lists clipped overlay dates | CARE-CALENDAR-R-017 | test: server/test/care/loadPlannedAbsenceOverlays.test.js |
| Given a day with care markers and absence overlay When the user taps Then care day-sheet behaviour is unchanged and absence is not counted as a care item | CARE-CALENDAR-R-018 | test: flutter_app/test/features/pet_care/calendar/care_calendar_overlay_test.dart |
| Given absence overlay days When the grid renders Then tint or icon layer is distinct from care badges with `care_calendar_*` semantics | CARE-CALENDAR-R-019 | test: flutter_app/test/features/pet_care/calendar/care_calendar_overlay_test.dart |
| Given an absence-only day with `can_open_away_plan` When the user activates the day Then navigation opens the pet away plan screen | CARE-CALENDAR-R-020 | test: e2e/playwright/tests/care.calendar.spec.ts |

## States & data

Wire shape (indicative):

```json
{
  "pet_id": "…",
  "as_of": { "date": "YYYY-MM-DD", "time": "HH:MM", "timezone": "IANA" },
  "starts_on": "YYYY-MM-DD",
  "ends_on": "YYYY-MM-DD",
  "projection_status": "complete|partially_indeterminate",
  "before_month": { "items": [] },
  "days": [{ "date": "YYYY-MM-DD", "items": [] }],
  "notices": [{ "kind": "from_completion_chain", "health_entry_id": "…" }],
  "planned_absence_overlays": [{
    "absence_id": "…",
    "starts_on": "YYYY-MM-DD",
    "ends_on": "YYYY-MM-DD",
    "overlay_starts_on": "YYYY-MM-DD",
    "overlay_ends_on": "YYYY-MM-DD",
    "declarer_is_viewer": true,
    "can_open_away_plan": true
  }]
}
```

Day `items[]` include `display_status` (`coming_up`|`due`|`overdue`|`not_recorded`), `source` (`materialised`|`projected`), `scheduled_date`, `scheduled_time`, care metadata.

## UX surfaces

- Pet Care dashboard care block: Agenda | Calendar segmented control (D-CAL-001).
- Pet profile care section: same pattern, single pet.
- Day sheet bottom sheet for multi-item / stack days (D-CAL-011).

## Out of scope (v1)

Cross-pet route; new GoRoute; `loadAwayPlanProjection` / away-plan JSON passthrough; v1 forward estimator for `from_completion`; done/skipped on grid.

## Release note (accepted product risk)

**EN:** The care calendar may show few future dates for after-it's-done care until you mark care done — use the agenda for what needs attention today.

**FR:** Le calendrier peut afficher peu de dates futures pour les soins « après réalisation » tant qu'un soin n'est pas marqué comme fait — l'ordre du jour reste la référence pour aujourd'hui.

## Decision log

| ID | Decision | Rationale | Status | Date | PR |
|----|----------|-----------|--------|------|-----|
| D-CAL-001 | Surfaces beside agenda; agenda unchanged | Owner v1 | Live | 2026-11-17 | — |
| D-CAL-002 | Dedicated `care-calendar` route and window rules | Distinct from away-plan | Live | 2026-11-17 | — |
| D-CAL-003 | `projectSchedule` + calendar mapper; uncertainties preserved | No `formatProjectionReadContract` | Live | 2026-11-17 | — |
| D-CAL-004 | Read-only; projected visually distinct | v1 | Live | 2026-11-17 | — |
| D-CAL-005 | Materialised → Care date; projected info only | D-CAL-011 | Live | 2026-11-17 | — |
| D-CAL-006 | `HEALTH_VIEW` authz | Foster/org view | Live | 2026-11-17 | — |
| D-CAL-007 | Server filter paused/ended; no done/skipped on grid | INV-4 spirit | Live | 2026-11-17 | — |
| D-CAL-008 | Account TZ chrome; pet-home wire dates | D-CIE-023 chain | Live | 2026-11-17 | — |
| D-CAL-009 | Stack: one marker + count | AG-7 | Live | 2026-11-17 | — |
| D-CAL-010 | v2 overlay #2418 | Tracked in #2418; not in v1 | Live | 2026-11-17 | — |
| D-CAL-011 | Day sheet + Care date rules | No list rows | Live | 2026-11-17 | — |
| D-CAL-012 | `before_month` strip | Overdue outside grid | Live | 2026-11-17 | — |
| D-CAL-013 | Sparse `from_completion` + month notices | D-CAL-013 | Live | 2026-11-17 | — |
| D-CAL-014 | Merge pet A→Z; within day earliest instant first; cells upcoming-only | Dashboard merge | Live | 2026-11-17 | — |
| D-CAL-015 | Concurrency 4; cancel; per-pet chip | Dashboard | Live | 2026-11-17 | — |
| D-CAL-016 | Empty/sparse copy + release note | Product risk | Live | 2026-11-17 | — |

## Related

| Kind | Link |
|------|------|
| BDD | `flutter_app/test/bdd/features/care_calendar.feature` |
| API | `docs/architecture/api-reference.md` § Care calendar |
| Agenda | [care-item-evolution.md](./care-item-evolution.md) D-CIE-025 |
| Issue | [#1539](https://github.com/AgathaTrack/AgathaTrack/issues/1539) |