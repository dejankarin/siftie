/**
 * The ingest orchestrator. Given a typed `IngestInput`, this:
 *
 *   1. Resolves the source body (Tavily for URLs, mammoth for .docx,
 *      passthrough for PDF buffers and markdown text).
 *   2. Hands the result to Gemini Flash with the ContextDoc schema.
 *   3. Normalises the result + a kind-specific `meta` JSON blob that the
 *      `sources` table stores alongside the ContextDoc (page count, host,
 *      original HTML, etc.).
 *
 * The shape lets `/api/sources` (POST) and `/api/sources/[id]/reindex`
 * (POST) share the entire pipeline — the reindex route just looks up the
 * existing source's stored payload and re-runs `runIngest`.
 *
 * Errors are surfaced as `IngestError` with a stable `code` string so the
 * client can branch on the failure (missing key vs. extract failed vs.
 * parse failed) without string-matching messages.
 */
import 'server-only';
import { contextDoc, type ContextDocCallOptions } from '../gemini';
import { parseDocx } from '../docx';
import { extractUrl, TavilyExtractError } from '../tavily';
import { classifyProviderError, type ProviderErrorCode, type ProviderName } from '../provider-errors';
import type { ContextDoc } from './schema';

export type IngestKind = 'pdf' | 'url' | 'doc' | 'md';

export type IngestInput =
  | { kind: 'pdf'; buffer: Buffer; filename: string; sizeBytes: number }
  | { kind: 'url'; url: string }
  | { kind: 'doc'; buffer: Buffer; filename: string; sizeBytes: number }
  | { kind: 'md'; text: string; title?: string };

/**
 * Kind-specific structured metadata persisted into `sources.meta` JSONB.
 * Stable shape so the UI / re-index can always reconstruct the original
 * source bundle.
 */
export type SourceMeta =
  | {
      kind: 'pdf';
      filename: string;
      sizeBytes: number;
    }
  | {
      kind: 'url';
      originalUrl: string;
      rawUrl: string;
      host: string;
      fetchedAt: string;
      tavilyTitle: string | null;
    }
  | {
      kind: 'doc';
      filename: string;
      sizeBytes: number;
      /** Mammoth-rendered HTML, kept so a "View source" preview can render the doc later. */
      html: string;
    }
  | {
      kind: 'md';
      providedTitle: string | null;
      sizeBytes: number;
    };

export interface IngestResult {
  contextDoc: ContextDoc;
  meta: SourceMeta;
  /**
   * Short text suitable for the source card preview. Falls back to the
   * ContextDoc summary for kinds that don't have a richer alternative.
   */
  snippet: string;
}

export interface IngestKeys {
  geminiKey: string;
  /** Required only for `kind: 'url'`. */
  tavilyKey?: string;
}

export interface IngestRunOptions {
  /**
   * Tracking metadata threaded through to Gemini + Tavily so PostHog
   * events line up with this ingest. The caller MUST pass the Clerk
   * user id and the user's privacy preference.
   */
  posthogDistinctId: string;
  posthogTraceId?: string;
  posthogPrivacyMode: boolean;
  /** Extra event properties; we automatically add `kind`. */
  posthogProperties?: Record<string, unknown>;
}

export class IngestError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'missing_key'
      | 'extract_failed'
      | 'parse_failed'
      | 'gemini_failed'
      | 'invalid_input'
      | ProviderErrorCode,
    public readonly cause?: unknown,
    public readonly provider?: ProviderName,
    public readonly status = code === 'invalid_input' ? 400 : 500,
  ) {
    super(message);
    this.name = 'IngestError';
  }
}

/**
 * Run the full ingest pipeline for a single source. Throws `IngestError`
 * with a stable `code` on any failure.
 */
