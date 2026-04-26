import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/auth';
import { listKeyStatus, type Provider } from '@/lib/keys';
import { userOwnsProjectAndResearch } from '@/lib/workspace';
import AppShell from '@/app/AppShell';

/**
 * Deep-linkable workspace entry — `/app/<projectId>/<researchId>`.
 *
 * Mirrors the top-level [`/app`](../../page.tsx) route but additionally:
 *   1. Validates that the URL pair is owned by the signed-in user.
 *      Falls back to `/app` (which restores the user's last
 *      `localStorage` selection) on a mismatch — this catches both
 *      stale links shared between users and links pointing at a deleted
 *      research without crashing the workspace.
 *   2. Threads `initialProjectId` / `initialResearchId` into AppShell so
 *      the client tree opens directly on the requested pair without
 *      flashing the previously-stored selection first.
 *
 * Onboarding gating (missing required API keys) keeps the same redirect
 * behaviour as `/app` — sending the user to settings even if they
 * deep-linked here, because the workspace is unusable without the keys.
 */
const REQUIRED_PROVIDERS: ReadonlyArray<Provider> = ['gemini', 'openrouter', 'tavily'];

export default async function AppDeepLinkPage({
  params,
}: {
  params: Promise<{ projectId: string; researchId: string }>;
}) {
  const { userId } = await requireUser();
  const keys = await listKeyStatus(userId);
  const byProvider = new Map(keys.map((k) => [k.provider, k]));
  const missingRequired = REQUIRED_PROVIDERS.some((p) => !byProvider.get(p)?.hasKey);
  if (missingRequired) {
    redirect('/settings/api-keys?onboarding=1');
  }

  const { projectId, researchId } = await params;
  const owns = await userOwnsProjectAndResearch(userId, projectId, researchId);
  if (!owns) {
    redirect('/app');
  }
  return <AppShell initialProjectId={projectId} initialResearchId={researchId} />;
}
