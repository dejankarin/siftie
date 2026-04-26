import type { Metadata, Viewport } from 'next';
import { ClerkProvider } from '@clerk/nextjs';
import { auth } from '@clerk/nextjs/server';
import { PostHogProvider } from './PostHogProvider';
import { PostHogIdentify } from './PostHogIdentify';
import { getServerFlags } from '@/lib/flags';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL('https://siftie.app'),
  title: 'Siftie',
  description:
    'Siftie — chat-driven prompt-portfolio builder that turns brand sources into AI-engine-ready prompts.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

// Applies the persisted theme before paint to avoid a light/dark FOUC.
const themeBootstrapScript = `(() => {
  try {
    const stored = localStorage.getItem('siftie.theme');
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const theme = stored === 'light' || stored === 'dark' ? stored : (prefersDark ? 'dark' : 'light');
    document.documentElement.setAttribute('data-theme', theme);
  } catch {}
})();`;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Resolve PostHog feature flags server-side so the browser SDK can
  // bootstrap with them — eliminates flag flicker between SSR and hydration.
  // `auth()` returns null userId for anonymous visitors (landing page),
  // which getServerFlags handles by returning an empty bootstrap.
  const { userId } = await auth();
  const bootstrap = userId ? await getServerFlags(userId) : undefined;

  return (
    <ClerkProvider>
      <html lang="en" suppressHydrationWarning>
        <head>
          <link rel="preconnect" href="https://fonts.googleapis.com" />
          <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
          <link
            href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Instrument+Serif:ital@0;1&family=JetBrains+Mono:wght@400;500&display=swap"
            rel="stylesheet"
          />
          <script dangerouslySetInnerHTML={{ __html: themeBootstrapScript }} />
        </head>
        <body suppressHydrationWarning>
          <PostHogProvider bootstrap={bootstrap}>
            <PostHogIdentify />
            {children}
          </PostHogProvider>
        </body>
      </html>
    </ClerkProvider>
  );
}
