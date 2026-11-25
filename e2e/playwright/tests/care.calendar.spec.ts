/**
 * @bdd care_calendar.feature
 * Scenario: Dashboard calendar tab
 * Scenario: Open Care date from calendar
 */
import { test, expect, loginAs } from '../fixtures/auth.fixture';
import { GuardianDashboardPage } from '../pages/guardian-dashboard.page';
import { OccurrencePage } from '../pages/occurrence.page';
import { createCareItem, withCareClock } from '../support/care-api';
import { createPet } from '../support/api';
import {
  enableFlutterAccessibility,
  waitForFlutterRoutePattern,
} from '../support/flutter';

test.describe('Care calendar @care', () => {
  test('Dashboard calendar tab', async ({ page, testUser }) => {
    await enableFlutterAccessibility(page);
    await loginAs(page, testUser, { experience: 'guardian' });
    const dashboard = new GuardianDashboardPage(page);
    await dashboard.open();
    await page.getByRole('button', { name: /calendar|calendrier/i }).click();
    const monthLabel = page.locator(
      '[flt-semantics-identifier="care_calendar_month_label"]',
    );
    await expect(monthLabel).toBeVisible({ timeout: 60_000 });
    await expect(
      page.locator('[flt-semantics-identifier^="care_calendar_day_"]').first(),
    ).toBeVisible({ timeout: 60_000 });
  });

  test('Open Care date from calendar', async ({ page, testUser }) => {
    const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
    const today = new Date().toISOString().slice(0, 10);
    await withCareClock(`${today}T10:00`, page);
    try {
      const pet = await createPet(baseURL, testUser.accessToken, 'Cal Pet');
      const entry = await createCareItem(baseURL, testUser.accessToken, pet.id, {
        name: 'Calendar tap care',
        careFamily: 'grooming',
        frequency: 'once',
        dueDate: today,
      });
      await enableFlutterAccessibility(page);
      await loginAs(page, testUser, { experience: 'guardian' });
      const dashboard = new GuardianDashboardPage(page);
      await dashboard.open();
      await page.getByRole('button', { name: /calendar|calendrier/i }).click();
      const dayIso = today;
      const dayCell = page.locator(
        `[flt-semantics-identifier="care_calendar_day_${dayIso}"]`,
      );
      await expect(dayCell).toBeVisible({ timeout: 30_000 });
      await dayCell.click();
      const occurrence = new OccurrencePage(page);
      await waitForFlutterRoutePattern(page, /\/occurrences\//, 60_000);
      await occurrence.expectLoaded();
      await expect(
        page.getByRole('heading', { name: /Calendar tap care/i }),
      ).toBeVisible();
      expect(entry.id).toBeTruthy();
    } finally {
      await withCareClock(null, page);
    }
  });
});