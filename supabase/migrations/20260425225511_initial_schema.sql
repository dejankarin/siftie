-- =============================================================================
-- Siftie initial schema
-- =============================================================================
-- Single migration that creates the full v1 schema:
--
--   user_profiles    : 1 row per Clerk user (acts as the FK target everything
--                      else hangs off; keeps clerk_user_id stable across the
--                      schema even if a user updates their email)
--   user_api_keys    : encrypted BYOK provider keys
--                      (gemini / openrouter / tavily / peec)
--   projects         : top-level grouping (e.g. "Loftway · SS26 launch")
--   researches       : individual research session inside a project
--   sources          : PDF / URL / Word doc / Markdown that feed a research
--   messages         : chat transcript (user replies, agent replies, council
--                      reviewer bubbles, council chair bubbles)
--   runs             : one orchestrator run per "do research" command;
--                      stores the final prompts JSONB for replay
--
-- Every table has RLS enabled and is scoped on the Clerk user id, which is
-- read from the JWT issued by Clerk and forwarded to Supabase via the
-- Third-Party Auth integration. The Clerk session token carries
--   role: "authenticated"
--   sub:  "<clerk_user_id>"
-- so Supabase grants the `authenticated` role and `auth.jwt() ->> 'sub'`
-- returns the Clerk user id natively.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Extensions
-- -----------------------------------------------------------------------------
-- pgcrypto powers gen_random_uuid(); enabled by default on Supabase but
-- declaring explicitly keeps this migration portable.
create extension if not exists "pgcrypto";

-- -----------------------------------------------------------------------------
-- Helper: bump updated_at on every row update
-- -----------------------------------------------------------------------------
-- Used by `sources` and `messages` so the TopBar "Saved 2 min ago" indicator
-- can derive freshness from max(updated_at) without manual bookkeeping.
create or replace function public.tg_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- user_profiles
-- -----------------------------------------------------------------------------
-- Single row per Clerk user. Created lazily on first authenticated request
-- (until the Clerk webhook is wired in Session 1's tail end, this is the
-- bootstrap path). The `posthog_capture_llm` flag is read by every
-- server-side LLM call to decide whether to attach prompt/response bodies
-- to the PostHog trace.
create table public.user_profiles (
  clerk_user_id        text         primary key,
  email                text,
  posthog_capture_llm  boolean      not null default true,
  created_at           timestamptz  not null default now()
);

alter table public.user_profiles enable row level security;

-- A user can read / insert / update their own profile row. We deliberately
-- don't expose DELETE through RLS — account deletion goes through Clerk and
-- is reflected here via webhook (or a back-office admin path in v2).
create policy "user_profiles: select own"
  on public.user_profiles for select
  to authenticated
  using ((auth.jwt() ->> 'sub') = clerk_user_id);

create policy "user_profiles: insert own"
  on public.user_profiles for insert
  to authenticated
  with check ((auth.jwt() ->> 'sub') = clerk_user_id);

create policy "user_profiles: update own"
  on public.user_profiles for update
  to authenticated
  using ((auth.jwt() ->> 'sub') = clerk_user_id)
  with check ((auth.jwt() ->> 'sub') = clerk_user_id);

-- -----------------------------------------------------------------------------
-- user_api_keys
-- -----------------------------------------------------------------------------
-- Per-user, per-provider encrypted API keys (BYOK). Encryption is performed
-- in the Node.js application layer (lib/crypto.ts) using AES-256-GCM with a
-- 12-byte IV per row, so even a database dump on its own does not reveal
-- the plaintext keys without KEY_ENCRYPTION_KEY.
create table public.user_api_keys (
  clerk_user_id     text         not null references public.user_profiles(clerk_user_id) on delete cascade,
  provider          text         not null check (provider in ('gemini', 'openrouter', 'tavily', 'peec')),
  encrypted_key     bytea        not null,
  iv                bytea        not null,
  auth_tag          bytea        not null,
  last_tested_at    timestamptz,
  last_test_status  text         check (last_test_status in ('ok', 'fail')),
  updated_at        timestamptz  not null default now(),
  primary key (clerk_user_id, provider)
);

