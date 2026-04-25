import { requireUser } from '@/lib/auth';
import { createServiceRoleSupabaseClient } from '@/lib/supabase/server';
import { PrivacyToggle } from './PrivacyToggle';

export const metadata = {
  title: 'Privacy · Siftie',
};

export default async function PrivacyPage() {
  const { userId } = await requireUser();
  const supabase = createServiceRoleSupabaseClient();
  const { data } = await supabase
    .from('user_profiles')
    .select('posthog_capture_llm')
    .eq('clerk_user_id', userId)
    .maybeSingle();

  // The DB default is `true` and `requireUser()` guarantees the row exists,
  // but we still defensively fall back to true so the UI stays sane if a
  // race somehow returned null.
  const initial = data?.posthog_capture_llm ?? true;

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="font-[Inter] text-[24px] font-semibold tracking-tight">Privacy</h1>
        <p className="text-[14px] text-[var(--ink-2)] mt-1.5 leading-relaxed">
          Control what Siftie sends to its analytics backend (PostHog Cloud EU).
        </p>
      </header>
      <PrivacyToggle initial={initial} />
    </div>
  );
}
