/**
 * Tiny structured-logger facade used throughout the server side.
 *
 * Two outputs, in order:
 *
 *   1. **OpenTelemetry → PostHog Logs** (`/docs/logs`). Set up by
 *      `instrumentation.ts` at app start. Searchable in the PostHog UI
 *      and correlatable with `$ai_generation` events via shared
 *      `posthog_distinct_id` / `trace_id` attributes.
 *
 *   2. **Console mirror** so local dev (`next dev`) and Vercel runtime
 *      logs still see the same message — useful when tailing
 *      `vercel logs` while debugging a production-only issue.
 *
 * The API is intentionally minimal — no log levels we don't use, no
 * pluggable transports. Add more if a real need shows up.
 *
 * Usage:
 *
 *   import { log } from '@/lib/logger';
 *   log.info('source.ingest.start', { research_id, kind, source_size });
 *   log.error('ideate.both_failed', { openai_error, gemini_error });
 *
 * Always pass `string` for the *event name* (first arg) and key/value
 * pairs for everything else — the PostHog Logs UI filters by those
 * attributes, not by the body. Never embed secrets (API keys, tokens,
 * raw Bearer headers) in either field.
 */
import 'server-only';
import { SeverityNumber } from '@opentelemetry/api-logs';
import { loggerProvider } from '@/instrumentation';

const otelLogger = loggerProvider.getLogger('siftie-app');

type Severity = 'debug' | 'info' | 'warn' | 'error';

const SEVERITY_MAP: Record<Severity, SeverityNumber> = {
  debug: SeverityNumber.DEBUG,
  info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
};

/**
 * Sanitise attribute values into shapes that survive the OTLP/JSON
 * roundtrip cleanly. The OpenTelemetry log spec wants primitives or
 * arrays of primitives — Errors, BigInts, and plain objects need
 * coercing or they'll be dropped silently.
 */
function normaliseAttributes(
  attributes: Record<string, unknown> | undefined,
): Record<string, string | number | boolean | string[] | number[] | boolean[]> {
  if (!attributes) return {};
  const out: Record<
    string,
    string | number | boolean | string[] | number[] | boolean[]
  > = {};
  for (const [key, raw] of Object.entries(attributes)) {
    if (raw == null) continue;
    if (raw instanceof Error) {
      out[`${key}_message`] = raw.message;
      out[`${key}_name`] = raw.name;
      if (raw.stack) out[`${key}_stack`] = raw.stack;
      continue;
    }
    if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
      out[key] = raw;
      continue;
    }
    if (typeof raw === 'bigint') {
      out[key] = raw.toString();
      continue;
    }
    // Fallback: stringify objects/arrays so the row doesn't disappear.
    try {
      out[key] = JSON.stringify(raw);
    } catch {
      out[key] = String(raw);
    }
  }
  return out;
}

function emit(severity: Severity, event: string, attributes?: Record<string, unknown>) {
  const normalised = normaliseAttributes(attributes);
  // OTel — failure here must never throw into the request path.
  try {
    otelLogger.emit({
      body: event,
      severityNumber: SEVERITY_MAP[severity],
      severityText: severity.toUpperCase(),
      attributes: normalised,
    });
  } catch {
    // swallow — instrumentation is best-effort
  }
  // Console mirror — keep the structured pairs for grep-ability.
  const consoleFn =
    severity === 'error'
      ? console.error
      : severity === 'warn'
        ? console.warn
        : console.log;
  if (Object.keys(normalised).length > 0) {
    consoleFn(`[${severity}] ${event}`, normalised);
  } else {
    consoleFn(`[${severity}] ${event}`);
  }
}

export const log = {
  debug(event: string, attributes?: Record<string, unknown>) {
    emit('debug', event, attributes);
  },
  info(event: string, attributes?: Record<string, unknown>) {
    emit('info', event, attributes);
  },
  warn(event: string, attributes?: Record<string, unknown>) {
    emit('warn', event, attributes);
  },
  error(event: string, attributes?: Record<string, unknown>) {
    emit('error', event, attributes);
  },
};

/**
 * Force-flush any batched log records to PostHog. Call this at the
 * **end** of a route handler — typically inside `after()` from
 * `next/server` so it runs after the response is sent but before the
 * lambda freezes. Without this, the BatchLogRecordProcessor would
 * drop the latest batch on cold-frozen functions.
 */
export async function flushLogs(): Promise<void> {
  try {
    await loggerProvider.forceFlush();
  } catch {
    // best-effort
  }
}
