/** Support outbox env (names only in docs; values from process.env). */

function env(name) {
  const value = process.env[name];
  return value !== undefined && value !== '' ? value : undefined;
}

export function getSupportGithubRepo() {
  return env('SUPPORT_GITHUB_REPO');
}

export function getSupportGithubToken() {
  return env('SUPPORT_GITHUB_TOKEN');
}

/** Org issue field Environment. Empty when APP_ENV is neither uat nor production. */
export function getSupportEnvironmentValue() {
  const appEnv = env('APP_ENV');
  if (appEnv === 'uat') return 'UAT';
  if (appEnv === 'production') return 'Prod';
  return null;
}

export function isGithubOutboxEnabled() {
  return Boolean(getSupportGithubRepo());
}
