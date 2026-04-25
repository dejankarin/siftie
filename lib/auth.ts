/**
 * Server-side auth helpers used by every authenticated API route and
 * Server Component.
 *
 * `requireUser()` does three things:
 *   1. Reads the Clerk session via `auth()`.
 *   2. If unauthenticated, throws an `UnauthorizedError` (callers turn that
 *      into a 401 response). We throw rather than redirect because middleware
 *      already redirects HTML routes; API routes need a JSON 401 surface.
 *   3. Lazily upserts the matching `user_profiles` row using the service-
 *      role client, so subsequent inserts into user_api_keys/projects don't
 *      fail their FK constraint. This replaces the Clerk webhook (deferred
 *      to v2) with an idempotent on-demand pattern: every authenticated
 *      request guarantees the row exists.
 *
 * The upsert is done with the *service-role* client because the RLS policy
 * requires `auth.jwt() ->> 'sub' = clerk_user_id`, which is true here, but
 * inserting through the user-scoped client requires a fully-formed JWT and
 * one extra round-trip to Supabase. The service-role path is faster and we
 * still pass the verified clerkUserId from Clerk's session, so we can't be
 * tricked into bootstrapping the wrong user.
 *
 * Bootstrap is fire-once per user; after the first call the ON CONFLICT DO
 * NOTHING short-circuits in the database with no row write.
 */
import 'server-only';
import { auth, currentUser } from '@clerk/nextjs/server';
import { createServiceRoleSupabaseClient } from './supabase/server';
import { ForbiddenError } from './workspace';

export class UnauthorizedError extends Error {
  status = 401;
  constructor(message = 'Not signed in') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

let bootstrappedUserIds: Set<string> | null = null;

function getBootstrapCache(): Set<string> {
  if (!bootstrappedUserIds) bootstrappedUserIds = new Set();
  return bootstrappedUserIds;
}

export interface RequiredUser {
  userId: string;
}

export async function requireUser(): Promise<RequiredUser> {
  const { userId } = await auth();
  if (!userId) throw new UnauthorizedError();

  const cache = getBootstrapCache();
  if (!cache.has(userId)) {
    const user = await currentUser();
    const email = user?.primaryEmailAddress?.emailAddress ?? null;
    const supabase = createServiceRoleSupabaseClient();
    const { error } = await supabase
      .from('user_profiles')
      .upsert(
        { clerk_user_id: userId, email },
        { onConflict: 'clerk_user_id', ignoreDuplicates: true },
      );
    if (error) {
      // Don't crash the request — the row may already exist from a previous
      // upsert that raced with this one. RLS-protected reads/writes will
      // still succeed via the user-scoped client below.
      console.warn('[requireUser] user_profiles upsert warning:', error.message);
    }
    cache.add(userId);
  }

  return { userId };
}

/**
 * Wraps a route handler so callers get a clean 401 JSON response when the
 * caller isn't signed in, without each route re-implementing the boilerplate.
 *
 * @example
 * ```ts
 * export const POST = withUser(async ({ userId }, req) => {
 *   const body = await req.json();
 *   // ... do authenticated work ...
 *   return Response.json({ ok: true });
 * });
 * ```
 */
type Handler<TCtx> = (
  user: RequiredUser,
  req: Request,
  ctx: TCtx,
) => Promise<Response> | Response;

export function withUser<TCtx = unknown>(handler: Handler<TCtx>) {
  return async (req: Request, ctx: TCtx): Promise<Response> => {
    try {
      const user = await requireUser();
      return await handler(user, req, ctx);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        return Response.json({ error: err.message }, { status: 401 });
      }
      if (err instanceof ForbiddenError) {
        return Response.json({ error: err.message }, { status: 403 });
      }
      console.error('[withUser] unhandled error:', err);
      const message = err instanceof Error ? err.message : 'Internal error';
      return Response.json({ error: message }, { status: 500 });
    }
  };
}
