-- Allow 'openai' as a BYOK provider in user_api_keys.
-- Used as the primary model for the Ideate stage (GPT-5.4), with Gemini Pro
-- as the fallback. Direct OpenAI integration (platform.openai.com), not
-- routed through OpenRouter, so users can use their existing OpenAI billing
-- and dashboard.

alter table public.user_api_keys
  drop constraint if exists user_api_keys_provider_check;

alter table public.user_api_keys
  add constraint user_api_keys_provider_check
  check (provider in ('gemini', 'openrouter', 'tavily', 'peec', 'openai'));
