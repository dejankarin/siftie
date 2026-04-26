-- Session 7 — persist Peec channel descriptions per run so the dynamic
-- HitsBar can show one cell per channel with the channel name on hover
-- (e.g. "OpenAI gpt-5", "Perplexity sonar-pro"). Without this, the
-- client only has a numeric `total_channels` and would have to refetch
-- channel metadata from Peec on every render.
--
-- Stored as a JSONB array of `{ id: text, description: text }` so the
-- shape stays forward-compatible if Peec adds extra columns. Empty
-- array is the natural default for runs that pre-date Session 7 or
-- where Peec was skipped.
alter table public.runs
  add column if not exists channels jsonb not null default '[]'::jsonb;
