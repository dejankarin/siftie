/**
 * GET /api/research/[runId]/export
 *
 * Streams a CSV export of the prompt portfolio for a completed run.
 * Same ownership/state checks as the Markdown report route — only
 * the body builder + content-type differ.
 *
 * The CSV is intentionally a peer of the Markdown report rather than
 * a flag on it: spreadsheet users want the table verbatim, while the
 * Markdown report includes TL;DR + sources + council transcript that
 * don't roll up into rows.
 */
import { withUser } from '@/lib/auth';
import { getPostHogServer } from '@/lib/posthog';
import { buildCsvReport } from '@/lib/report';
import { getProjectIdForResearch } from '@/lib/workspace';
import { ForbiddenError } from '@/lib/workspace';
import { getRunForOwner } from '@/lib/runs';

export const runtime = 'nodejs';

type Ctx = { params: Promise<{ runId: string }> };

export const GET = withUser<Ctx>(async ({ userId }, _req, ctx) => {
  const { runId } = await ctx.params;
  try {
    const result = await buildCsvReport(userId, runId);
    // Capture *after* the build succeeds — failed exports are tracked
    // by their HTTP error path below, which carries an `error_code`
    // property so the funnel splits cleanly.
    try {
      const run = await getRunForOwner(userId, runId);
      const projectId = run ? await getProjectIdForResearch(run.researchId) : null;
      getPostHogServer().capture({
        distinctId: userId,
        event: 'csv_exported',
        groups: projectId ? { project: projectId } : undefined,
        properties: {
          run_id: runId,
          research_id: run?.researchId,
          prompt_count: run?.prompts.length ?? 0,
          peec_skipped: result.peecSkipped,
          surface: 'drawer',
        },
      });
    } catch (e) {
      // Telemetry must never block the user from getting their file.
      console.warn('[csv_exported telemetry]', e);
    }
    return new Response(result.csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${result.filename.replace(/"/g, '')}"`,
      },
    });
  } catch (err) {
    const code = (err as Error & { code?: string }).code;
    if (code === 'not_found') {
      return Response.json({ error: 'not_found' }, { status: 404 });
    }
    if (code === 'not_ready' || code === 'empty_prompts') {
      return Response.json(
        { error: code, message: err instanceof Error ? err.message : 'Bad request' },
        { status: 400 },
      );
    }
    if (err instanceof ForbiddenError) {
      return Response.json({ error: 'forbidden' }, { status: 403 });
    }
    console.error('[api/research/export]', err);
    return Response.json({ error: 'export_failed' }, { status: 500 });
  }
});
