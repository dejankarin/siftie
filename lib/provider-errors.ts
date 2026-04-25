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
export type ProviderName = 'gemini' | 'tavily' | 'openrouter' | 'peec';

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
  const parsed = parseProviderErrorJson(raw);
  const message = parsed?.message ?? raw;
  const statusText = parsed?.status ?? '';
  const httpCode = parsed?.code;
  const combined = `${httpCode ?? ''} ${statusText} ${message}`.toLowerCase();

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

  return {
    code: 'provider_failed',
    provider,
    message: `${providerLabel(provider)} request failed. Please try again.`,
    status: 502,
  };
}

function providerLabel(provider: ProviderName): string {
  switch (provider) {
    case 'gemini':
      return 'Gemini';
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
