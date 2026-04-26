'use client';

import dynamic from 'next/dynamic';

// The interactive tree depends on window/localStorage for its initial state
// (viewport width, theme, persisted workspace), so we deliberately skip SSR.
// The server still renders the <html>/<body> shell from app/layout.tsx,
// including the anti-FOUC data-theme bootstrap script.
const App = dynamic(() => import('../src/App'), {
  ssr: false,
  loading: () => null,
});

interface AppShellProps {
  /**
   * When the workspace is opened via `/app/[projectId]/[researchId]`,
   * the server has already validated ownership of both ids — we forward
   * them straight to `useWorkspace` so the initial paint lands on the
   * deep-linked pair rather than whatever was last in `localStorage`.
   * Optional because `/app` itself also renders this shell.
   */
  initialProjectId?: string;
  initialResearchId?: string;
}

export default function AppShell({ initialProjectId, initialResearchId }: AppShellProps = {}) {
  return <App initialProjectId={initialProjectId} initialResearchId={initialResearchId} />;
}