alter table public.user_api_keys enable row level security;

create policy "user_api_keys: select own"
  on public.user_api_keys for select
  to authenticated
  using ((auth.jwt() ->> 'sub') = clerk_user_id);

create policy "user_api_keys: insert own"
  on public.user_api_keys for insert
  to authenticated
  with check ((auth.jwt() ->> 'sub') = clerk_user_id);

create policy "user_api_keys: update own"
  on public.user_api_keys for update
  to authenticated
  using ((auth.jwt() ->> 'sub') = clerk_user_id)
  with check ((auth.jwt() ->> 'sub') = clerk_user_id);

create policy "user_api_keys: delete own"
  on public.user_api_keys for delete
  to authenticated
  using ((auth.jwt() ->> 'sub') = clerk_user_id);

create trigger tg_user_api_keys_updated_at
  before update on public.user_api_keys
  for each row execute function public.tg_set_updated_at();

-- -----------------------------------------------------------------------------
-- projects
-- -----------------------------------------------------------------------------
create table public.projects (
  id             uuid         primary key default gen_random_uuid(),
  clerk_user_id  text         not null references public.user_profiles(clerk_user_id) on delete cascade,
  name           text         not null,
  created_at     timestamptz  not null default now()
);

create index projects_user_idx on public.projects(clerk_user_id, created_at desc);

alter table public.projects enable row level security;

create policy "projects: select own"
  on public.projects for select
  to authenticated
  using ((auth.jwt() ->> 'sub') = clerk_user_id);

create policy "projects: insert own"
  on public.projects for insert
  to authenticated
  with check ((auth.jwt() ->> 'sub') = clerk_user_id);

create policy "projects: update own"
  on public.projects for update
  to authenticated
  using ((auth.jwt() ->> 'sub') = clerk_user_id)
  with check ((auth.jwt() ->> 'sub') = clerk_user_id);

create policy "projects: delete own"
  on public.projects for delete
  to authenticated
  using ((auth.jwt() ->> 'sub') = clerk_user_id);

-- -----------------------------------------------------------------------------
-- researches
-- -----------------------------------------------------------------------------
-- Council depth defaults to 'standard' (4 reviewers + Chair) and can be
-- toggled per research from the composer dropdown. The orchestrator copies
-- this value onto the resulting `runs` row at run-start so historic replay
-- doesn't drift if the user later changes the default.
create table public.researches (
  id             uuid         primary key default gen_random_uuid(),
  project_id     uuid         not null references public.projects(id) on delete cascade,
  name           text         not null,
  council_depth  text         not null default 'standard' check (council_depth in ('quick', 'standard')),
  created_at     timestamptz  not null default now()
);

create index researches_project_idx on public.researches(project_id, created_at desc);

alter table public.researches enable row level security;

-- Researches inherit ownership from their parent project. We use EXISTS (...)
-- subqueries rather than joins so the policies stay composable and Postgres
-- can plan them efficiently with the projects_user_idx above.
create policy "researches: select via project"
  on public.researches for select
  to authenticated
  using (exists (
    select 1 from public.projects p
    where p.id = researches.project_id
      and p.clerk_user_id = auth.jwt() ->> 'sub'
  ));

create policy "researches: insert via project"
  on public.researches for insert
  to authenticated
  with check (exists (
    select 1 from public.projects p
    where p.id = researches.project_id
      and p.clerk_user_id = auth.jwt() ->> 'sub'
  ));

create policy "researches: update via project"
  on public.researches for update
  to authenticated
  using (exists (
    select 1 from public.projects p
    where p.id = researches.project_id
      and p.clerk_user_id = auth.jwt() ->> 'sub'
  ))
  with check (exists (
    select 1 from public.projects p
    where p.id = researches.project_id
      and p.clerk_user_id = auth.jwt() ->> 'sub'
  ));

