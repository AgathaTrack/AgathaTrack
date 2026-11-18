import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createLiveUatUser,
  isDuplicateEmailError,
  RETRY_DELAY_MS,
  type LiveUatCredentials,
  type LiveUatDeps,
  type LiveUatUser,
} from './create-live-uat-user';

const DUPLICATE = new Error('signup failed (400): {"error":"Email already exists."}');

function userFor(creds: LiveUatCredentials, source: string): LiveUatUser {
  return { ...creds, accessToken: `token-${source}`, userId: `id-${source}` };
}

/** Fakes that count calls; `signupResults` is consumed one entry per signup call. */
function harness(options: {
  signupResults: Array<'ok' | Error>;
  verifyResults?: Array<boolean | Error>;
  loginResult?: 'ok' | Error;
}) {
  const calls = {
    signup: [] as LiveUatCredentials[],
    verify: 0,
    login: [] as LiveUatCredentials[],
    uiFallback: [] as LiveUatCredentials[],
    waits: [] as number[],
    warnings: [] as string[],
  };
  const signupResults = [...options.signupResults];
  const verifyResults = [...(options.verifyResults ?? [true])];
  const deps: LiveUatDeps = {
    signup: async (creds) => {
      calls.signup.push(creds);
      const next = signupResults.shift() ?? new Error('signup exhausted');
      if (next instanceof Error) throw next;
      return userFor(creds, 'signup');
    },
    verify: async () => {
      calls.verify += 1;
      const next = verifyResults.shift() ?? false;
      if (next instanceof Error) throw next;
      return next;
    },
    login: async (creds) => {
      calls.login.push(creds);
      const result = options.loginResult ?? new Error('login failed (401)');
      if (result instanceof Error) throw result;
      return userFor(creds, 'login');
    },
    uiFallback: async (creds) => {
      calls.uiFallback.push(creds);
      return userFor(creds, 'ui');
    },
    wait: async (ms) => {
      calls.waits.push(ms);
    },
    warn: (message) => {
      calls.warnings.push(message);
    },
  };
  return { deps, calls };
}

test('signup throws twice then succeeds: one account, same email on every attempt', async () => {
  const { deps, calls } = harness({
    signupResults: [new Error('signup failed (503): <html>'), new Error('fetch failed'), 'ok'],
  });

  const user = await createLiveUatUser(deps);

  assert.equal(calls.signup.length, 3);
  assert.equal(new Set(calls.signup.map((c) => c.email)).size, 1);
  assert.equal(user.accessToken, 'token-signup');
  assert.equal(user.email, calls.signup[0].email);
  assert.equal(calls.login.length, 0);
  assert.equal(calls.uiFallback.length, 0);
  assert.deepEqual(calls.waits, [RETRY_DELAY_MS, RETRY_DELAY_MS]);
});

test('verify fails once: retries verify only, never signs up again', async () => {
  const { deps, calls } = harness({
    signupResults: ['ok'],
    verifyResults: [new Error('getCurrentUser failed (403)'), true],
  });

  const user = await createLiveUatUser(deps);

  assert.equal(calls.signup.length, 1);
  assert.equal(calls.verify, 2);
  assert.equal(calls.uiFallback.length, 0);
  assert.equal(user.accessToken, 'token-signup');
});

test('signup throws then reports a duplicate: recovers with login, no further signup', async () => {
  const { deps, calls } = harness({
    signupResults: [new Error('fetch failed'), DUPLICATE],
    loginResult: 'ok',
  });

  const user = await createLiveUatUser(deps, { email: 'caller@example.com', password: 'Secret1x' });

  assert.equal(calls.signup.length, 2);
  assert.equal(calls.login.length, 1);
  assert.deepEqual(calls.login[0], calls.signup[1]);
  assert.equal(calls.login[0].email, 'caller@example.com');
  assert.equal(calls.login[0].password, 'Secret1x');
  assert.equal(user.accessToken, 'token-login');
  assert.equal(calls.uiFallback.length, 0);
});

