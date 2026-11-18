---
title: Care item cross-feature imports (C1 decision)
owner: Architecture
audience: agent
status: active
last_updated: 2026-11-18
tags: [architecture, pet-care, modularity]
---

# Care item cross-feature imports (gap-close C1)

## Decision (2026-10-04, current state 2026-11-18)

**Option 3 — defer structural split; ratchet-only until ARCH-G.**

The Care Item detail shell lives in `flutter_app/lib/features/experience/presentation/care_item/**` (composition layer). `features/care_item/**` is a **leaf**: it has no imports from `health_tracking`, `pet_care` or `experience`. The cross-feature edges that remain are the three R4 exceptions that point **into** the leaf (`health_tracking→care_item`, `pet_care→care_item`, `experience→care_item`). Recorded in `scripts/feature-import-baseline.json`. The `violations` list is empty. New edges remain blocked by `node scripts/check_feature_imports.js`.

## Rationale

- B1/B2 need stable Care Item view surfaces without a multi-PR shell extraction in the gap-close window.
- Structural split was tracked as **#1545** (DEBT-ARCH-CYCLE). The 2026-11-18 decision log below records why the remaining barrel work cannot be done without new violations.
- Re-baseline-only (option 2) adds no product value beyond the existing gate.

## B-stream guardrails

- B1/B2 must not add **new** cross-feature import edges; use existing providers/widgets or extend `care_item` internals.
- Before merging B1, run `node scripts/check_feature_imports.js` (also in CI governance).

## Decision table (P1 inventory, 2026-11-18)

Every cross-feature export that a barrel currently carries. A removed barrel export turns its consumer's import into a non-entrypoint import (R6). Moving a symbol into `experience` puts `health_tracking` or `pet_care` internals on an R1 edge. Moving it into `care_item` makes the leaf depend on `health_tracking` (R5). So for each symbol the only moves left are no-ops or changes that add violations.

| Barrel | Symbol(s) | Consumers outside owner | Decision |
|--------|-----------|-------------------------|----------|
| `health_tracking.dart` | `careItemAbsenceContextProvider`, `healthAbsenceContextRemoteProvider` (`care_item_absence_providers.dart`) | `experience/presentation/care_item/{detail,occurrence}/` (5 files); `pet_care/context/.../away_plan_care_review_section.dart` | **Keep.** Removal → R6 on composition imports; move to experience → R1 for health_tracking internals; move to care_item → R5 cycle. |
| `health_tracking.dart` | `invalidateCareItemDetailData`, `invalidateCareScheduleProviders` (`care_item_detail_refresh.dart`) | `experience/.../care_item_detail_with_absence_refresh.dart`; `pet_care/context/.../away_plan_care_review_section.dart` | **Keep.** Same reasoning. |
| `health_tracking.dart` | `syncAbsenceResolution` (`care_item_absence_resolution_sync.dart`) | No barrel-level consumer outside health_tracking | **Keep.** Export has no external consumer, but health_tracking internals use it; dropping the export is not a baseline shrink. |
| `pet_care.dart` | 11 `presentation/widgets/care_surface/*` widgets | `experience/presentation/care_item/**` (14 files); `experience/presentation/pet_profile/**` and `screens/**` (5 files) | **Keep.** Removal → R6 on 19 composition files; move to `core/widgets` is a forced refactor that does not shrink any feature edge (`experience→pet_care` exists via other symbols). |

Tests: the 11 detail tests under `test/features/care_item/presentation/detail/` cover UI that **stays** in `experience`. No subject moves, so no test relocation is required.

## Decision log (2026-11-18)

Issue #1545 (light-plan, P1–P3) executed on `claude/adoring-meitner-jl387x`:

- **P1 — inventory:** table above. Every barrel export is needed by a composition-layer consumer or by health_tracking/pet_care internals.
- **P2 — barrel hygiene:** no safe move exists. Each candidate creates R6, R1 or R5 violations, or is a forced refactor that shrinks no feature edge. P2 is **not executed**, per the issue's escalation clause.
- **P3 — gates, docs, debt:** `node scripts/check_feature_imports.js` green (R1=R2=R3=R5=R6=R7=R8=0, 35 feature edges). No `--update-baseline` (no edges dropped). This document corrected to match the code. `DEBT-ARCH-CYCLE` is recorded in `docs/debt/debt.md` as a residual open row, not closed: the 35 baselined edges and the three R4 leaf exceptions remain until ARCH-G.

Structural import-cycle split remains **deferred** to ARCH-G. No code moved in this change.

## References

- Plan: `care-requirements-gap-close-c1a7` phase C1
- Control issue: #1526
- Debt: #1545 (residual open row in `docs/debt/debt.md`)
- Gate: `scripts/check_feature_imports.js`, baseline `scripts/feature-import-baseline.json`

## Decision log (2026-11-06)

Light-plan `tech-debt-reliability-8640` **P5**: structural import-cycle split remains **deferred** to a dedicated sprint (#1545). No code split in this programme; baseline + `check_feature_imports.js` unchanged.
