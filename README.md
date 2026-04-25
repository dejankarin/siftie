# siftie.app

Source: [github.com/dejankarin/siftie](https://github.com/dejankarin/siftie)

A three-column research UI for **Siftie** — a chat-driven prompt-portfolio builder that turns brand sources (PDFs, URLs, pasted text, internal DB) into AI-engine-ready prompts. Built with Next.js (App Router) + React + TypeScript + Tailwind, deployed on Vercel at [siftie.app](https://siftie.app).

## Run the UI locally

```sh
npm install
npm run dev
```

Then open http://localhost:3000/ (Next.js default). If something else already uses port 3000, run `PORT=3001 npm run dev` and open that port instead.

Other scripts:

- `npm run build` — production build (`.next/`)
- `npm run start` — serve the production build on http://localhost:3000/
- `npm run typecheck` — TypeScript check without emit
- `npm run lint` — Next.js lint

## Deploying to Vercel

The repo is a stock Next.js app, so Vercel auto-detects it. Either import the GitHub repo from the Vercel dashboard, or run `vercel` / `vercel --prod` from the repo root. No additional config or build settings are required.

### Project layout

```
app/
  layout.tsx                  # root HTML, fonts, anti-FOUC theme bootstrap
  page.tsx                    # renders <App />
  globals.css                 # design tokens + light/dark theme
src/
  App.tsx                     # 'use client' — state orchestration + layout
  components/                 # TopBar, MobileTopBar, MobileTabBar
                              # SourcesColumn, ChatColumn, PromptsColumn
                              # ResearchNav (project / research popover)
                              # AddSourceModal, EditSourceModal, ThemeToggle, Toast
  hooks/                      # useTheme, useViewport, useWorkspace
  data/mock.ts                # Loftway demo content
  data/workspace.ts           # workspace seed + blank-research factory
  types.ts                    # shared types
public/assets/                # Siftie logos (light + dark)
logo/                         # local-only logo source files (gitignored)
design-extract/               # original HTML+JSX prototype (reference only)
```

### Theming

The light/dark theme is driven by CSS variables under `:root` and `[data-theme="dark"]` in `app/globals.css`. The toggle persists to `localStorage` (key `siftie.theme`) and falls back to `prefers-color-scheme`.

### Projects & research sessions

The Sources column hosts a project / research switcher (top of the column). Each **research session** owns its own sources, chat, and prompt portfolio — switching swaps all three columns at once. Workspace state (projects + research sessions) persists to `localStorage` under `siftie.workspace.v1`, and a new research starts blank with a one-line greeting from the agent.

## Contributor setup

This repo uses [Entire](https://entire.io) to capture AI-agent sessions alongside Git commits. Hooks for Cursor, Claude Code, Codex, Factory AI Droid, and Gemini CLI are committed in this repo and are skipped automatically if the `entire` CLI is not installed.

To participate in shared session history (recommended):

```sh
# 1. Install the Entire CLI
curl -fsSL https://entire.io/install.sh | bash

# 2. From the repo root, enable Entire for the agents you use
entire enable --no-init-repo --agent cursor
entire configure --agent claude-code
entire configure --agent codex
entire configure --agent factoryai-droid
entire configure --agent gemini

# 3. Pull the shared checkpoints branch
git fetch origin entire/checkpoints/v1:entire/checkpoints/v1

# 4. Verify
entire status
```

After this, every `git push` will also push session checkpoints to the `entire/checkpoints/v1` branch on `origin`, and `git fetch` will pull in checkpoints created by other contributors. Use `entire attach` or `entire rewind` to resume a teammate's session.
