/**
 * Refuse destructive or demo-only database operations in production.
 */
export function resolveAppEnv() {
  return process.env.APP_ENV || process.env.NODE_ENV || '';
}

export function isProductionEnv() {
  return resolveAppEnv() === 'production';
}

export function assertNonProduction(operationName) {
  const env = resolveAppEnv();
  if (!env || env === 'production') {
    throw new Error(
      `Refusing ${operationName} when APP_ENV/NODE_ENV is missing or production`
    );
  }
}
