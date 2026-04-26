/**
 * GET /api/research/[runId]/report
 *
 * Streams a Markdown report for a completed run (Session 9).
 */
import { withUser } from '@/lib/auth';
import { buildMarkdownReport } from '@/lib/report';
import { ForbiddenError } from '@/lib/workspace';

export const runtime = 'nodejs';

type Ctx = { params: Promise<{ runId: string }> };

export const GET = withUser<Ctx>(async ({ userId }, _req, ctx) => {
  const { runId } = await ctx.params;
  try {
    const { markdown, filename } = await buildMarkdownReport(userId, runId);
    return new Response(markdown, {
      status: 200,
      headers: {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename.replace(/"/g, '')}"`,
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
    console.error('[api/research/report]', err);
    return Response.json({ error: 'report_failed' }, { status: 500 });
  }
});
