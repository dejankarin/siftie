/**
 * Markdown research report builder (Session 9).
 *
 * Consumes the completed `runs` row + sources + optional Council
 * transcript messages to produce a downloadable `.md` file.
 */
import 'server-only';
import { ThinkingLevel } from '@google/genai';
import { PostHogGoogleGenAI } from '@posthog/ai/gemini';
import { z } from 'zod';
import { getUserApiKey } from './keys';
import { getPostHogServer } from './posthog';
import { readPosthogCaptureLlm } from './privacy';
import { withResilience } from './resilience';
import type { FinalPrompt } from './research/schema';
import { getRunForOwner } from './runs';
import { listMessagesForRun } from './messages';
import { listSourcesForResearch } from './sources';
import type { SourceRow } from './sources';
import { getResearchWithContext } from './workspace';
import { log } from './logger';

const GEMINI_MODEL = 'gemini-3-flash-preview';
const TIMEOUT_MS = 45_000;

const TldrZ = z.object({
  tldr: z.string().min(1).max(2000),
});

const TldrJsonSchema = {
  type: 'object',
  properties: {
    tldr: { type: 'string' },
  },
  required: ['tldr'],
} as const;

const MODELS_LINE =
  'Ideate: OpenAI GPT-5.4 (primary) + Google Gemini 3 (fallback) · Council: OpenRouter — GPT-5.4 reviewers + Gemini 3.1 Pro Chair';

export interface BuildMarkdownReportResult {
  markdown: string;
  filename: string;
}

/**
 * Same shape as the Markdown export, but for CSV. We expose it as a
 * separate result type because Excel-style CSV mime/headers differ.
 */
export interface BuildCsvReportResult {
  csv: string;
  filename: string;
  /**
   * Whether Peec was skipped on this run. The route forwards this so
   * the analytics event includes the same flag the file itself
   * encodes in its leading comment line.
   */
  peecSkipped: boolean;
}

function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return s.length > 0 ? s : 'report';
}

function mdCell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function originFromSource(source: SourceRow): string {
  const meta = source.meta;
  switch (meta.kind) {
    case 'pdf':
    case 'doc':
      return meta.filename;
    case 'url':
      return meta.originalUrl;
    case 'md':
      return meta.providedTitle ?? 'Markdown upload';
    default:
      return source.title;
  }
}

function fallbackTldr(researchName: string, sources: SourceRow[]): string {
  const bits = sources.map((s) => s.contextDoc.summary).filter(Boolean);
  if (bits.length === 0) {
    return `Research "${researchName}" — ${sources.length} source(s) indexed. Open the Sources section in Siftie for full context.`;
  }
  return bits.slice(0, 3).join(' ');
}

async function generateTldrParagraph(
  clerkUserId: string,
  geminiKey: string,
  privacyMode: boolean,
  researchName: string,
  sources: SourceRow[],
): Promise<string> {
  const phClient = getPostHogServer();
  const ai = new PostHogGoogleGenAI({ apiKey: geminiKey, posthog: phClient });

  const sourceDigest = sources
    .map(
      (s, i) =>
        `### Source ${i + 1}: ${s.title}\nSummary: ${s.contextDoc.summary}\nTopics: ${s.contextDoc.topics.join(', ')}`,
    )
    .join('\n\n');

  const response = await withResilience(
    () =>
      ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: `Research title: "${researchName}"\n\nIndexed sources:\n${sourceDigest}\n\nWrite a single TL;DR paragraph (3–5 sentences) for an executive who did not read the sources. Neutral tone, no hype.`,
              },
            ],
          },
        ],
        config: {
          systemInstruction:
            'You write concise executive summaries. Output must match the JSON schema exactly.',
          responseMimeType: 'application/json',
          responseJsonSchema: TldrJsonSchema,
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        },
        posthogDistinctId: clerkUserId,
        posthogTraceId: `report_tldr_${researchName.slice(0, 40)}`,
        posthogPrivacyMode: privacyMode,
        posthogProperties: { feature: 'report', tag: 'report_tldr' },
      }),
    {
      timeoutMs: TIMEOUT_MS,
      retries: 1,
      minTimeoutMs: 400,
      maxTimeoutMs: 1_500,
      shouldAbort: (err) => {
        const msg = err instanceof Error ? err.message : String(err ?? '');
        return /401|403|API key|invalid_api_key|PERMISSION_DENIED|quota/i.test(msg);
      },
    },
  );

  const text = response.text;
  if (typeof text !== 'string' || !text.length) {
    throw new Error('Gemini returned empty TL;DR');
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('Gemini TL;DR was not valid JSON');
  }
  const parsed = TldrZ.safeParse(json);
  if (!parsed.success) {
    throw new Error('Gemini TL;DR JSON did not validate');
  }
  return parsed.data.tldr;
}

