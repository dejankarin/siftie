/**
 * DELETE /api/sources/[id]
 *
 * Removes a source the user owns. Ownership is verified inside
 * `deleteSource()` because we use the service-role Supabase client.
 *
 * Captures `source_removed` for parity with `source_added` so dashboards
 * can show a clean per-research "current source count over time".
 */
import { withUser } from '@/lib/auth';
import { getPostHogServer } from '@/lib/posthog';
import { deleteSource, getSource } from '@/lib/sources';

export const runtime = 'nodejs';

export const DELETE = withUser(
  async ({ userId }, _req, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    if (!id) {
      return Response.json({ error: 'source id is required' }, { status: 400 });
    }
    // Pre-fetch so we can include kind/research_id in the analytics event
    // before the row vanishes.
    const source = await getSource(userId, id);
    await deleteSource(userId, id);

    const ph = getPostHogServer();
    ph.capture({
      distinctId: userId,
      event: 'source_removed',
      properties: {
        source_id: id,
        kind: source.kind,
        research_id: source.researchId,
      },
    });

    return Response.json({ ok: true });
  },
);
