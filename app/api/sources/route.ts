/**
 * POST /api/sources
 *
 * Adds a new source to a research. Accepts two content types:
 *
 *   - `application/json` for `url` and `md` kinds
 *       { researchId, kind: 'url',  url:   string }
 *       { researchId, kind: 'md',   text:  string, title?: string }
 *
 *   - `multipart/form-data` for `pdf` and `doc` kinds
 *       researchId: string
 *       kind:       'pdf' | 'doc'
 *       file:       File (the upload)
 *
 * The route resolves the user's Gemini key (and Tavily key if needed)
 * from the BYOK store, runs the ingest pipeline (Tavily → Gemini for
 * URLs, mammoth → Gemini for docx, Gemini-only for PDF + markdown),
 * persists the resulting source row, and captures `source_added` /
 * `source_failed` PostHog events.
 *
 * GET /api/sources?researchId=…
 *
 * Returns the (already-hydrated) list of sources for a research. Mostly
 * used for refresh after errors — the workspace bootstrap already
 * includes sources in the initial payload.
 */
import { withUser } from '@/lib/auth';
import { getUserApiKey } from '@/lib/keys';
import { readPosthogCaptureLlm } from '@/lib/privacy';
import { getPostHogServer } from '@/lib/posthog';
import {
  createSource,
  listSourcesForResearch,
  type SourceRow,
} from '@/lib/sources';
import {
  IngestError,
  runIngest,
  type IngestInput,
} from '@/lib/ingest';
import { z } from 'zod';

export const runtime = 'nodejs';
// PDF + .docx ingest can take 30s+ — the platform default of 300s is
// already enough, but be explicit so this doesn't drift.
export const maxDuration = 120;

// ---------------------------------------------------------------------------
// GET — list sources for a research
// ---------------------------------------------------------------------------
export const GET = withUser(async ({ userId }, req) => {
  const { searchParams } = new URL(req.url);
  const researchId = searchParams.get('researchId');
  if (!researchId) {
    return Response.json({ error: 'researchId is required' }, { status: 400 });
  }
  const sources = await listSourcesForResearch(userId, researchId);
  return Response.json({ sources: sources.map(serializeSource) });
});

// ---------------------------------------------------------------------------
// POST — add a source
// ---------------------------------------------------------------------------
const JsonBody = z.discriminatedUnion('kind', [
  z.object({
    researchId: z.string().min(1),
    kind: z.literal('url'),
    url: z.string().url(),
  }),
  z.object({
    researchId: z.string().min(1),
    kind: z.literal('md'),
    text: z.string().min(1).max(500_000),
    title: z.string().max(200).optional(),
  }),
]);

export const POST = withUser(async ({ userId }, req) => {
  const contentType = req.headers.get('content-type') ?? '';
  let input: IngestInput;
  let researchId: string;

  try {
    if (contentType.startsWith('multipart/form-data')) {
      const parsed = await parseMultipart(req);
      researchId = parsed.researchId;
      input = parsed.input;
    } else {
      const body = await req.json();
      const result = JsonBody.safeParse(body);
      if (!result.success) {
        return Response.json(
          { error: 'invalid_body', details: result.error.flatten() },
          { status: 400 },
        );
      }
      researchId = result.data.researchId;
      input =
        result.data.kind === 'url'
          ? { kind: 'url', url: result.data.url }
          : { kind: 'md', text: result.data.text, title: result.data.title };
    }
  } catch (err) {
    if (err instanceof IngestError && err.code === 'invalid_input') {
      return Response.json({ error: err.code, message: err.message }, { status: 400 });
    }
    return Response.json(
      { error: 'invalid_body', message: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }

  // Resolve BYOK keys per-request (never cached, never env).
  const geminiKey = await getUserApiKey(userId, 'gemini');
  if (!geminiKey) {
    return Response.json(
      { error: 'missing_key', provider: 'gemini' },
      { status: 400 },
    );
  }
  let tavilyKey: string | null = null;
  if (input.kind === 'url') {
    tavilyKey = await getUserApiKey(userId, 'tavily');
    if (!tavilyKey) {
      return Response.json(
        { error: 'missing_key', provider: 'tavily' },
        { status: 400 },
      );
    }
  }

  const privacyMode = !(await readPosthogCaptureLlm(userId));
  const ph = getPostHogServer();
  const start = Date.now();
  // Stable trace id so the optional Tavily call + the Gemini call show up
  // grouped under one trace in PostHog LLM Analytics.
  const traceId = `ingest_${cryptoRandom()}`;

  try {
    const result = await runIngest(
      input,
      { geminiKey, tavilyKey: tavilyKey ?? undefined },
      {
        posthogDistinctId: userId,
        posthogTraceId: traceId,
        posthogPrivacyMode: privacyMode,
        posthogProperties: { research_id: researchId },
      },
    );

    const row = await createSource(userId, {
      researchId,
      kind: input.kind,
      title: result.contextDoc.title,
      meta: result.meta,
      snippet: result.snippet,
      contextDoc: result.contextDoc,
    });

    ph.capture({
      distinctId: userId,
      event: 'source_added',
      properties: {
        kind: input.kind,
        words: result.contextDoc.words,
        latency_ms: Date.now() - start,
        success: true,
        source_id: row.id,
        research_id: researchId,
        $ai_trace_id: traceId,
      },
    });

    return Response.json({ source: serializeSource(row) }, { status: 201 });
  } catch (err) {
    const code =
      err instanceof IngestError
        ? err.code
        : err instanceof Error
          ? 'unknown_error'
          : 'unknown_error';
    const message = err instanceof Error ? err.message : 'Ingest failed';
    ph.capture({
      distinctId: userId,
      event: 'source_failed',
      properties: {
        kind: input.kind,
        error_code: code,
        latency_ms: Date.now() - start,
        success: false,
        research_id: researchId,
        $ai_trace_id: traceId,
        message,
      },
    });
    const status = err instanceof IngestError ? err.status : 500;
    const provider = err instanceof IngestError ? err.provider : undefined;
    return Response.json({ error: code, message, provider }, { status });
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MB — matches the modal's "up to 50 MB" copy.

async function parseMultipart(
  req: Request,
): Promise<{ researchId: string; input: IngestInput }> {
  const form = await req.formData();
  const researchId = form.get('researchId');
  const kind = form.get('kind');
  const file = form.get('file');

  if (typeof researchId !== 'string' || !researchId) {
    throw new IngestError('researchId is required', 'invalid_input');
  }
  if (kind !== 'pdf' && kind !== 'doc') {
    throw new IngestError('kind must be "pdf" or "doc" for multipart upload', 'invalid_input');
  }
  if (!(file instanceof File)) {
    throw new IngestError('file is required', 'invalid_input');
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new IngestError('File exceeds 50 MB limit', 'invalid_input');
  }
  if (file.size === 0) {
    throw new IngestError('File is empty', 'invalid_input');
  }

  const arrayBuffer = await file.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const filename = file.name || (kind === 'pdf' ? 'upload.pdf' : 'upload.docx');

  return {
    researchId,
    input:
      kind === 'pdf'
        ? { kind: 'pdf', buffer, filename, sizeBytes: file.size }
        : { kind: 'doc', buffer, filename, sizeBytes: file.size },
  };
}

function serializeSource(row: SourceRow) {
  return {
    id: row.id,
    researchId: row.researchId,
    kind: row.kind,
    title: row.title,
    meta: row.meta,
    snippet: row.snippet,
    contextDoc: row.contextDoc,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function cryptoRandom(): string {
  // crypto.randomUUID() exists in Node 19+ which Vercel runs by default.
  return globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
}