function councilTranscriptSection(messages: Awaited<ReturnType<typeof listMessagesForRun>>): string {
  const lines = messages
    .filter((m) => m.role === 'agent' && m.councilRole)
    .map((m) => {
      const who =
        m.councilRole === 'chair'
          ? 'Chair'
          : m.councilSeat != null
            ? `Reviewer ${m.councilSeat}`
            : 'Reviewer';
      return `- **${who}:** ${m.body.replace(/\r?\n+/g, ' ').trim()}`;
    });
  if (lines.length === 0) {
    return '_No council transcript rows were stored for this run._\n';
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Build a Markdown export for a **completed** run owned by the user.
 * Throws `Error` with message for caller to map to HTTP status.
 */
export async function buildMarkdownReport(
  clerkUserId: string,
  runId: string,
): Promise<BuildMarkdownReportResult> {
  const run = await getRunForOwner(clerkUserId, runId);
  if (!run) {
    const err = new Error('Run not found');
    (err as Error & { code?: string }).code = 'not_found';
    throw err;
  }
  if (run.status !== 'complete') {
    const err = new Error('Run is not complete yet');
    (err as Error & { code?: string }).code = 'not_ready';
    throw err;
  }
  if (!run.prompts.length) {
    const err = new Error('This run has no prompts to export');
    (err as Error & { code?: string }).code = 'empty_prompts';
    throw err;
  }

  const { research } = await getResearchWithContext(clerkUserId, run.researchId);
  const sources = await listSourcesForResearch(clerkUserId, run.researchId);
  const runMessages = await listMessagesForRun(clerkUserId, run.researchId, runId);

  const geminiKey = await getUserApiKey(clerkUserId, 'gemini');
  const privacyAllowsCapture = await readPosthogCaptureLlm(clerkUserId);
  const privacyMode = !privacyAllowsCapture;

  let tldr: string;
  try {
    if (geminiKey && geminiKey.length >= 8) {
      tldr = await generateTldrParagraph(clerkUserId, geminiKey, privacyMode, research.name, sources);
    } else {
      tldr = fallbackTldr(research.name, sources);
    }
  } catch (e) {
    log.warn('report.tldr_failed', {
      run_id: runId,
      error: e instanceof Error ? e.message : String(e),
    });
    tldr = fallbackTldr(research.name, sources);
  }

  const finished = run.finishedAt ?? run.startedAt;
  const durationMs = finished - run.startedAt;
  const isoDate = new Date(finished).toISOString();

  const tableHeader = '| Cluster | Persona / intent | Prompt |\n| --- | --- | --- |\n';
  const tableRows = (run.prompts as FinalPrompt[])
    .map((p) => {
      const intent = `${mdCell(p.intent)} intent`;
      return `| ${mdCell(p.cluster)} | ${mdCell(intent)} | ${mdCell(p.text)} |`;
    })
    .join('\n');

  const perPromptNotes = (run.prompts as FinalPrompt[])
    .map((p, i) => {
      const head = `### Prompt ${i + 1} — ${p.cluster} (${p.intent} intent)`;
      const quote = `> ${p.text.replace(/\r?\n+/g, ' ').trim()}`;
      const note = p.councilNote
        ? `\n**Chair rationale:** ${p.councilNote.replace(/\r?\n+/g, ' ').trim()}`
        : '\n**Chair rationale:** _Not recorded for this prompt._';
      return `${head}\n${quote}${note}\n`;
    })
    .join('\n');

  const sourcesSection = sources
    .map((s, i) => {
      const origin = originFromSource(s);
      return `${i + 1}. **${mdCell(s.title)}** — ${mdCell(s.contextDoc.summary)}\n   - Origin: ${mdCell(origin)}`;
    })
    .join('\n');

  const markdown = `# ${research.name}

*Generated by Siftie on ${isoDate}*

## TL;DR

${tldr}

## Run metadata

- Models: ${MODELS_LINE}
- Council depth (this run): ${run.councilDepth}
- Sources read: ${sources.length}
- Prompts generated: ${run.prompts.length}
- Run duration: ${formatDurationMs(durationMs)}
- Peec: ${run.peecSkipped ? 'skipped (no key or opted out)' : `live scoring across ${run.totalChannels} channel(s)`}

## Sources

${sources.length ? sourcesSection : '_No sources._'}

## Prompt portfolio

${tableHeader}${tableRows}

## Per-prompt council notes

${perPromptNotes}

## Council transcript (this run)

${councilTranscriptSection(runMessages)}

---

*Siftie is BYOK. Test these prompts in ChatGPT, Perplexity, and Claude. Track surface rate with Peec when connected.*
`;

  const day = isoDate.slice(0, 10);
  const filename = `${slugify(research.name)}-${day}.md`;

  return { markdown, filename };
}

/**
 * Escape one cell for RFC 4180 CSV. We always wrap in double quotes —
 * Excel handles that uniformly and it sidesteps the "does this column
 * happen to contain a comma" question entirely.
 */
function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '""';
  const s = typeof value === 'number' ? String(value) : value;
  return `"${s.replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;
}

/**
 * Build a CSV export for a **completed** run owned by the user. The
 * file is intentionally flat — one row per prompt — so it round-trips
 * cleanly into spreadsheets, BI tools, or another LLM.
 *
 * If Peec was skipped, the `Hits` and `Total channels` columns are
 * left blank and a leading `# Peec: skipped` comment line documents
 * why. Comment line uses `#` so Excel/Sheets ignore it on import as
 * a malformed row but humans can read it in a text editor.
 */
export async function buildCsvReport(
  clerkUserId: string,
  runId: string,
): Promise<BuildCsvReportResult> {
  const run = await getRunForOwner(clerkUserId, runId);
  if (!run) {
    const err = new Error('Run not found');
    (err as Error & { code?: string }).code = 'not_found';
    throw err;
  }
  if (run.status !== 'complete') {
    const err = new Error('Run is not complete yet');
    (err as Error & { code?: string }).code = 'not_ready';
    throw err;
  }
  if (!run.prompts.length) {
    const err = new Error('This run has no prompts to export');
    (err as Error & { code?: string }).code = 'empty_prompts';
    throw err;
  }

  const { research } = await getResearchWithContext(clerkUserId, run.researchId);
  const finished = run.finishedAt ?? run.startedAt;
  const isoDate = new Date(finished).toISOString();
  const day = isoDate.slice(0, 10);

  const header = ['Cluster', 'Intent', 'Prompt', 'Hits', 'Total channels', 'Council note'];
  const lines: string[] = [];

  lines.push(`# Siftie prompt portfolio export — ${research.name}`);
  lines.push(`# Run id: ${run.id}`);
  lines.push(`# Generated: ${isoDate}`);
  if (run.peecSkipped) {
    lines.push(`# Peec: skipped (no key or opted out) — Hits / Total channels columns left blank`);
  } else {
    lines.push(
      `# Peec: live scoring across ${run.totalChannels} channel(s) over the 30 days preceding the run`,
    );
  }

  lines.push(header.map(csvCell).join(','));
  for (const p of run.prompts) {
    const row = [
      csvCell(p.cluster),
      csvCell(p.intent),
      csvCell(p.text),
      csvCell(run.peecSkipped ? '' : p.hits),
      csvCell(run.peecSkipped ? '' : p.totalChannels),
      csvCell(p.councilNote ?? ''),
    ];
    lines.push(row.join(','));
  }

  // Excel chokes on bare LF — RFC 4180 wants CRLF and that's what
  // every native spreadsheet app expects. UTF-8 BOM at the front
  // gets Excel to detect non-ASCII characters correctly.
  const csv = '\uFEFF' + lines.join('\r\n') + '\r\n';
  const filename = `${slugify(research.name)}-${day}.csv`;

  return { csv, filename, peecSkipped: run.peecSkipped };
}
