import { withUser } from '@/lib/auth';
import { createServiceRoleSupabaseClient } from '@/lib/supabase/server';
import { z } from 'zod';

/**
 * GET /api/privacy
 * Returns the current `posthog_capture_llm` value from the user's profile.
 * Defaults to `true` if no row exists yet (matches the column default).
 */
export const GET = withUser(async ({ userId }) => {
  const supabase = createServiceRoleSupabaseClient();
  const { data, error } = await supabase
    .from('user_profiles')
    .select('posthog_capture_llm')
    .eq('clerk_user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return Response.json({ posthogCaptureLlm: data?.posthog_capture_llm ?? true });
});

const Body = z.object({
  posthogCaptureLlm: z.boolean(),
});

/**
 * POST /api/privacy
 * Body: { posthogCaptureLlm: boolean }
 * Updates the toggle. The PostHog person property mirror happens client-side
 * (PrivacyToggle.tsx calls posthog.setPersonProperties); we keep the DB as
 * the source of truth so the server-side LLM wrappers in Session 3+ can
 * read it without a PostHog round-trip.
 */
export const POST = withUser(async ({ userId }, req) => {
  const json = await req.json().catch(() => null);
  const parsed = Body.safeParse(json);
  if (!parsed.success) {
    return Response.json({ error: 'Invalid body' }, { status: 400 });
  }
  const supabase = createServiceRoleSupabaseClient();
  const { error } = await supabase
    .from('user_profiles')
    .update({ posthog_capture_llm: parsed.data.posthogCaptureLlm })
    .eq('clerk_user_id', userId);
  if (error) throw error;
  return Response.json({ ok: true });
});