test('signup always throws: UI fallback once, with the same credentials', async () => {
  const { deps, calls } = harness({
    signupResults: [new Error('a'), new Error('b'), new Error('c')],
  });

  const user = await createLiveUatUser(deps);

  assert.equal(calls.signup.length, 3);
  assert.equal(calls.login.length, 0);
  assert.equal(calls.verify, 0);
  assert.equal(calls.uiFallback.length, 1);
  assert.deepEqual(calls.uiFallback[0], calls.signup[0]);
  assert.equal(user.accessToken, 'token-ui');
});

test('verify never succeeds: returns the signed-up user, no further signup, no UI fallback', async () => {
  const { deps, calls } = harness({
    signupResults: ['ok'],
    verifyResults: [false, new Error('blocked'), false],
  });

  const user = await createLiveUatUser(deps);

  assert.equal(calls.signup.length, 1);
  assert.equal(calls.verify, 3);
  assert.equal(calls.uiFallback.length, 0);
  assert.equal(user.accessToken, 'token-signup');
});

test('duplicate on the first attempt is a failure: no login for a caller-supplied email', async () => {
  const { deps, calls } = harness({
    signupResults: [DUPLICATE, new Error('b'), new Error('c')],
    loginResult: 'ok',
  });

  const user = await createLiveUatUser(deps, { email: 'taken@example.com' });

  assert.equal(calls.login.length, 0, 'first-attempt duplicate must not log in');
  assert.equal(calls.uiFallback.length, 1);
  assert.equal(user.accessToken, 'token-ui');
});

test('duplicate on attempts 1 and 2 never logs in: the email was taken before this call', async () => {
  const { deps, calls } = harness({
    signupResults: [DUPLICATE, DUPLICATE, DUPLICATE],
    loginResult: 'ok',
  });

  const user = await createLiveUatUser(deps, { email: 'taken@example.com', password: 'Secret1x' });

  assert.equal(calls.signup.length, 3);
  assert.equal(calls.login.length, 0, 'a pre-existing account must not be adopted');
  assert.equal(calls.uiFallback.length, 1);
  assert.equal(user.accessToken, 'token-ui');
});

test('recovery login failure counts as a failed attempt and signup phase continues', async () => {
  const { deps, calls } = harness({
    signupResults: [new Error('a'), DUPLICATE, 'ok'],
    loginResult: new Error('login failed (503)'),
  });

  const user = await createLiveUatUser(deps);

  assert.equal(calls.login.length, 1);
  assert.equal(calls.signup.length, 3);
  assert.equal(user.accessToken, 'token-signup');
});

test('caller overrides are passed through; unspecified fields use signupUser defaults', async () => {
  const { deps, calls } = harness({ signupResults: ['ok'] });

  await createLiveUatUser(deps, { email: 'me@example.com', firstName: 'Ada' });

  assert.deepEqual(calls.signup[0], {
    email: 'me@example.com',
    password: 'E2eTestPass1',
    firstName: 'Ada',
    lastName: 'User',
  });
});

test('generated email looks like signupUser output and differs between calls', async () => {
  const first = harness({ signupResults: ['ok'] });
  const second = harness({ signupResults: ['ok'] });

  await createLiveUatUser(first.deps);
  await createLiveUatUser(second.deps);

  assert.match(first.calls.signup[0].email, /^e2e-\d+-[a-z0-9]+@example\.com$/);
  assert.notEqual(first.calls.signup[0].email, second.calls.signup[0].email);
});

test('isDuplicateEmailError matches only the signup 400 duplicate response', () => {
  assert.equal(isDuplicateEmailError(DUPLICATE), true);
  assert.equal(isDuplicateEmailError(new Error('signup failed (409): Email already exists.')), false);
  assert.equal(isDuplicateEmailError(new Error('signup failed (400): {"error":"Invalid email."}')), false);
  assert.equal(isDuplicateEmailError('signup failed (400): Email already exists.'), true);
  assert.equal(isDuplicateEmailError(new Error('fetch failed')), false);
});
