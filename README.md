# Siftie

> Your brand, in every AI answer. Siftie builds and tests a prompt portfolio across different LLMs — from sources you already have.

**Live:** [siftie.app](https://siftie.app) · **Repo:** [github.com/dejankarin/siftie](https://github.com/dejankarin/siftie)

A three-column research workspace (Sources / Chat / Prompts) that turns brand sources (PDFs, URLs, Word docs, Markdown) into AI-engine-ready prompts. The agent narrates the entire research pipeline inside the chat column, including anonymised LLM Council reviewer bubbles. Bring-your-own-keys (BYOK) — every user pastes their own OpenAI / Gemini / OpenRouter / Tavily keys (and optionally Peec) and pays for their own usage.

## Status

Built and deployed in nine iterative sprints (Sessions 1–9). As of **commit `ab7546d`**:

| Session | What | Status |
|---|---|---|
| 1 | Clerk auth + Supabase RLS + PostHog init/identify + Vercel deploy | Shipped |
| 2A | Settings → API Keys (BYOK encrypt + test) + Privacy toggle | Shipped |
| 2B | Workspace persistence (Supabase) + first-sign-in keys gate | Shipped |
| 3 | Live source ingest (PDF / URL / Word doc / Markdown) | Shipped |
| 4 | Live chat + Gemini-generated interview questions | Shipped |
| 5 | Peec REST wrappers + shared resilience layer + offline banner | Shipped |
| 6 | Research orchestrator (Ideate → [Peec] → Council → Surface) + chat narration | Shipped |
| 6.5 | Stoppable research runs (soft cancellation via `runs.status`) | Shipped |
| 6.6 | Three-column IA polish (Sources / Chat / Output) + Markdown report download | Shipped |
| —   | Deep-link routing `/app/[projectId]/[researchId]` + `sources` Realtime sync | Shipped |
| 7 | Prompts column live (dynamic HitsBar, Show-all drawer, CSV export) | Shipped |
| 8 | Reply router (Tavily web search) + landing polish + mobile pass | Shipped |
| 9 | Operational observability — PostHog Siftie Live dashboard (4 live tiles), 2 LLM Analytics evals (Chair LLM-judge + ContextDoc hog), cluster view, FAQ in README | Shipped |

Beyond the original plan, the following also shipped:

- **OpenAI Platform direct** as the Ideate primary (GPT-5.4) with Gemini Flash fallback, plus an OpenAI fallback for source ingestion when Gemini Flash is unavailable. Independent of OpenRouter so users can use their existing OpenAI billing.
- **3-model fast Council lineup** — the original plan called for a 4-seat all-frontier Council (`gpt-5.4` + `gemini-3.1-pro-preview` + `claude-opus-4.5` + `grok-4`) but the full deliberation took ~60–90s end-to-end, which made the live agent feel like a backend job instead of a real-time collaborator. Swapped to **`openai/gpt-5.4-mini`** + **`google/gemini-2.5-flash`** + **`anthropic/claude-haiku-4.5`** — one fast tier per major vendor, ~3–5x faster wall-clock, still proves the cross-vendor disagreement thesis. `REVIEWER_COUNT_BY_DEPTH` shifted from `{ quick: 3, standard: 4 }` to `{ quick: 2, standard: 3 }` to keep the depth lever; the OpenRouter per-call timeout dropped from 90s → 60s. The first seat (`gpt-5.4-mini`) doubles as the synthesis Chair, same family as the Ideate primary so the Chair runs the exact reasoning lineage that produced the candidate prompts. Easy to scale back up to 4 frontier reviewers later — it's a single edit to `COUNCIL_MODELS` in `lib/openrouter.ts` (the DB constraint already allows seats 1–4).
- **Stoppable research runs (Session 6.5)** — soft cancellation via `cancelRun()` flipping `runs.status` to `'failed'` (no dedicated `cancelling` enum — saves a Supabase migration; the cancel chat bubble carries the user-facing semantics). The orchestrator polls `isRunCancelled()` between stages and exits early; the chat narrates the stop and the prompts column reflects it without a reload.
- **Markdown report download (Session 6.6)** — `GET /api/research/[runId]/report` streams a comprehensive Markdown export (TL;DR via Gemini Flash, run metadata, sources table, prompt portfolio with per-prompt Chair rationales, full Council transcript) wired to the **Download report** button at the bottom of the prompts column.
- **Deep-link routing** — `/app/[projectId]/[researchId]` server route validates ownership in one query and falls back to `redirect('/app')` on mismatch (no information leak). The client keeps URL ⇄ active-pair in sync bidirectionally so the browser back button walks recent research switches naturally.
- **`sources` Realtime sync** — third `postgres_changes` handler (alongside `messages` and `runs`) on the same Supabase channel keeps the sources column consistent across multiple tabs of the same workspace, with insert/update/delete coverage and dedupe against the local optimistic-swap path.
- **Lucide icon system** — every UI icon across the app (TopBar, SettingsTopBar, ThemeToggle, ResearchNav, SourcesColumn) is rendered from [`lucide-react`](https://lucide.dev/). Hand-rolled inline SVG components are gone; Lucide is the only icon source going forward (brand assets in `Images/` and `app/icon.svg` excluded). Tree-shaken so only the imported glyphs ship in the bundle.
- **Sources column simplification** — dropped the compact/detailed view toggle in favour of a single list view, and rebuilt the "Recent" sort control as a borderless ghost dropdown with a Lucide `ChevronDown` indicator (was a fully-rounded pill).
- **PostHog Logs** via OpenTelemetry / OTLP HTTP — every server log line ships to PostHog Cloud EU as structured events keyed by Clerk user id and run id (production only).
- **PostHog feature flags** server-resolved and bootstrapped to the browser on every render so flag values match what the server saw — no flicker.
- **PostHog group analytics** so events are also attributed to the active Siftie project.
- **PostHog source maps** uploaded automatically on every Vercel production build for symbolicated stack traces.
- **App + global error boundaries** (`app/error.tsx`, `app/global-error.tsx`).
- **Session 7 prompts column** — dynamic HitsBar that scales to the live Peec channel set with channel-name tooltips (one cell per `model_channel_id`, persisted on `runs.channels` JSONB so the bar labels itself without a refetch); a column-level **Refresh hits** button that re-fires the Peec brand-baseline lookup via `POST /api/runs/[runId]/refresh-hits` and writes the freshly-fetched `hits` / `totalChannels` onto every prompt in the run (Peec's baseline is portfolio-wide — it doesn't index our prompt ids — so the only honest semantics are to update them all together); a **Show all N** bottom drawer with per-prompt Chair rationale in collapsible `<details>`; a **Generate cluster** popover (Category / Persona / Comparison) that posts a synthetic `Generate a new <Cluster> cluster of prompts.` message into chat for the Session 8 reply router; a **Peec-skipped** dismissible banner (per-research, persisted in `localStorage`), empty-state surface-rate card, and "Hits" sort hidden when there's no Peec data; the **Refresh hits** control swaps to **Add Peec key** in the same slot; CSV export via `GET /api/research/[runId]/export` (UTF-8 BOM + CRLF for Excel, leading `# Peec: skipped` comment line when applicable) wired to a text button inside the drawer; PostHog client + server events `prompt_copied`, `hits_refreshed`, `hits_refresh_failed`, `prompt_cluster_generated`, and `csv_exported` with cluster / intent / hit-state / channel-count / surface metadata.
- **Session 8 reply router** — `lib/reply-router.ts` runs Gemini 3 Flash with structured output to classify every non-first chat message into `chat_only` / `refine_prompts` / `rebaseline` / `run_research` / `web_search`. The `web_search` branch fans out to `lib/tavily.ts#searchWeb` + a second Gemini summariser (`summariseSearchHits`) that writes a 2–4 sentence reply with inline `[n]` citations and a Markdown `Sources:` footer. `POST /api/messages` returns the lead-in agent reply immediately and runs all side effects (web search summary, `runResearchPipeline` for `run_research` / `rebaseline`) behind `waitUntil`, with follow-up bubbles arriving via Supabase Realtime. PostHog events: `reply_router_decision`, `reply_router_failed`, `reply_router_websearch_completed`, `reply_router_websearch_failed`, `reply_router_run_research_failed` — all carry `$ai_trace_id` so they correlate with the `$ai_generation` events in LLM Analytics. Defensive: when Gemini returns `web_search` but the user has no Tavily key, the router downgrades to `chat_only` so the user always gets a reply.
- **Session 8 landing page** — `app/page.tsx` is a server component (Clerk `auth()` redirects signed-in users to `/app`) with sticky nav (logo + theme toggle + Log in + Sign up), a hero (badge, headline, tagline, primary CTA, BYOK reassurance), a three-step value-prop grid (Add sources → Chat with the agent → Get a tested portfolio), and a token-driven HTML mock of the 3-column workspace that swaps with the theme toggle so it never goes stale relative to the real app.
- **Session 8 mobile pass** — `AddSourceModal` switched to a flex-column with `max-h-[calc(100dvh-2rem)]` + scrollable body so the Cancel/Add buttons stay anchored on landscape phones; `MobileTopBar` placeholder "More" button replaced with the real Clerk `<UserButton />` (with the API Keys link mirroring desktop); mobile `<main>` padding bumped to `pb-[calc(58px+env(safe-area-inset-bottom))]` so the chat composer clears the iPhone home indicator; `MobileTabBar` tab buttons gain `aria-current` + visible focus styling; `ChatColumn` composer wrapper uses `focus-within:shadow-[0_0_0_3px_var(--focus-ring)]` and the Send button gains `focus-visible:ring`.
- **Session 9 operational observability** — provisioned the **Siftie Live** PostHog dashboard with four live tiles (sign-up funnel, runs/day succeed-vs-fail, avg LLM cost per run, top brand-category clusters) plus two automatic LLM Analytics evaluations: an **LLM-judge** that scores every `tag: council_chair` `$ai_generation` against a 5-criterion rubric (≥6 picks, substantive summary, meaningful `councilNote` rationales, topical diversity, schema validity) and a **deterministic Hog eval** that validates every `tag: context_doc` `$ai_generation` against the production `ContextDoc` schema (title + ≥50-char summary + ≥3 topics + ≥1 entity + ≥3 facts + rawExcerpt). Both evals enabled in production; the cluster tile rides the existing `Default - generations` LLM Analytics clustering job. See **Observability dashboard & evals** below for URLs and the **FAQ** section for context on the design decisions.

## Run locally

```sh
cp .env.local.example .env.local   # fill in the values
npm install
npm run dev
```

Open <http://localhost:3000>. If port 3000 is busy, `PORT=3001 npm run dev`.

Other scripts:

- `npm run build` — production build (`.next/`). Postbuild uploads source maps to PostHog when `VERCEL_ENV=production`.
- `npm run start` — serve the production build.
- `npm run typecheck` — TypeScript with no emit.
- `npm run lint` — Next.js lint.

## Tech stack

**Framework:** Next.js 15 (App Router) · React 18 · TypeScript · Tailwind v3 · [Lucide](https://lucide.dev/) icons via `lucide-react` (the only icon source — no inline hand-rolled SVGs) · deployed on Vercel (Fluid Compute, Node.js 24)

**Auth:** Clerk (`@clerk/nextjs`) — `<ClerkProvider>` in `app/layout.tsx`, `clerkMiddleware()` in `middleware.ts`, prebuilt sign-in / sign-up pages, `<UserButton />` in TopBar.

**Database:** Supabase (Postgres + Realtime), RLS scoped on `auth.jwt() ->> 'sub'` (Clerk user id). Server client in `lib/supabase/server.ts` mints an authenticated Supabase token from Clerk via the third-party-auth integration.

**Encryption:** AES-256-GCM (Node `crypto`) with a 12-byte IV per row (`lib/crypto.ts`). Master key in `KEY_ENCRYPTION_KEY` env var. Provider keys are decrypted only inside server route handlers, never logged.

**Models** (BYOK — every user supplies their own keys):

| Stage | Model | Provider | Notes |
|---|---|---|---|
| Source ingestion (primary) | `gemini-3-flash-preview` | Gemini API | ContextDoc extraction with `ThinkingLevel.LOW`. Native PDF inline support. |
| Source ingestion (fallback) | `gpt-5.4` | OpenAI Platform | Used when Gemini Flash fails / quota. |
| Interview questions | `gemini-3-flash-preview` | Gemini API | First six gap-attributed questions per research. |
| **Ideate (primary)** | **`gpt-5.4`** | **OpenAI Platform** | ~24 candidate prompts, structured output via `response_format: json_schema`, reasoning model with `reasoning_effort: 'low'`. |
| Ideate (fallback) | `gemini-3-flash-preview` | Gemini API | `ThinkingLevel.MEDIUM`. |
| Council reviewers | `openai/gpt-5.4-mini`, `google/gemini-2.5-flash`, `anthropic/claude-haiku-4.5` | OpenRouter | Fast lineup: 3 models, one per major vendor — chosen so the live agent feels snappy (~3–5x faster end-to-end vs. an all-frontier lineup) while still proving cross-vendor disagreement. Anonymised seats 1–3. Every run uses Standard depth (all 3 reviewers); no user-facing depth selector. |
| Council Chair | `openai/gpt-5.4-mini` | OpenRouter | First seat doubles as the synthesis Chair (same family as the Ideate primary), with per-prompt `councilNote`. |

**Web layer:** Tavily (`@tavily/core`) — `extract` for URL ingestion, `search` reserved for the Session 8 reply router action.

**Optional:** Peec (`x-api-key` header) — live brand-mention data per prompt for Enterprise customers. The orchestrator skips the Peec step when no key is configured; the prompts column renders an empty-HitsBar banner with an "Add Peec key" link.

**Observability:** PostHog Cloud EU (`posthog-js`, `posthog-node`, `@posthog/ai`, OpenTelemetry logs).

- Web Analytics + product events on the landing page.
- LLM Analytics auto-instrumented via `@posthog/ai/openai` and `@posthog/ai/gemini` — every Ideate / Council / Chair / ContextDoc call emits a `$ai_generation` event tagged with `feature`, `provider`, `posthogTraceId: research_<runId>`, and Clerk user id.
- Application logs via OpenTelemetry → OTLP HTTP → `https://eu.i.posthog.com/i/v1/logs` with `service.name=siftie-app` and `deployment.environment` (production only — see `instrumentation.ts`).
- Group analytics attribute every event to the active Siftie project.
- Feature flags resolved server-side and bootstrapped to the browser (see `lib/flags.ts`).
- Source maps uploaded by `scripts/upload-sourcemaps.mjs` on every Vercel production build.

## Architecture

```
                        ┌─────────────────────┐
                        │ siftie.app (Vercel) │
                        └──────────┬──────────┘
                                   │
            ┌──────────────────────┼──────────────────────┐
            │                      │                      │
       ┌────▼─────┐           ┌────▼─────┐           ┌────▼─────┐
       │  Clerk   │           │ Supabase │           │ PostHog  │
       │  (auth)  │           │ (Postgres│           │ (EU      │
       │          │           │ Realtime)│           │  cloud)  │
       └──────────┘           └──────────┘           └──────────┘

  /api/sources              → Tavily Extract / mammoth / inline PDF → Gemini Flash → ContextDoc → Supabase
  /api/messages (first)     → Gemini Flash first-six interview questions             → Supabase
  /api/messages (subseq.)   → Reply router (Gemini Flash structured output) → branch:
                                chat_only      → persist agent reply
                                refine_prompts → cluster ack
                                rebaseline / run_research → waitUntil(startResearchRun)
                                web_search     → waitUntil(searchWeb + summarise)
  /api/research             → Ideate (GPT-5.4 → Gemini Flash fallback)
                              → [Peec baseline if key]
                              → Council (3 OpenRouter models, 3 stages, anonymised — fast lineup)
                              → Chair synthesis
                              → runs row + chat bubbles via Realtime
  /api/research/cancel      → cancelRun() flips status='failed'; orchestrator polls isRunCancelled() between stages
  /api/research/[id]/report → Gemini Flash TL;DR + Markdown export (sources, prompts, transcript)
  /api/research/[id]/export → CSV export of the prompt portfolio (UTF-8 BOM + CRLF, Excel-friendly)
  /api/runs/[id]/refresh-hits → re-run the Peec brand baseline for the run and update every prompt's hits
```

## Project layout

```
app/
  layout.tsx                  Root HTML, fonts, anti-FOUC theme, ClerkProvider, PostHogProvider, PostHogIdentify
  page.tsx                    Marketing landing page — hero + three-step value prop + workspace HTML mock + footer (signed-in users redirect to /app)
  LandingThemeToggle.tsx      Client wrapper that hydrates the theme toggle on the (otherwise server-rendered) landing page
  AppShell.tsx                Dynamic-imported workspace shell (ssr: false). Accepts optional initialProjectId / initialResearchId for deep-link entry.
  globals.css                 Design tokens + light/dark theme
  error.tsx, global-error.tsx Client + root error boundaries (PostHog Error Tracking)
  icon.svg                    Favicon (dark Siftie mark, #041923 background)
  app/
    page.tsx                                     Server component — requires auth, gates on 3 required keys
    [projectId]/[researchId]/page.tsx            Deep-link entry — validates ownership of the pair, falls back to /app on mismatch
  settings/
    layout.tsx                SettingsTopBar + SettingsSidebar
    api-keys/page.tsx + ApiKeysForm.tsx
    privacy/page.tsx + PrivacyToggle.tsx
  sign-in/[[...sign-in]]/page.tsx
  sign-up/[[...sign-up]]/page.tsx
  api/
    keys/route.ts             POST upserts encrypted user_api_keys
    keys/test/[provider]/route.ts
    privacy/route.ts          POST toggles user_profiles.posthog_capture_llm
    workspace/route.ts        GET projects + researches for current user
    projects/route.ts + [id]/route.ts
    researches/route.ts + [id]/route.ts
    sources/route.ts + [id]/route.ts + [id]/reindex/route.ts
    messages/route.ts         POST user reply (also generates first-six interview questions)
    research/route.ts         POST start a research run (returns 202, work runs in waitUntil)
    research/cancel/route.ts  POST cancelRun() flips a running run to status='failed' (orchestrator polls isRunCancelled() between stages)
    research/[runId]/report/route.ts  GET stream a Markdown report for a completed run
    research/[runId]/export/route.ts  GET stream a CSV of the prompt portfolio (UTF-8 BOM + CRLF)
    runs/[runId]/refresh-hits/route.ts  POST re-run the Peec brand baseline for the run and update every prompt's hits
lib/
  auth.ts                     requireUser() — Clerk auth + lazy user_profiles upsert
  council.ts                  3-stage Council (independent review → cross review → Chair)
  crypto.ts                   AES-256-GCM encrypt/decrypt for BYOK keys
  docx.ts                     mammoth wrapper (Word doc → text + html)
  flags.ts                    Typed PostHog feature flags + server-side accessor
  gemini.ts                   Gemini 3 Flash wrapper (PostHog-instrumented)
  ideate.ts                   Ideate stage — OpenAI primary, Gemini Flash fallback
  ingest/                     ContextDoc Zod schema + dispatcher (pdf/url/doc/md)
  interview.ts                First-six interview questions via Gemini Flash
  keys.ts                     getUserApiKey(userId, provider) + listKeyStatus
  logger.ts                   OpenTelemetry-backed structured logger (lazily resolves loggerProvider)
  messages.ts                 Chat persistence + listing
  openai.ts                   OpenAI Platform wrapper (gpt-5.4, reasoning-aware)
  openrouter.ts               OpenRouter wrapper (Council models, reasoning-aware)
  peec.ts                     Peec REST wrappers (listChannels, getUrlReport, etc.)
  peec-baseline.ts            Single-shot brand-baseline lookup reused by Refresh hits (POST /api/runs/[id]/refresh-hits)
  posthog.ts                  Server PostHog singleton + getPostHogServer()
  privacy.ts                  Reads user_profiles.posthog_capture_llm
  provider-errors.ts          Normalises raw SDK errors into stable user-facing codes
  reply-router.ts             Session 8 reply router — Gemini 3 Flash structured output classifies non-first chat messages; second-stage summariser writes citation-rich web-search replies
  report.ts                   Markdown report builder (Gemini Flash TL;DR + run metadata + sources + prompts + transcript) + CSV export (`buildCsvReport`, RFC 4180, UTF-8 BOM + CRLF)
  research/schema.ts          Zod schemas for IdeatePrompt, ReviewerVerdict, ChairPick, FinalPrompt
  research.ts                 Top-level orchestrator (Ideate → Peec → Council → Surface), polls for soft cancellation
  resilience.ts               Shared withResilience helper (timeouts, retries, abort rules)
  runs.ts                     Run lifecycle (createRun, completeRun, failRun, getLatestRunByResearch, getRunForOwner, cancelRun, isRunCancelled, updateRunPrompts)
  sources.ts                  Source persistence + listing
  supabase/                   Supabase clients (server with Clerk JWT; browser with public anon)
  tavily.ts                   Tavily wrapper (extract, search — used by the Session 8 reply router for web_search actions)
  workspace.ts                Project + research CRUD against Supabase, plus userOwnsProjectAndResearch() ownership check used by the deep-link route
src/
  App.tsx                     Three-column desktop + mobile-tab layout. Bidirectional URL ⇄ active-pair sync (push on UI switch, adopt URL on back/forward).
  components/                 TopBar, MobileTopBar, MobileTabBar, SourcesColumn, ChatColumn,
                              PromptsColumn, ResearchNav, RunResearchButton, AddSourceModal,
                              EditSourceModal, ThemeToggle, Toast
  hooks/                      useTheme, useViewport, useWorkspace (accepts initialProjectId/initialResearchId; subscribes to messages/runs/sources Realtime)
  data/                       mock + workspace seed factories
  types.ts                    Shared types
supabase/migrations/
  20260425225511_initial_schema.sql        # all v1 tables + RLS + Realtime publication
  20260426010000_add_openai_provider.sql   # adds 'openai' to user_api_keys.provider check
  20260426120000_add_run_channels.sql      # adds runs.channels JSONB (Peec model channel id + description) for the dynamic HitsBar
instrumentation.ts            OpenTelemetry LoggerProvider for PostHog Logs (Node runtime, prod only)
middleware.ts                 Clerk middleware (public: /, /sign-in, /sign-up, /api/clerk/webhook)
scripts/upload-sourcemaps.mjs PostHog source-map upload (postbuild, prod only)
```

## Environment variables

Copy `.env.local.example` to `.env.local` and fill it in. The full key list lives in the example file with inline comments. Summary:

- **Clerk** — `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `CLERK_WEBHOOK_SECRET`, plus the four `NEXT_PUBLIC_CLERK_*_URL` vars that pin the sign-in / sign-up routes inside the app.
- **Supabase** — `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, plus `NEXT_PUBLIC_SUPABASE_URL` + `NEXT_PUBLIC_SUPABASE_ANON_KEY` for the browser.
- **`KEY_ENCRYPTION_KEY`** — base64-encoded 32-byte master key (`openssl rand -base64 32`). Lose this and every user re-pastes their provider keys.
- **PostHog** — `NEXT_PUBLIC_POSTHOG_KEY`, `NEXT_PUBLIC_POSTHOG_HOST=https://eu.i.posthog.com`. Optional: `POSTHOG_PERSONAL_API_KEY` (provisioning evals/dashboards) and `POSTHOG_CLI_API_KEY` (Vercel-prod-only, source-map upload).
- **`NEXT_PUBLIC_APP_URL`** — `https://siftie.app` in prod.

**No platform-level provider keys.** No `OPENAI_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `TAVILY_API_KEY`, or `PEEC_API_KEY` in Vercel — those are per-user, encrypted in `user_api_keys`, and decrypted on demand inside server route handlers.

## Database

Migrations live in `supabase/migrations/`. Apply with the Supabase CLI:

```sh
supabase login
supabase link --project-ref <your-project-ref>
supabase db push
```

Schema overview (all RLS-scoped on Clerk user id):

- `user_profiles` — one row per Clerk user; carries `posthog_capture_llm` (default `true`).
- `user_api_keys` — encrypted BYOK keys per `(clerk_user_id, provider)`. Providers: `openai`, `gemini`, `openrouter`, `tavily`, `peec`.
- `projects` → `researches` → `sources` / `messages` / `runs`.
- `messages.council_role` (`reviewer | chair`) + `messages.council_seat` (1–3 in the fast lineup; DB allows 1–4) replay anonymised Council bubbles on refresh.
- `runs` — one per research run; stores `prompts` JSONB, `channels` JSONB (Peec model channels surfaced for this run, used by the dynamic HitsBar tooltips), `total_channels`, `peec_skipped`, `council_depth`, `status`.
- Realtime publication: `sources`, `messages`, `runs`.

## Privacy

Settings → Privacy exposes a single toggle that maps to `user_profiles.posthog_capture_llm` (default ON). Effect:

- **ON:** PostHog `$ai_generation` events include prompt + response bodies (which may include derived brand/source summaries).
- **OFF:** Only metadata (model, tokens, cost, latency, run id, tags) — bodies are stripped via `posthogPrivacyMode: true`.

Either way, we **never** capture decrypted provider keys, raw uploaded files, email, or name.

## Observability dashboard & evals

PostHog project **Siftie** (id 166503) on **eu.posthog.com**. Provisioned via the PostHog MCP, all wired to events the app already emits (no extra instrumentation).

**Dashboard:** [Siftie Live](https://eu.posthog.com/project/166503/dashboard/644165) — pinned, four tiles:

| Tile | Type | Backing query | What it shows |
|---|---|---|---|
| [Sign-up funnel](https://eu.posthog.com/project/166503/insights/oWRC6dKj) | Funnel (4 steps, 14-day window) | `$pageview /` → `$pageview /sign-up` → `key_added (provider=gemini)` → `research_run_complete` | Acquisition: how many landing visitors actually finish a research run. |
| [Research runs per day (succeeded vs. failed)](https://eu.posthog.com/project/166503/insights/4wBsqnk7) | Trends (stacked bar, `day` interval, 14d) | `research_run_complete` + `research_run_failed` events from `lib/research.ts` | Headline reliability number — the success/failure ratio is the most important signal after the 3-model fast Council swap. |
| [Avg LLM cost per research run (USD)](https://eu.posthog.com/project/166503/insights/iFQOAixL) | HogQL line graph | `avg(sum($ai_total_cost_usd))` grouped by `$ai_trace_id` (= one Siftie run; set in `lib/openrouter.ts`) and bucketed by day | Economics: validates the swap to the fast Council keeps the per-run budget under control. Target ≪ $0.10/run. |
| [Top brand categories (LLM Analytics clusters)](https://eu.posthog.com/project/166503/insights/epdsd3d2) | HogQL table | Latest `Default - generations` `$ai_generation_clusters` event, unrolled via `arrayJoin(JSONExtractArrayRaw($ai_clusters))` | Topic mix across every Siftie LLM call (ideate prompts, context docs, council reviews). For interactive drill-down: [LLM Analytics → Clusters](https://eu.posthog.com/project/166503/llm-analytics/clusters). |

**Evaluations** (both auto-run on every matching `$ai_generation` event; results land as `$ai_evaluation` events):

| Eval | Type | Trigger | What it checks |
|---|---|---|---|
| [Council Chair output quality](https://eu.posthog.com/project/166503/llm-analytics/evaluations) | LLM-judge (`gemini-3-flash-preview`) | `tag = council_chair` | 5-criterion pass/fail rubric: `summary` ≥40 chars and references the council's reasoning · `picks` has ≥6 entries · every `councilNote` ≥20 chars · picks topically diverse · valid JSON. |
| [ContextDoc completeness](https://eu.posthog.com/project/166503/llm-analytics/evaluations) | Hog (deterministic) | `tag = context_doc` | Parses the nested `output → choices[1].content[1].text` JSON and asserts the production `ContextDoc` schema (title + summary ≥50 chars + ≥3 topics + ≥1 entity + ≥3 facts + rawExcerpt). FAIL signals the Gemini ingest prompt or the source itself is too thin. |

The Hog eval was test-driven against five real production events first via `evaluation-test-hog` — every Galaxy S26 Ultra and Nothing Phone ContextDoc passes (8–10 topics, 8–10 entities, 10–15 facts).

> **Two follow-ups** for the dashboard owner:
>
> 1. **Provider key for the Chair eval.** The LLM-judge runs on PostHog's infrastructure, not Siftie's, so it needs its own key. Add a Gemini key under [eu.posthog.com → Settings → Provider keys](https://eu.posthog.com/project/166503/settings/environment#provider-keys) (or swap the eval to OpenRouter / OpenAI in the eval definition).
> 2. **Cluster tile populates on next clustering run.** PostHog runs the default clustering jobs on a schedule; the table is empty until the first `Default - generations` job sees enough $ai_generation events. As traffic grows it fills in automatically.

## FAQ

Three questions that come up most often, with honest answers:

**Q1 · Why a 3-model "fast" Council instead of all-frontier reviewers?**
A 4-seat all-frontier Council (`gpt-5.4` + `gemini-3.1-pro-preview` + `claude-opus-4.5` + `grok-4`) was spec'd in the original plan, and we shipped it through Session 6. End-to-end it ran ~60–90s per research, which made the live agent feel like a backend job instead of a real-time collaborator. We swapped to **`openai/gpt-5.4-mini`** + **`google/gemini-2.5-flash`** + **`anthropic/claude-haiku-4.5`** — one fast tier per major vendor, ~3–5× faster wall-clock, still proves the cross-vendor disagreement thesis. The Chair stays in the OpenAI family (`gpt-5.4-mini`) so it shares reasoning lineage with the Ideate primary. Going back to the frontier lineup is a one-line edit to `COUNCIL_MODELS` in `lib/openrouter.ts`; the DB constraint already permits seats 1–4. The [avg-cost tile](https://eu.posthog.com/project/166503/insights/iFQOAixL) on the dashboard quantifies the trade-off in dollars per run.

**Q2 · How do you know the Council isn't just rubber-stamping itself?**
Three independent signals, all production-instrumented:
1. **Anonymised reviewers.** Stage 1 reviewers see only the candidate prompts + the source ContextDocs, not each other's verdicts. Stage 2 reviewers see anonymised peer verdicts (`Reviewer A / B / C`, no model names). The Chair sees everything but doesn't know which seat is which model. So agreement is structural, not social.
2. **The Chair eval.** Every `council_chair` `$ai_generation` is auto-graded by an external Gemini Flash judge against a 5-criterion rubric — including topical diversity. A judge FAIL means the Chair collapsed onto a single cluster, which is exactly the rubber-stamp pathology. Results stream into PostHog as `$ai_evaluation` events; we can surface them as a fifth dashboard tile or fire a Slack alert when pass rate dips below threshold.
3. **The ContextDoc Hog eval.** A deterministic upstream check that the Gemini source-indexer is producing substantive grounding (≥3 topics, ≥1 entity, ≥3 facts). If the Council picks look identical, this tells us whether it's because the Council is lazy or because the sources were thin.

**Q3 · This is BYOK. What happens at scale, and what's actually in your trust boundary?**
Every paying user pastes their own OpenAI / Gemini / OpenRouter / Tavily / (optionally) Peec keys. Keys are encrypted at rest with AES-256-GCM (`lib/crypto.ts`, master key in `KEY_ENCRYPTION_KEY`), decrypted only inside server route handlers, never logged, never sent to PostHog (privacy mode is enforced server-side per user via `user_profiles.posthog_capture_llm`). At inference time:
- Provider calls fan out from Vercel Fluid Compute functions with each request's own key.
- LLM Analytics events go to PostHog Cloud EU with a `posthogTraceId = research_<runId>` so per-tenant cost attribution is automatic — that's literally what the [avg-cost tile](https://eu.posthog.com/project/166503/insights/iFQOAixL) reads.
- Supabase RLS scopes every read/write on `auth.jwt() ->> 'sub'` (Clerk user id) so a misconfigured client can't leak across tenants.
- We never store raw uploaded files — only the structured ContextDoc + a 500-char excerpt — so a database breach doesn't expose the brand's source material.

Scale-out story: nothing in the request path is single-tenant — Clerk, Supabase, Fluid Compute, OpenRouter, PostHog all scale per-tenant out of the box. The bottleneck would be Peec's per-key rate limits, which we already handle via `lib/peec-baseline.ts` exponential backoff and the `peec_call` PostHog event for monitoring.

## Theming

Light / dark theme driven by CSS custom properties under `:root` and `[data-theme="dark"]` in `app/globals.css`. The toggle persists to `localStorage['siftie.theme']` and falls back to `prefers-color-scheme`. An anti-FOUC inline script in `app/layout.tsx` reads the key before hydration so the first paint is correct.

## Deploying to Vercel

The repo is a stock Next.js app, so Vercel auto-detects it. Either import the GitHub repo from the Vercel dashboard or run `vercel` / `vercel --prod` from the repo root. Make sure all env vars from `.env.local.example` are configured under Vercel → Project → Settings → Environment Variables before the first production build. The `siftie.app` domain is already attached.
