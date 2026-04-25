import { withUser } from '@/lib/auth';
import { fetchOrSeedWorkspace } from '@/lib/workspace';

/**
 * GET /api/workspace
 * Returns the signed-in user's projects + researches. If the user has no
 * projects yet, lazily seeds one project + one blank research and returns
 * those, so the client never has to handle an empty workspace.
 */
export const GET = withUser(async ({ userId }) => {
  const payload = await fetchOrSeedWorkspace(userId);
  return Response.json(payload);
});
