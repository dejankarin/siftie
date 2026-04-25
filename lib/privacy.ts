/**
 * Tiny server-side helper to read the user's `posthog_capture_llm`
 * preference. Used by every route that calls Gemini/OpenRouter so the
 * LLM wrappers can pass `posthogPrivacyMode: !setting`.
 *
 * Defaults to `true` (capture allowed) so a missing row doesn't quietly
 * downgrade observability — the row should always exist after
 * `requireUser()` runs, but defensive programming.
 */
import 'server-only';
import { createServiceRoleSupabaseClient } from './supabase/server';

export async function readPosthogCaptureLlm(clerkUserId: string): Promise<boolean> {
  const supabase = createServiceRoleSupabaseClient();
  const { data } = await supabase
    .from('user_profiles')
    .select('posthog_capture_llm')
    .eq('clerk_user_id', clerkUserId)
    .maybeSingle();
  return data?.posthog_capture_llm ?? true;
}
