import { requireUser } from '@/lib/auth';
import { listKeyStatus } from '@/lib/keys';
import { ApiKeysForm } from './ApiKeysForm';

/**
 * Server shell — fetches initial key status (no plaintext keys ever cross
 * this boundary; only `hasKey` flags + last-test metadata) and hands it to
 * the client form below.
 */
export const metadata = {
  title: 'API Keys · Siftie',
};

export default async function ApiKeysPage({
  searchParams,
}: {
  searchParams: Promise<{ onboarding?: string }>;
}) {
  const { userId } = await requireUser();
  const status = await listKeyStatus(userId);
  const params = await searchParams;
  const onboarding = params.onboarding === '1';

  return <ApiKeysForm initialStatus={status} onboarding={onboarding} />;
}
