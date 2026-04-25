import { withUser } from '@/lib/auth';
import { deleteProject, renameProject } from '@/lib/workspace';
import { z } from 'zod';

const PatchBody = z.object({ name: z.string().min(1).max(120) });

type Ctx = { params: Promise<{ id: string }> };

/**
 * PATCH /api/projects/[id] { name }   — rename
 * DELETE /api/projects/[id]           — delete (cascades to researches)
 *
 * Both verify ownership inside the lib/workspace helpers (service-role
 * client requires manual ownership checks).
 */
export const PATCH = withUser<Ctx>(async ({ userId }, req, ctx) => {
  const { id } = await ctx.params;
  const json = await req.json().catch(() => null);
  const parsed = PatchBody.safeParse(json);
  if (!parsed.success) {
    return Response.json({ error: 'Invalid body' }, { status: 400 });
  }
  await renameProject(userId, id, parsed.data.name);
  return Response.json({ ok: true });
});

export const DELETE = withUser<Ctx>(async ({ userId }, _req, ctx) => {
  const { id } = await ctx.params;
  await deleteProject(userId, id);
  return Response.json({ ok: true });
});
