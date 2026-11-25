/** @bdd care_calendar.feature#Dashboard calendar tab */

import { test, expect, loginAs } from '../fixtures/auth.fixture';
import { GuardianDashboardPage } from '../pages/guardian-dashboard.page';
import { enableFlutterAccessibility } from '../support/flutter';

test.describe('Care calendar @care', () => {
  test('dashboard shows calendar tab', async ({ page, testUser }) => {
    await enableFlutterAccessibility(page);
    await loginAs(page, testUser, { experience: 'guardian' });
    const dashboard = new GuardianDashboardPage(page);
    await dashboard.open();
    await page.getByRole('button', { name: /calendar|calendrier/i }).click();
    await expect(page.locator('[flt-semantics-identifier="care_calendar_mode_toggle"]')).toBeVisible();
  });
});