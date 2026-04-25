/**
 * Clerk auth middleware.
 *
 * Public routes (no auth required):
 *   /                    — marketing landing page
 *   /sign-in/*           — Clerk's prebuilt sign-in pages
 *   /sign-up/*           — Clerk's prebuilt sign-up pages
 *   /api/clerk/webhook   — Clerk webhook endpoint (verified via signature, not session)
 *
 * Everything else (incl. /app/*, /settings/*, /api/*) requires a Clerk
 * session. Unauthenticated requests to a protected route are redirected
 * to /sign-in by `auth.protect()`.
 *
 * The `matcher` skips Next.js internals and static assets so we don't pay
 * the Clerk middleware cost on every CSS/JS/image request.
 */
import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';

const isPublicRoute = createRouteMatcher([
  '/',
  '/sign-in(.*)',
  '/sign-up(.*)',
  '/api/clerk/webhook(.*)',
]);

export default clerkMiddleware(async (auth, req) => {
  if (!isPublicRoute(req)) {
    await auth.protect();
  }
});

export const config = {
  matcher: [
    // Skip Next internals (_next/*) and any path that ends in a known asset extension.
    // Match everything else, including dynamic routes and API routes.
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
  ],
};
