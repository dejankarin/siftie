export type SourceType = 'pdf' | 'url' | 'doc' | 'md';

export interface Source {
  id: string;
  type: SourceType;
  title: string;
  meta: string;
  snippet: string;
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
