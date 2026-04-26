/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Reverse-proxy PostHog through siftie.app/ingest so ad-blockers (uBlock,
  // Brave shields, ABP) don't drop ~15-30% of browser events. Pairs with
  // `api_host: '/ingest'` and `ui_host: 'https://eu.posthog.com'` in
  // app/PostHogProvider.tsx — the api_host hits the rewrite, the ui_host
  // is what "view in PostHog" deep links use.
  // skipTrailingSlashRedirect prevents a 308 on /ingest/decide which
  // PostHog calls without a trailing slash.
  skipTrailingSlashRedirect: true,
  async rewrites() {
    return [
      {
        source: '/ingest/static/:path*',
        destination: 'https://eu-assets.i.posthog.com/static/:path*',
      },
      {
        source: '/ingest/:path*',
        destination: 'https://eu.i.posthog.com/:path*',
      },
      {
        source: '/ingest/decide',
        destination: 'https://eu.i.posthog.com/decide',
      },
    ];
  },
};

export default nextConfig;
