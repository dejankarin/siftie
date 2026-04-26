/**
 * Normalise raw provider SDK errors into stable API-facing errors.
 *
 * Provider SDKs often throw `Error` objects whose `.message` is itself a
 * JSON blob, for example Gemini quota failures:
 *
 *   {"error":{"code":429,"message":"Resource has been exhausted ...","status":"RESOURCE_EXHAUSTED"}}
 *
 * Returning that raw string to the UI is confusing. This helper turns it
 * into a small, typed shape that API routes can return and client code can
 * explain in plain English.
 */
export type ProviderName = 'gemini' | 'openai' | 'tavily' | 'openrouter' | 'peec';

export type ProviderErrorCode =
  | 'quota_exhausted'
  | 'provider_auth_failed'
  | 'provider_failed';

export interface ClassifiedProviderError {
  code: ProviderErrorCode;
  provider: ProviderName;
  message: string;
  status: number;
}

export function classifyProviderError(
  err: unknown,
  provider: ProviderName,
): ClassifiedProviderError {
  const raw = err instanceof Error ? err.message : String(err ?? '');

  // Try the Gemini-style JSON envelope first ({"error":{...}}). When
  // the SDK doesn't pre-stringify (OpenAI Node SDK throws a typed
  // APIError instead), pull the same fields off the live object so
  // both shapes converge into one set of variables.
  const parsedJson = parseProviderErrorJson(raw);
  const fromObject = extractFromErrorObject(err);
  const message = parsedJson?.message ?? fromObject?.message ?? raw;
  const statusText = parsedJson?.status ?? fromObject?.type ?? '';
  const httpCode = parsedJson?.code ?? fromObject?.status;
  const errCode = fromObject?.code ?? '';
  const combined =
    `${httpCode ?? ''} ${statusText} ${errCode} ${message}`.toLowerCase();

  if (
    httpCode === 429 ||
    statusText === 'RESOURCE_EXHAUSTED' ||
    combined.includes('resource has been exhausted') ||
    combined.includes('quota')
  ) {
    return {
      code: 'quota_exhausted',
      provider,
      message: `${providerLabel(provider)} quota is exhausted. Check your ${providerLabel(
        provider,
      )} API key quota or billing, then try again.`,
      status: 429,
    };
  }

  if (
    httpCode === 401 ||
    httpCode === 403 ||
    combined.includes('api key not valid') ||
    combined.includes('invalid api key') ||
    combined.includes('permission_denied') ||
    combined.includes('unauthorized')
  ) {
    return {
      code: 'provider_auth_failed',
      provider,
      message: `${providerLabel(provider)} API key was rejected. Update it in Settings, then try again.`,
      status: 400,
    };
  }

  // Generic fallback. Prefer the *real* provider message (truncated)
  // over the opaque "request failed" — when this code path triggers,
  // the message is almost always the most informative thing we have
  // (e.g. "Unsupported value: 'temperature' does not support 0.7…").
  // Without this, callers see "OpenAI request failed. Please try
  // again." for what is actually a deterministic 400 that retrying
  // will never fix.
  const detail = friendlyDetail(message);
  return {
    code: 'provider_failed',
    provider,
    message: detail
      ? `${providerLabel(provider)} request failed: ${detail}`
      : `${providerLabel(provider)} request failed. Please try again.`,
    status: 502,
  };
}

/**
 * Pull the few fields we care about off a typed SDK error object.
 * Mirrors OpenAI's `APIError` (`status`, `code`, `type`, `message`,
 * `error.message`) but is shape-tolerant so it also works with raw
 * `Error` objects that just happen to have the same fields.
 */
function extractFromErrorObject(
  err: unknown,
): { status?: number; code?: string; type?: string; message?: string } | null {
  if (!err || typeof err !== 'object') return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const e = err as any;
  return {
    status: typeof e.status === 'number' ? e.status : undefined,
    code: typeof e.code === 'string' ? e.code : undefined,
    type: typeof e.type === 'string' ? e.type : undefined,
    message:
      typeof e.error?.message === 'string'
        ? e.error.message
        : typeof e.message === 'string'
          ? e.message
          : undefined,
  };
}

/**
 * Trim the raw SDK message to something a user can read in a chat
 * bubble. Drops the leading `<status> ` prefix the OpenAI SDK adds
 * (e.g. "400 Unsupported value: ..."), caps length, and strips
 * trailing whitespace.
 */
function friendlyDetail(message: string): string {
  if (!message) return '';
  let s = message.trim();
  s = s.replace(/^\d{3}\s+/, '');
  if (s.length > 300) s = `${s.slice(0, 300)}…`;
  return s;
}

function providerLabel(provider: ProviderName): string {
  switch (provider) {
    case 'gemini':
      return 'Gemini';
    case 'openai':
      return 'OpenAI';
    case 'tavily':
      return 'Tavily';
    case 'openrouter':
      return 'OpenRouter';
    case 'peec':
      return 'PEEC';
  }
}

function parseProviderErrorJson(raw: string): { code?: number; message?: string; status?: string } | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(trimmed) as {
      error?: { code?: number; message?: string; status?: string };
    };
    return parsed.error ?? null;
  } catch {
    return null;
  }
}
