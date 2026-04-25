import AppShell from '../AppShell';

/**
 * Workspace entry. Session 1 just renders the existing client App tree
 * (still backed by localStorage via useWorkspace). Session 2 swaps the
 * storage backend to Supabase and adds /app/[projectId]/[researchId] so
 * URLs become deep-linkable to a specific research session.
 */
export default function AppPage() {
  return <AppShell />;
}