create policy "researches: delete via project"
  on public.researches for delete
  to authenticated
  using (exists (
    select 1 from public.projects p
    where p.id = researches.project_id
      and p.clerk_user_id = auth.jwt() ->> 'sub'
  ));

-- -----------------------------------------------------------------------------
-- sources
-- -----------------------------------------------------------------------------
-- meta:        pipeline-specific extras (Tavily raw_url + title for url, mammoth
--              html for doc, original filename for pdf/doc, etc.)
-- snippet:     short markdown excerpt used as the SourceCard preview text
-- context_doc: structured ContextDoc returned by Gemini Flash
--              ({ oneSentenceSummary, keyClaims, factsTable, gaps, words, ... })
create table public.sources (
  id           uuid         primary key default gen_random_uuid(),
  research_id  uuid         not null references public.researches(id) on delete cascade,
  kind         text         not null check (kind in ('pdf', 'url', 'doc', 'md')),
  title        text         not null,
  meta         jsonb        not null default '{}'::jsonb,
  snippet      text,
  context_doc  jsonb,
  created_at   timestamptz  not null default now(),
  updated_at   timestamptz  not null default now()
);

create index sources_research_idx on public.sources(research_id, created_at desc);

alter table public.sources enable row level security;

create policy "sources: select via research"
  on public.sources for select
  to authenticated
  using (exists (
    select 1 from public.researches r
    join public.projects p on p.id = r.project_id
    where r.id = sources.research_id
      and p.clerk_user_id = auth.jwt() ->> 'sub'
  ));

create policy "sources: insert via research"
  on public.sources for insert
  to authenticated
  with check (exists (
    select 1 from public.researches r
    join public.projects p on p.id = r.project_id
    where r.id = sources.research_id
      and p.clerk_user_id = auth.jwt() ->> 'sub'
  ));

create policy "sources: update via research"
  on public.sources for update
  to authenticated
  using (exists (
    select 1 from public.researches r
    join public.projects p on p.id = r.project_id
    where r.id = sources.research_id
      and p.clerk_user_id = auth.jwt() ->> 'sub'
  ))
  with check (exists (
    select 1 from public.researches r
    join public.projects p on p.id = r.project_id
    where r.id = sources.research_id
      and p.clerk_user_id = auth.jwt() ->> 'sub'
  ));

create policy "sources: delete via research"
  on public.sources for delete
  to authenticated
  using (exists (
    select 1 from public.researches r
    join public.projects p on p.id = r.project_id
    where r.id = sources.research_id
      and p.clerk_user_id = auth.jwt() ->> 'sub'
  ));

create trigger tg_sources_updated_at
  before update on public.sources
  for each row execute function public.tg_set_updated_at();

-- -----------------------------------------------------------------------------
-- messages
-- -----------------------------------------------------------------------------
-- council_role + council_seat record which Council member produced an
-- agent message, so the anonymised "Reviewer A/B/C/D" + "Chair" bubbles
-- can replay correctly on refresh. run_id ties the message to a specific
-- research run for filtering (e.g. show only the latest deliberation).
create table public.messages (
  id            uuid         primary key default gen_random_uuid(),
  research_id   uuid         not null references public.researches(id) on delete cascade,
  role          text         not null check (role in ('user', 'agent')),
  body          text         not null,
  council_role  text         check (council_role in ('reviewer', 'chair')),
  council_seat  int          check (council_seat between 1 and 4),
  run_id        uuid,
  created_at    timestamptz  not null default now(),
  updated_at    timestamptz  not null default now()
);

create index messages_research_idx on public.messages(research_id, created_at);
create index messages_run_idx on public.messages(run_id) where run_id is not null;

alter table public.messages enable row level security;

