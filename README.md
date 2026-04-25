# aeo-agent.com

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
