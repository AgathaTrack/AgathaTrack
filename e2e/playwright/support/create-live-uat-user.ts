/**
 * Live-UAT account creation control flow, kept free of Playwright and REST imports so it
 * compiles under `tsconfig.unit.json` and can be unit-tested with injected fakes.
 *
 * Contract (#311): at most one account is created per call.
 *  1. Signup phase: the email is chosen once and reused on every attempt. `signup` is retried
 *     (up to {@link MAX_ATTEMPTS}) only while it throws. A later attempt that is told the email
 *     already exists means an earlier attempt committed (its response was lost), so we log in
 *     with the same credentials instead of signing up again.
 *  2. Verify phase: once an account exists, only `verify` is retried. The user is returned even
 *     when verification never succeeds (WAF / cold start on `/auth/me`).
 *  3. UI fallback only when every signup attempt failed.
 */

/** Structurally the same as `TestUser` in `./api`; duplicated to avoid importing it. */
export interface LiveUatUser {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  accessToken: string;
  userId: string;
}

export interface LiveUatCredentials {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
}

export type LiveUatOverrides = Partial<LiveUatCredentials>;

export interface LiveUatDeps {
  /** API signup; throws on any non-2xx response. */
  signup: (creds: LiveUatCredentials) => Promise<LiveUatUser>;
  /** True when the account is visible to the API (`/auth/me` returns the same email). */
  verify: (user: LiveUatUser) => Promise<boolean>;
  /** API login for an account an earlier signup attempt created. */
  login: (creds: LiveUatCredentials) => Promise<LiveUatUser>;
  /** Signup through the Flutter form; last resort. */
  uiFallback: (creds: LiveUatCredentials) => Promise<LiveUatUser>;
  wait: (ms: number) => Promise<void>;
  warn?: (message: string) => void;
}

export const MAX_ATTEMPTS = 3;
export const RETRY_DELAY_MS = 1_500;

/** `signupUser` throws `signup failed (400): {"error":"Email already exists."}`. */
export function isDuplicateEmailError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /signup failed \(400\)/.test(message) && /Email already exists/i.test(message);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Same defaults as `signupUser`, resolved once so every attempt uses the same account. */
function resolveCredentials(overrides: LiveUatOverrides): LiveUatCredentials {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    email: overrides.email ?? `e2e-${suffix}@example.com`,
    password: overrides.password ?? 'E2eTestPass1',
    firstName: overrides.firstName ?? 'E2E',
    lastName: overrides.lastName ?? 'User',
  };
}

async function signupPhase(creds: LiveUatCredentials, deps: LiveUatDeps): Promise<LiveUatUser | null> {
  const warn = deps.warn ?? (() => {});
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      return await deps.signup(creds);
    } catch (err) {
      warn(`[createTestUser] signup attempt ${attempt}/${MAX_ATTEMPTS} failed: ${errorMessage(err)}`);
      // On attempt 1 a duplicate means the (caller-supplied) email was already taken: a failure.
      if (attempt > 1 && isDuplicateEmailError(err)) {
        try {
          return await deps.login(creds);
        } catch (loginErr) {
          warn(`[createTestUser] recovery login after duplicate email failed: ${errorMessage(loginErr)}`);
        }
      }
    }
    if (attempt < MAX_ATTEMPTS) await deps.wait(RETRY_DELAY_MS);
  }
  return null;
}

async function verifyPhase(user: LiveUatUser, deps: LiveUatDeps): Promise<void> {
  const warn = deps.warn ?? (() => {});
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      if (await deps.verify(user)) return;
      warn(`[createTestUser] verify attempt ${attempt}/${MAX_ATTEMPTS}: profile did not match`);
    } catch (err) {
      warn(`[createTestUser] verify attempt ${attempt}/${MAX_ATTEMPTS} failed: ${errorMessage(err)}`);
    }
    if (attempt < MAX_ATTEMPTS) await deps.wait(RETRY_DELAY_MS);
  }
  warn('[createTestUser] account not verified; using the signed-up user (avoids UI signup)');
}

export async function createLiveUatUser(
  deps: LiveUatDeps,
  overrides: LiveUatOverrides = {},
): Promise<LiveUatUser> {
  const creds = resolveCredentials(overrides);

  const user = await signupPhase(creds, deps);
  if (!user) return deps.uiFallback(creds);

  await verifyPhase(user, deps);
  return user;
}
