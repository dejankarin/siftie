# aeo-agent.com

A three-column research UI for **AEOagent** — a chat-driven prompt-portfolio builder that turns brand sources (PDFs, URLs, pasted text, internal DB) into AI-engine-ready prompts. Built with Vite + React + TypeScript + Tailwind.

## Run the UI locally

```sh
npm install
npm run dev
```

Then open http://127.0.0.1:5173/.

Other scripts:

- `npm run build` — typecheck and bundle to `dist/`
- `npm run preview` — preview the production bundle on `http://127.0.0.1:4173/`

### Project layout

```
src/
  App.tsx              # state orchestration + layout
  components/          # TopBar, MobileTopBar, MobileTabBar
                       # SourcesColumn, ChatColumn, PromptsColumn
                       # AddSourceModal, EditSourceModal, ThemeToggle, Toast
  hooks/               # useTheme, useViewport
  data/mock.ts         # Loftway demo content
  index.css            # design tokens + light/dark theme
public/assets/         # AEOagent logos (light + dark)
design-extract/        # original HTML+JSX prototype (reference only)
```

The light/dark theme is driven by CSS variables under `:root` and `[data-theme="dark"]` in `src/index.css`. The toggle persists to `localStorage` and falls back to `prefers-color-scheme`.

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
