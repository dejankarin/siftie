import { withUser } from '@/lib/auth';
import { deleteResearch, renameResearch } from '@/lib/workspace';
import { z } from 'zod';

/**
 * PATCH /api/researches/[id] — currently rename only.
 *
 * Note: an earlier version also accepted `councilDepth` for the composer
 * dropdown. Session 6.6 removed that UI; new runs default to Standard
 * and operators flip to Quick via the PostHog `council_depth_override`
 * feature flag (no DB write needed). The body field was pruned with the
 * `setCouncilDepth` mutator on the client.
 */
const PatchBody = z.object({
  name: z.string().min(1).max(120),
});

type Ctx = { params: Promise<{ id: string }> };

export const PATCH = withUser<Ctx>(async ({ userId }, req, ctx) => {
  const { id } = await ctx.params;
  const json = await req.json().catch(() => null);
  const parsed = PatchBody.safeParse(json);
  if (!parsed.success) {
    return Response.json({ error: 'Invalid body' }, { status: 400 });
  }
  await renameResearch(userId, id, parsed.data.name);
  return Response.json({ ok: true });
});

export const DELETE = withUser<Ctx>(async ({ userId }, _req, ctx) => {
  const { id } = await ctx.params;
  await deleteResearch(userId, id);
  return Response.json({ ok: true });
});
