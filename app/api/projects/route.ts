import { withUser } from '@/lib/auth';
import { createProject } from '@/lib/workspace';
import { z } from 'zod';

const Body = z.object({
  name: z.string().min(1).max(120),
});

/**
 * POST /api/projects { name }
 * Creates a project and a paired blank research (so the user always lands
 * in a usable state). Returns both so the client can update its local
 * state in a single optimistic step.
 */
export const POST = withUser(async ({ userId }, req) => {
  const json = await req.json().catch(() => null);
  const parsed = Body.safeParse(json);
  if (!parsed.success) {
    return Response.json({ error: 'Invalid body' }, { status: 400 });
  }
  const { project, research } = await createProject(userId, parsed.data.name);
  return Response.json({ project, research });
});