create policy "messages: select via research"
  on public.messages for select
  to authenticated
  using (exists (
    select 1 from public.researches r
    join public.projects p on p.id = r.project_id
    where r.id = messages.research_id
      and p.clerk_user_id = auth.jwt() ->> 'sub'
  ));

create policy "messages: insert via research"
  on public.messages for insert
  to authenticated
  with check (exists (
    select 1 from public.researches r
    join public.projects p on p.id = r.project_id
    where r.id = messages.research_id
      and p.clerk_user_id = auth.jwt() ->> 'sub'
  ));

create policy "messages: update via research"
  on public.messages for update
  to authenticated
  using (exists (
    select 1 from public.researches r
    join public.projects p on p.id = r.project_id
    where r.id = messages.research_id
      and p.clerk_user_id = auth.jwt() ->> 'sub'
  ))
  with check (exists (
    select 1 from public.researches r
    join public.projects p on p.id = r.project_id
    where r.id = messages.research_id
      and p.clerk_user_id = auth.jwt() ->> 'sub'
  ));

create policy "messages: delete via research"
  on public.messages for delete
  to authenticated
  using (exists (
    select 1 from public.researches r
    join public.projects p on p.id = r.project_id
    where r.id = messages.research_id
      and p.clerk_user_id = auth.jwt() ->> 'sub'
  ));

create trigger tg_messages_updated_at
  before update on public.messages
  for each row execute function public.tg_set_updated_at();

-- -----------------------------------------------------------------------------
-- runs
-- -----------------------------------------------------------------------------
-- Each "do research" command produces one row. The current portfolio for
-- the prompts column is the latest run's prompts JSONB. total_channels and
-- peec_skipped power the dynamic HitsBar and the Peec-key-missing banner.
create table public.runs (
  id              uuid         primary key default gen_random_uuid(),
  research_id     uuid         not null references public.researches(id) on delete cascade,
  status          text         not null default 'pending' check (status in ('pending', 'running', 'complete', 'failed')),
  council_depth   text         not null check (council_depth in ('quick', 'standard')),
  prompts         jsonb        not null default '[]'::jsonb,
  total_channels  int          not null default 0,
  peec_skipped    boolean      not null default false,
  started_at      timestamptz  not null default now(),
  finished_at     timestamptz
);

create index runs_research_idx on public.runs(research_id, started_at desc);

alter table public.runs enable row level security;

create policy "runs: select via research"
  on public.runs for select
  to authenticated
  using (exists (
    select 1 from public.researches r
    join public.projects p on p.id = r.project_id
    where r.id = runs.research_id
      and p.clerk_user_id = auth.jwt() ->> 'sub'
  ));

create policy "runs: insert via research"
  on public.runs for insert
  to authenticated
  with check (exists (
    select 1 from public.researches r
    join public.projects p on p.id = r.project_id
    where r.id = runs.research_id
      and p.clerk_user_id = auth.jwt() ->> 'sub'
  ));

create policy "runs: update via research"
  on public.runs for update
  to authenticated
  using (exists (
    select 1 from public.researches r
    join public.projects p on p.id = r.project_id
    where r.id = runs.research_id
      and p.clerk_user_id = auth.jwt() ->> 'sub'
  ))
  with check (exists (
    select 1 from public.researches r
    join public.projects p on p.id = r.project_id
    where r.id = runs.research_id
      and p.clerk_user_id = auth.jwt() ->> 'sub'
  ));

-- -----------------------------------------------------------------------------
-- Realtime publication
-- -----------------------------------------------------------------------------
-- Supabase Realtime works by tailing the `supabase_realtime` publication.
-- We add only the tables the UI subscribes to: sources (analyzing pulse),
-- messages (chat transcript), runs (research progress).
alter publication supabase_realtime add table public.sources;
alter publication supabase_realtime add table public.messages;
alter publication supabase_realtime add table public.runs;
