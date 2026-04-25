import { withUser } from '@/lib/auth';
import { createResearch } from '@/lib/workspace';
import { z } from 'zod';

const Body = z.object({
  projectId: z.string().uuid(),
  name: z.string().min(1).max(120),
});

/**
 * POST /api/researches { projectId, name }
 * Creates a new research inside the given project. Verifies the project
 * belongs to the signed-in user before inserting.
 */
export const POST = withUser(async ({ userId }, req) => {
  const json = await req.json().catch(() => null);
  const parsed = Body.safeParse(json);
  if (!parsed.success) {
    return Response.json({ error: 'Invalid body' }, { status: 400 });
  }
  const research = await createResearch(userId, parsed.data.projectId, parsed.data.name);
  return Response.json({ research });
});
