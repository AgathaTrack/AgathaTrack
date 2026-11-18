import type { Page } from '@playwright/test';
import { LandingPage } from '../pages/landing.page';
import { PetListPage } from '../pages/pet-list.page';
import type { TestUser } from './api';
import { isLiveUatTarget } from './hosting';
import { createLiveUatUser } from './create-live-uat-user';
import { refreshFlutterAccessibility } from './flutter';
import { normalizeStoredToken } from './normalize-stored-token';
import {
  DEFAULT_TEST_FIRST_NAME,
  DEFAULT_TEST_LAST_NAME,
  DEFAULT_TEST_PASSWORD,
  generateTestEmail,
} from './test-user-defaults';

export async function readAccessTokenFromPage(page: Page): Promise<string> {
  const raw = await page.evaluate(() => {
    const sessionToken = sessionStorage.getItem('e2e_access_token');
    if (sessionToken) return sessionToken;
    const keys = Object.keys(localStorage);
    for (const key of keys) {
      if (key.includes('auth_access_token')) {
        const value = localStorage.getItem(key);
        if (value) return value;
      }
    }
    return localStorage.getItem('auth_access_token');
  });
  if (!raw) {
    throw new Error('UI signup succeeded but no auth_access_token found in localStorage');
  }
  return normalizeStoredToken(raw);
}

/** Create a user through the Flutter signup form (no REST pre-seed). */
export async function signupUserViaUi(
  page: Page,
  overrides: Partial<{
    email: string;
    password: string;
    firstName: string;
    lastName: string;
  }> = {},
): Promise<TestUser> {
  const email = overrides.email ?? generateTestEmail();
  const password = overrides.password ?? DEFAULT_TEST_PASSWORD;
  const firstName = overrides.firstName ?? DEFAULT_TEST_FIRST_NAME;
  const lastName = overrides.lastName ?? DEFAULT_TEST_LAST_NAME;

  const landing = new LandingPage(page);
  await landing.goto();
  await landing.signupAndReachHome({ firstName, lastName, email, password });

  await refreshFlutterAccessibility(page);
  const petList = new PetListPage(page);
  await petList.expectLoaded();

  const accessToken = await readAccessTokenFromPage(page);
  return {
    email,
    password,
    firstName,
    lastName,
    accessToken,
    userId: '',
  };
}

export async function createTestUser(
  page: Page,
  baseURL: string,
  overrides: Partial<{
    email: string;
    password: string;
    firstName: string;
    lastName: string;
  }> = {},
): Promise<TestUser> {
  const { signupUser, getCurrentUser, loginUser } = await import('./api');

  if (!isLiveUatTarget(baseURL)) {
    return signupUser(baseURL, overrides);
  }

  // Live UAT: one account per call. Signup is retried only while it throws, verification is
  // retried without signing up again, and UI signup is the last resort (it can be blocked by the
  // consent banner or form latency, so an API-created user is preferred even if unverified).
  return createLiveUatUser(
    {
      signup: (creds) => signupUser(baseURL, creds),
      verify: async (user) => {
        const profile = await getCurrentUser(baseURL, user.accessToken);
        return profile?.email === user.email;
      },
      login: (creds) => loginUser(baseURL, creds),
      uiFallback: (creds) => signupUserViaUi(page, creds),
      wait: (ms) => page.waitForTimeout(ms),
      warn: (message) => console.warn(message),
    },
    overrides,
  );
}
