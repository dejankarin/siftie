/**
 * Browser-side Supabase client that forwards the Clerk session token to
 * Supabase via the Third-Party Auth integration.
 *
 * Use from React components / hooks (useWorkspace, useEffect data fetches,
 * Realtime subscriptions). The Clerk session is read from `useSession()`
 * by the calling code, so the factory takes the session as an argument.
 *
 * @example
 * ```tsx
 * 'use client';
 * import { useSession } from '@clerk/nextjs';
 * import { createBrowserSupabaseClient } from '@/lib/supabase/client';
 *
 * function MyComponent() {
 *   const { session } = useSession();
 *   const supabase = useMemo(() => createBrowserSupabaseClient(session), [session]);
 *   // ...
 * }
 * ```
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { useSession } from '@clerk/nextjs';

type ClerkSession = ReturnType<typeof useSession>['session'];

export function createBrowserSupabaseClient(session: ClerkSession): SupabaseClient {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      async accessToken() {
        return (await session?.getToken()) ?? null;
      },
    },
  );
}
