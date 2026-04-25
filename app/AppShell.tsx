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

export default function AppShell() {
  return <App />;
}
