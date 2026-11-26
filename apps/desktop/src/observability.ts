/**
 * Error reporting for the app window (Sentry project ekidongomidi-desktop). Rust panics are reported
 * by the Rust side. Off unless VITE_SENTRY_DSN is set (see .env.example). No personal data.
 */
import * as Sentry from '@sentry/browser';
import pkg from '../package.json';

const dsn: string | undefined = import.meta.env.VITE_SENTRY_DSN;

export function initObservability(): void {
  if (!dsn) return;
  Sentry.init({
    dsn,
    release: `ekidongomidi-desktop@${pkg.version}`,
    environment: import.meta.env.PROD ? 'production' : 'development',
    tracesSampleRate: import.meta.env.PROD ? 0.1 : 1.0,
    dataCollection: { userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false },
  });
}

/** Log locally and, when enabled, report with optional context. */
export function reportError(error: unknown, context?: Record<string, unknown>): void {
  console.error(error);
  if (dsn) Sentry.captureException(error, context ? { extra: context } : undefined);
}

export const appVersion = pkg.version;
