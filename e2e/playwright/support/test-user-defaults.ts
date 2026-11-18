/**
 * Signup defaults shared by `signupUser` (api.ts), `signupUserViaUi` (ui-auth.ts) and the
 * live-UAT helper (create-live-uat-user.ts). No runtime imports, so it compiles under
 * `tsconfig.unit.json`.
 */

export const DEFAULT_TEST_PASSWORD = 'E2eTestPass1';
export const DEFAULT_TEST_FIRST_NAME = 'E2E';
export const DEFAULT_TEST_LAST_NAME = 'User';

/** A unique address per call: `e2e-<timestamp>-<random>@example.com`. */
export function generateTestEmail(): string {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return `e2e-${suffix}@example.com`;
}
