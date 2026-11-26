/**
 * Error reporting (Sentry). Off unless VITE_SENTRY_DSN is set (see .env.example), so CI builds
 * and contributors without a DSN send nothing. No personal data: see dataCollection below.
 */
import * as Sentry from '@sentry/browser';
import pkg from '../package.json';

const dsn: string | undefined = import.meta.env.VITE_SENTRY_DSN;

export const errorReportingEnabled = Boolean(dsn);

export function initObservability(): void {
  if (!dsn) return;
  Sentry.init({
    dsn,
    release: `ekidongomidi-timing-lab@${pkg.version}`,
    environment: import.meta.env.MODE,
    integrations: [Sentry.browserTracingIntegration()],
    tracesSampleRate: import.meta.env.PROD ? 0.1 : 1.0,
    // Privacy: collect no user info, cookies, headers, bodies or query strings.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
    },
  });
}

/** Log locally and, when enabled, report to Sentry with optional context. */
export function reportError(error: unknown, context?: Record<string, unknown>): void {
  console.error(error);
  if (dsn) Sentry.captureException(error, context ? { extra: context } : undefined);
}