export async function runIngest(
  input: IngestInput,
  keys: IngestKeys,
  opts: IngestRunOptions,
): Promise<IngestResult> {
  if (!keys.geminiKey) {
    throw new IngestError('Gemini API key required for ingest', 'missing_key');
  }

  const geminiOpts: ContextDocCallOptions = {
    posthogDistinctId: opts.posthogDistinctId,
    posthogTraceId: opts.posthogTraceId,
    posthogPrivacyMode: opts.posthogPrivacyMode,
    posthogProperties: {
      tag: 'context_doc',
      kind: input.kind,
      ...opts.posthogProperties,
    },
  };

  switch (input.kind) {
    case 'pdf':
      return ingestPdf(input, keys.geminiKey, geminiOpts);
    case 'url':
      if (!keys.tavilyKey) {
        throw new IngestError('Tavily API key required for URL ingest', 'missing_key');
      }
      return ingestUrl(input, keys, geminiOpts, opts);
    case 'doc':
      return ingestDoc(input, keys.geminiKey, geminiOpts);
    case 'md':
      return ingestMarkdown(input, keys.geminiKey, geminiOpts);
  }
}

// ---------------------------------------------------------------------------
// Per-kind pipelines
// ---------------------------------------------------------------------------

async function ingestPdf(
  input: Extract<IngestInput, { kind: 'pdf' }>,
  geminiKey: string,
  geminiOpts: ContextDocCallOptions,
): Promise<IngestResult> {
  let doc: ContextDoc;
  try {
    doc = await contextDoc(
      geminiKey,
      { kind: 'pdf', buffer: input.buffer, mimeType: 'application/pdf' },
      geminiOpts,
    );
  } catch (err) {
    const providerError = classifyProviderError(err, 'gemini');
    throw new IngestError(
      providerError.message,
      providerError.code,
      err,
      providerError.provider,
      providerError.status,
    );
  }
  return {
    contextDoc: doc,
    meta: {
      kind: 'pdf',
      filename: input.filename,
      sizeBytes: input.sizeBytes,
    },
    snippet: doc.summary,
  };
}

async function ingestUrl(
  input: Extract<IngestInput, { kind: 'url' }>,
  keys: IngestKeys,
  geminiOpts: ContextDocCallOptions,
  opts: IngestRunOptions,
): Promise<IngestResult> {
  let host = '';
  try {
    host = new URL(input.url).host;
  } catch {
    throw new IngestError('Invalid URL', 'invalid_input');
  }

  // 1. Fetch via Tavily. On failure, fall back to a plain HTTP GET so we
  //    still degrade gracefully — but downgrade `meta.tavilyTitle` to null.
  let markdown: string;
  let tavilyTitle: string | null = null;
  let rawUrl = input.url;
  let fetchedAt = new Date().toISOString();

  try {
    const result = await extractUrl(keys.tavilyKey!, input.url, {
      posthogDistinctId: opts.posthogDistinctId,
      posthogTraceId: opts.posthogTraceId,
      posthogProperties: {
        ...opts.posthogProperties,
        host,
      },
    });
    markdown = result.markdown;
    tavilyTitle = result.title;
    rawUrl = result.rawUrl;
    fetchedAt = result.fetchedAt;
  } catch (err) {
    if (err instanceof TavilyExtractError) {
      // Fallback: best-effort plain fetch. Strip script/style tags so we
      // don't pay Gemini to summarise React bundles.
      try {
        const fallback = await fetch(input.url, {
          headers: {
            'user-agent':
              'Mozilla/5.0 (compatible; SiftieBot/1.0; +https://siftie.app)',
          },
          signal: AbortSignal.timeout(15_000),
        });
        if (!fallback.ok) {
          throw new IngestError(
            `Failed to fetch ${input.url}: ${fallback.status}`,
            'extract_failed',
            err,
          );
        }
        const html = await fallback.text();
        markdown = stripHtmlToText(html);
      } catch (fetchErr) {
        throw new IngestError(
          err.message,
          'extract_failed',
          fetchErr ?? err,
        );
      }
    } else {
      throw new IngestError(
        err instanceof Error ? err.message : 'URL extract failed',
        'extract_failed',
        err,
      );
    }
  }

  // 2. Hand markdown to Gemini.
  let doc: ContextDoc;
  try {
    doc = await contextDoc(
      keys.geminiKey,
      {
        kind: 'text',
        text: markdown,
        contextHint: `From URL ${rawUrl} (host: ${host}).`,
      },
      geminiOpts,
    );
  } catch (err) {
    const providerError = classifyProviderError(err, 'gemini');
    throw new IngestError(
      providerError.message,
      providerError.code,
      err,
      providerError.provider,
      providerError.status,
    );
  }

  // Prefer Tavily's title for the snippet preview because the page title
  // is usually a better quick-glance label than Gemini's reformulation.
  const snippetSource = markdown.trim();
  const snippet =
    snippetSource.length > 0
      ? snippetSource.slice(0, 240) + (snippetSource.length > 240 ? '…' : '')
      : doc.summary;

  return {
    contextDoc: doc,
    meta: {
      kind: 'url',
      originalUrl: input.url,
      rawUrl,
      host,
      fetchedAt,
      tavilyTitle,
    },
    snippet,
  };
}

