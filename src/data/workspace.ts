import type { Message, Research, WorkspaceState } from '../types';
import { INITIAL_MESSAGES, INITIAL_PROMPTS, INITIAL_SOURCES } from './mock';

export const DEFAULT_PROJECT_NAME = 'Loftway · SS26 launch portfolio';
export const DEFAULT_RESEARCH_NAME = 'Initial research';

let counter = 0;
export function uid(prefix: string) {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}${counter}${Math.random().toString(36).slice(2, 6)}`;
}

function nowTime(): string {
  const d = new Date();
  return `${d.getHours() % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')} ${d.getHours() >= 12 ? 'PM' : 'AM'}`;
}

export function blankIntroMessage(): Message {
  return {
    id: uid('m'),
    role: 'agent',
    time: nowTime(),
    text:
      "New research started. Drop in sources — a brand brief, competitor URLs, customer transcripts — and I'll start drafting your prompt portfolio.",
  };
}

export function createBlankResearch(projectId: string, name: string): Research {
  return {
    id: uid('r'),
    projectId,
    name,
    createdAt: Date.now(),
    sources: [],
    messages: [blankIntroMessage()],
    prompts: [],
  };
}

export function seedWorkspace(): WorkspaceState {
  const projectId = uid('p');
  const researchId = uid('r');
  return {
    projects: [{ id: projectId, name: DEFAULT_PROJECT_NAME, createdAt: Date.now() }],
    researches: [
      {
        id: researchId,
        projectId,
        name: DEFAULT_RESEARCH_NAME,
        createdAt: Date.now(),
        sources: INITIAL_SOURCES,
        messages: INITIAL_MESSAGES,
        prompts: INITIAL_PROMPTS,
      },
    ],
    activeProjectId: projectId,
    activeResearchId: researchId,
  };
}
