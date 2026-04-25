import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/auth';
import { listKeyStatus, type Provider } from '@/lib/keys';
import AppShell from '../AppShell';

/**
 * Workspace entry — server component.
 *
 * Two side-effects before rendering:
 *   1. `requireUser()` triggers the lazy `user_profiles` upsert so any
 *      downstream insert (projects, researches) has its FK target.
 *   2. Reads the user's API-key status; if any of the three required keys
 *      (gemini, openrouter, tavily) is missing, redirects to the Settings
 *      page with `?onboarding=1` to swap the page header to the welcome
 *      copy. Peec is optional and never blocks entry.
 *
 * Once those checks pass, hands off to AppShell — the dynamic-imported
 * client tree that fetches the workspace from /api/workspace and renders
 * the three-column UI.
 */
const REQUIRED_PROVIDERS: ReadonlyArray<Provider> = ['gemini', 'openrouter', 'tavily'];

export default async function AppPage() {
  const { userId } = await requireUser();
  const keys = await listKeyStatus(userId);
  const byProvider = new Map(keys.map((k) => [k.provider, k]));
  const missingRequired = REQUIRED_PROVIDERS.some((p) => !byProvider.get(p)?.hasKey);
  if (missingRequired) {
    redirect('/settings/api-keys?onboarding=1');
  }
  return <AppShell />;
}
