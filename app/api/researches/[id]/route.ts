import { withUser } from '@/lib/auth';
import { CouncilDepth } from '@/lib/research/schema';
import {
  deleteResearch,
  renameResearch,
  setResearchCouncilDepth,
} from '@/lib/workspace';
import { z } from 'zod';

/**
 * Either `name` (rename) or `councilDepth` (composer dropdown) — at
 * least one must be present. Both are accepted in the same request,
 * but in practice the client only ever sends one at a time.
 */
const PatchBody = z
  .object({
    name: z.string().min(1).max(120).optional(),
    councilDepth: CouncilDepth.optional(),
  })
  .refine((b) => b.name !== undefined || b.councilDepth !== undefined, {
    message: 'Provide either name or councilDepth',
  });

type Ctx = { params: Promise<{ id: string }> };

export const PATCH = withUser<Ctx>(async ({ userId }, req, ctx) => {
  const { id } = await ctx.params;
  const json = await req.json().catch(() => null);
  const parsed = PatchBody.safeParse(json);
  if (!parsed.success) {
    return Response.json({ error: 'Invalid body' }, { status: 400 });
  }
  if (parsed.data.name !== undefined) {
    await renameResearch(userId, id, parsed.data.name);
  }
  if (parsed.data.councilDepth !== undefined) {
    await setResearchCouncilDepth(userId, id, parsed.data.councilDepth);
  }
  return Response.json({ ok: true });
});

export const DELETE = withUser<Ctx>(async ({ userId }, _req, ctx) => {
  const { id } = await ctx.params;
  await deleteResearch(userId, id);
  return Response.json({ ok: true });
});
