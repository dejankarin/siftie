/**
 * Next.js instrumentation hook (auto-loaded by Next 15 at app start).
 *
 * Sets up an OpenTelemetry `LoggerProvider` that ships our application
 * logs to PostHog Logs (EU cloud) via OTLP/HTTP. The provider is
 * deliberately created at module scope (not inside `register()`) so
 * route handlers can `import { loggerProvider }` and call
 * `loggerProvider.forceFlush()` before the serverless function freezes
 * — without that flush, the batching processor would drop the latest
 * batch on cold-frozen lambdas.
 *
 * Notes:
 *
 *   - We only register in the Node.js runtime. Edge / Middleware
 *     runtimes don't need application-level logs (they should be small
 *     and quick), and bundling the SDK there is wasteful.
 *
 *   - The PostHog *project* token (`phc_…`) is reused as the OTLP
 *     bearer. It's the same key the browser PostHog SDK already sees,
 *     so embedding it here is fine. Personal API keys (`phx_…`) MUST
 *     NOT be used.
 *
 *   - Endpoint is `eu.i.posthog.com` because this project lives on
 *     PostHog Cloud EU. Switch to `us.i.posthog.com` if migrating.
 *
 *   - We swallow exporter errors at the SDK boundary so a flaky
 *     PostHog never breaks user-facing requests.
 */
import { logs } from '@opentelemetry/api-logs';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchLogRecordProcessor, LoggerProvider } from '@opentelemetry/sdk-logs';

const POSTHOG_TOKEN = process.env.NEXT_PUBLIC_POSTHOG_KEY ?? '';
// EU cloud — see .env.local NEXT_PUBLIC_POSTHOG_HOST.
const POSTHOG_LOGS_URL = 'https://eu.i.posthog.com/i/v1/logs';

export const loggerProvider = new LoggerProvider({
  resource: resourceFromAttributes({
    'service.name': 'siftie-app',
    'deployment.environment':
      process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? 'development',
  }),
  processors: POSTHOG_TOKEN
    ? [
        new BatchLogRecordProcessor(
          new OTLPLogExporter({
            url: POSTHOG_LOGS_URL,
            headers: {
              Authorization: `Bearer ${POSTHOG_TOKEN}`,
              'Content-Type': 'application/json',
            },
          }),
        ),
      ]
    : [],
});

export function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs' && POSTHOG_TOKEN) {
    logs.setGlobalLoggerProvider(loggerProvider);
  }
}
