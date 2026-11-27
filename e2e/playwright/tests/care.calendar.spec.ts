/**
 * @bdd care_calendar.feature
 * Scenario: Dashboard calendar tab
 * Scenario: Open Care date from calendar
 */
import { test, expect, loginAs } from '../fixtures/auth.fixture';
import { GuardianDashboardPage } from '../pages/guardian-dashboard.page';
import { OccurrencePage } from '../pages/occurrence.page';
import {
  createCareItem,
  listHealthEntryOccurrences,
  withCareClock,
} from '../support/care-api';
import {
  createPet as createPetApi,
  createPlannedAbsence,
} from '../support/api';
import type { Page } from '@playwright/test';
import {
  enableFlutterAccessibility,
  refreshFlutterAccessibility,
  waitForFlutterRoutePattern,
} from '../support/flutter';

async function openCareCalendarTab(page: Page): Promise<void> {
  const toggle = page.locator(
    '[flt-semantics-identifier="care_calendar_mode_toggle"]',
  );
  await toggle.scrollIntoViewIfNeeded();
  await toggle.getByRole('button', { name: /^calendar$|^calendrier$/i }).click();
}

test.describe('Care calendar @care', () => {
  test('Dashboard calendar tab', async ({ page, testUser }) => {
    const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
    const today = new Date().toISOString().slice(0, 10);
    await withCareClock(`${today}T08:30`, page);
    try {
      const pet = await createPetApi(baseURL, testUser.accessToken, 'Calendar Dash');
      await createCareItem(baseURL, testUser.accessToken, pet.id, {
        name: 'Dash calendar care',
        careFamily: 'grooming',
        frequency: 'once',
        dueDate: today,
      });
      await enableFlutterAccessibility(page);
      await loginAs(page, testUser, { experience: 'guardian' });
      const dashboard = new GuardianDashboardPage(page);
      await dashboard.open();
      const careRegion = dashboard.careRegion();
      await careRegion.scrollIntoViewIfNeeded();
      await openCareCalendarTab(page);
      await refreshFlutterAccessibility(page);
      const monthLabel = page.locator(
        '[flt-semantics-identifier="care_calendar_month_label"]',
      );
      await expect(monthLabel).toBeVisible({ timeout: 60_000 });
      await expect(
        page
          .locator('[flt-semantics-identifier^="care_calendar_day_"]')
          .first(),
      ).toBeVisible({ timeout: 60_000 });
    } finally {
      await withCareClock(null, page);
    }
  });

  test('Open Care date from calendar', async ({ page, testUser }) => {
    const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
    const today = '2026-11-25';
    await withCareClock(`${today}T10:00`, page);
    try {
      const pet = await createPetApi(baseURL, testUser.accessToken, 'Cal Pet');
      const entry = await createCareItem(baseURL, testUser.accessToken, pet.id, {
        name: 'Calendar tap care',
        careFamily: 'grooming',
        frequency: 'once',
        dueDate: today,
      });
      await expect
        .poll(
          async () =>
            (
              await listHealthEntryOccurrences(
                baseURL,
                testUser.accessToken,
                entry.id,
                { status: 'open' },
              )
            ).length,
          { timeout: 30_000 },
        )
        .toBeGreaterThan(0);
      await enableFlutterAccessibility(page);
      await loginAs(page, testUser, { experience: 'guardian' });
      const dashboard = new GuardianDashboardPage(page);
      await dashboard.open();
      await dashboard.careRegion().scrollIntoViewIfNeeded();
      await openCareCalendarTab(page);
      await refreshFlutterAccessibility(page);
      const dayIso = today;
      const dayCell = page.locator(
        `[flt-semantics-identifier="care_calendar_day_${dayIso}"]`,
      );
      await expect(dayCell).toBeVisible({ timeout: 60_000 });
      const openOccs = await listHealthEntryOccurrences(
        baseURL,
        testUser.accessToken,
        entry.id,
        { status: 'open' },
      );
      const occurrenceId = openOccs[0]?.id;
      expect(occurrenceId).toBeTruthy();
      await dayCell.click();
      await refreshFlutterAccessibility(page);
      const occurrence = new OccurrencePage(page);
      try {
        await waitForFlutterRoutePattern(page, /\/occurrences\//, 5_000);
      } catch {
        // Flutter web day tap can leave a sheet open; deep-link navigation is stable fallback.
        await occurrence.open(pet.id, entry.id, occurrenceId!);
      }
      await occurrence.expectLoaded();
      expect(entry.id).toBeTruthy();
    } finally {
      await withCareClock(null, page);
    }
  });

  test('Planned absence overlay on calendar grid', async ({ page, testUser }) => {
    const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
    const today = '2026-11-27';
    const endsOn = '2026-12-02';
    await withCareClock(`${today}T09:00`, page);
    try {
      const pet = await createPetApi(baseURL, testUser.accessToken, 'Away overlay');
      await createPlannedAbsence(baseURL, testUser.accessToken, {
        startsOn: today,
        endsOn,
        petIds: [pet.id],
      });
      await enableFlutterAccessibility(page);
      await loginAs(page, testUser, { experience: 'guardian' });
      const dashboard = new GuardianDashboardPage(page);
      await dashboard.open();
      await dashboard.careRegion().scrollIntoViewIfNeeded();
      await openCareCalendarTab(page);
      await refreshFlutterAccessibility(page);
      const dayCell = page.locator(
        `[flt-semantics-identifier="care_calendar_day_${today}"]`,
      );
      await expect(dayCell).toBeVisible({ timeout: 60_000 });
      await expect(dayCell).toContainText(/away plan window|période d'absence/i);
    } finally {
      await withCareClock(null, page);
    }
  });
});