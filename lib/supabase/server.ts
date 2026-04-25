/**
 * Server-side Supabase client that forwards the Clerk session token to
 * Supabase via the Third-Party Auth integration. Use from API routes,
 * Server Components, and Server Actions.
 *
 * Why an `accessToken` callback instead of `setAuth(jwt)`:
 *   The newer Clerk + Supabase native integration (April 2025+) is a
 *   first-class third-party auth provider. We just hand Supabase a callback
 *   that returns the current Clerk session token; Supabase validates it
 *   against Clerk's JWKS at clerk.siftie.app/.well-known/jwks.json, sets
 *   the request role to `authenticated`, and `auth.jwt() ->> 'sub'` in our
 *   RLS policies returns the Clerk user id.
 *
 * Why we don't reuse a global client instance:
 *   The `accessToken` callback closes over `auth()`, which Next.js requires
 *   to run inside a request scope. Caching a client across requests would
 *   silently leak one user's session token to the next request.
 */
import 'server-only';
import { auth } from '@clerk/nextjs/server';
import { createClient } from '@supabase/supabase-js';

export function createServerSupabaseClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      async accessToken() {
        const { getToken } = await auth();
        return (await getToken()) ?? null;
      },
    },
  );
}

/**
 * Service-role Supabase client that bypasses Row-Level Security.
 *
 * Reserved for trusted server paths where we explicitly need to read or
 * write across users — currently only:
 *   - the Clerk webhook handler at /api/clerk/webhook (which inserts the
 *     user_profiles row before the user has a session token to authenticate
 *     against RLS with)
 *   - the BYOK Test endpoints, when reading a key for the *current* user
 *     during a request that for transient reasons hasn't propagated the
 *     auth header yet (rare; prefer the regular client)
 *
 * NEVER use from a route that takes user-controlled input without first
 * verifying ownership manually — RLS will not save you here.
 */
export function createServiceRoleSupabaseClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    },
  );
}