async function ingestDoc(
  input: Extract<IngestInput, { kind: 'doc' }>,
  geminiKey: string,
  geminiOpts: ContextDocCallOptions,
): Promise<IngestResult> {
  let parsed: { text: string; html: string };
  try {
    parsed = await parseDocx(input.buffer);
  } catch (err) {
    throw new IngestError(
      err instanceof Error ? err.message : 'Failed to parse .docx',
      'parse_failed',
      err,
    );
  }
  if (!parsed.text.trim()) {
    throw new IngestError('.docx file appears to be empty', 'parse_failed');
  }

  let doc: ContextDoc;
  try {
    doc = await contextDoc(
      geminiKey,
      {
        kind: 'text',
        text: parsed.text,
        contextHint: `From Word document ${input.filename}.`,
      },
      geminiOpts,
    );
  } catch (err) {
    const providerError = classifyProviderError(err, 'gemini');
    throw new IngestError(
      providerError.message,
      providerError.code,
      err,
      providerError.provider,
      providerError.status,
    );
  }

  return {
    contextDoc: doc,
    meta: {
      kind: 'doc',
      filename: input.filename,
      sizeBytes: input.sizeBytes,
      html: parsed.html,
    },
    snippet: doc.summary,
  };
}

async function ingestMarkdown(
  input: Extract<IngestInput, { kind: 'md' }>,
  geminiKey: string,
  geminiOpts: ContextDocCallOptions,
): Promise<IngestResult> {
  if (!input.text.trim()) {
    throw new IngestError('Markdown content is empty', 'invalid_input');
  }

  let doc: ContextDoc;
  try {
    doc = await contextDoc(
      geminiKey,
      {
        kind: 'text',
        text: input.text,
        contextHint: input.title
          ? `From a markdown note titled "${input.title}".`
          : 'From a markdown note pasted into Siftie.',
      },
      geminiOpts,
    );
  } catch (err) {
    const providerError = classifyProviderError(err, 'gemini');
    throw new IngestError(
      providerError.message,
      providerError.code,
      err,
      providerError.provider,
      providerError.status,
    );
  }

  // Markdown sources show the raw markup as their preview because the
  // user already chose what to write — better than re-summarising.
  const trimmed = input.text.trim();
  const snippet = trimmed.slice(0, 240) + (trimmed.length > 240 ? '…' : '');

  return {
    contextDoc: doc,
    meta: {
      kind: 'md',
      providedTitle: input.title ?? null,
      sizeBytes: Buffer.byteLength(input.text, 'utf8'),
    },
    snippet,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Strip <script>/<style>/<nav>/<footer> blocks and HTML tags. Used only as
 * a fallback when Tavily fails — the result is rough but still readable
 * enough for Gemini to do something useful with.
 */
function stripHtmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
