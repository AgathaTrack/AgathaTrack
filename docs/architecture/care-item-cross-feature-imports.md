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

The Care Item detail shell lives in `flutter_app/lib/features/experience/presentation/care_item/**` (composition layer). `features/care_item/**` is a **leaf**: it has no imports from `health_tracking`, `pet_care` or `experience`. The cross-feature edges that remain are the three R4 exceptions that point **into** the leaf (`health_tracking→care_item`, `pet_care→care_item`, `experience→care_item`), recorded in `scripts/feature-import-baseline.json`. The `violations` list is empty. New edges remain blocked by `node scripts/check_feature_imports.js`.

## Rationale

- B1/B2 need stable Care Item view surfaces without a multi-PR shell extraction in the gap-close window.
- Structural split was tracked as **#1545** (DEBT-ARCH-CYCLE). The decision below records why the remaining barrel exports stay.
- Re-baseline-only (option 2) adds no product value beyond the existing gate.

## B-stream guardrails

- B1/B2 must not add **new** cross-feature import edges; use existing providers/widgets or extend `care_item` internals.
- Before merging B1, run `node scripts/check_feature_imports.js` (also in CI governance).

## Barrel exports (P1 inventory, 2026-11-18)

A barrel export is removable without new violations only when no consumer outside its owner depends on it. Removing an export that still has an outside consumer turns that consumer's import into a non-entrypoint import (R6). Moving a symbol into `experience` puts `health_tracking` or `pet_care` internals on an R1 edge. Moving it into `care_item` makes the leaf depend on `health_tracking` (R5).

| Barrel | Symbol(s) | Consumers outside owner | Decision |
|--------|-----------|-------------------------|----------|
| `health_tracking.dart` | `syncAbsenceResolution` (`care_item_absence_resolution_sync.dart`) | None. Both consumers are `health_tracking` widgets that import the file directly. | **Removed (P2).** Behaviour-preserving; no feature edge changes. |
| `health_tracking.dart` | `careItemAbsenceContextProvider`, `healthAbsenceContextRemoteProvider` (`care_item_absence_providers.dart`) | `experience/presentation/care_item/{detail,occurrence}/` (5 files); `pet_care/context/.../away_plan_care_review_section.dart` | **Keep.** Removal → R6 on composition imports; move to experience → R1 for health_tracking internals; move to care_item → R5 cycle. |
| `health_tracking.dart` | `invalidateCareItemDetailData`, `invalidateCareScheduleProviders` (`care_item_detail_refresh.dart`) | `experience/.../care_item_detail_with_absence_refresh.dart`; `pet_care/context/.../away_plan_care_review_section.dart` | **Keep.** Same reasoning. |
| `pet_care.dart` | 16 `care_surface` widgets, tokens and value types | 17 files under `experience/presentation/care_item/**`; 5 files under `experience/presentation/pet_profile/**` and `screens/**` | **Keep.** Removal → R6 on 22 composition files. Moving them to `core/widgets` is a forced refactor that removes no feature edge (`experience→pet_care` exists through other symbols). |

Tests: the 11 detail tests under `test/features/care_item/presentation/detail/` cover UI that **stays** in `experience`. No subject moves, so no test relocation is required.

## Decision log (2026-11-18)

- **P1 — inventory:** table above.
- **P2 — barrel hygiene:** one export removed (`syncAbsenceResolution`, no outside consumers). The remaining exports each have consumers outside their owner. Removing them creates R6/R1/R5 violations, or is a forced refactor with no edge reduction, so they are kept.
- **P3 — gates, docs, debt:** `node scripts/check_feature_imports.js` green (R1=R2=R3=R5=R6=R7=R8=0, 35 feature edges). No `--update-baseline` (no edges dropped). This document corrected to match the code. `DEBT-ARCH-CYCLE` is recorded in `docs/debt/debt.md` as a residual open row, not closed: the 35 baselined edges and the three R4 leaf exceptions remain until ARCH-G.

Structural import-cycle split remains **deferred** to ARCH-G.

## References

- Plan: `care-requirements-gap-close-c1a7` phase C1
- Control issue: #1526
- Debt: #1545 (residual open row in `docs/debt/debt.md`)
- Gate: `scripts/check_feature_imports.js`, baseline `scripts/feature-import-baseline.json`

## Decision log (2026-11-06)

Light-plan `tech-debt-reliability-8640` **P5**: structural import-cycle split remains **deferred** to a dedicated sprint (#1545). No code split in this programme; baseline + `check_feature_imports.js` unchanged.
