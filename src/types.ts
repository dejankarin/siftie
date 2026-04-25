export type SourceType = 'pdf' | 'url' | 'doc' | 'md';

/**
 * Lightweight client-side mirror of `lib/ingest/schema.ts`'s ContextDoc.
 * Kept duplicated (rather than imported from lib/) so that:
 *   - `lib/*` files can use `import 'server-only'` without infecting the
 *     client bundle.
 *   - Adding fields server-side stays backward compatible — the client
 *     just sees them as `unknown` until we widen this type.
 *
 * Optional fields are typed as such because old localStorage entries
 * from before Session 3 lack the field entirely.
 */
export interface ContextDoc {
  title: string;
  summary: string;
  words: number;
  topics: string[];
  entities: { kind: 'brand' | 'product' | 'person' | 'place' | 'concept'; name: string }[];
  facts: string[];
  rawExcerpt: string;
}

export interface Source {
  id: string;
  type: SourceType;
  title: string;
  /**
   * Human-readable subtitle shown under the source title in the UI.
   * Built server-side from the structured `meta` JSONB at hydrate time
   * (e.g. "12 pages · 2 min ago" / "competitor.com · just now").
   */
  meta: string;
  snippet: string;
  /** Filled by the server after Gemini indexes the source. Absent for in-flight optimistic rows. */
  contextDoc?: ContextDoc;
  /** UI-only flag used while a POST /api/sources call is in flight. */
  pending?: boolean;
}

export interface Message {
  id: string;
  role: 'user' | 'agent';
  time: string;
  text: string;
}

export type PromptCluster = 'Category' | 'Persona' | 'Comparison';
export type Intent = 'High' | 'Med' | 'Low';

export interface PortfolioPrompt {
  id: string;
  cluster: PromptCluster;
  text: string;
  hits: number;
  intent: Intent;
}

export type PromptFilter = 'All' | PromptCluster;

export interface Project {
  id: string;
  name: string;
  createdAt: number;
}

export interface Research {
  id: string;
  projectId: string;
  name: string;
  createdAt: number;
  sources: Source[];
  messages: Message[];
  prompts: PortfolioPrompt[];
}

export interface WorkspaceState {
  projects: Project[];
  researches: Research[];
  activeProjectId: string;
  activeResearchId: string;
}
