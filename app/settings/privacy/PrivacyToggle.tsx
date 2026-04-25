'use client';

import { useState } from 'react';
import posthog from 'posthog-js';

interface PrivacyToggleProps {
  initial: boolean;
}

/**
 * Single switch backing `user_profiles.posthog_capture_llm`. Server-side
 * LLM wrappers (Session 3+) read this flag per request and pass
 * `posthogPrivacyMode: !value` into @posthog/ai's wrappers — when off,
 * PostHog still gets timings + token counts + cost (so cost dashboards
 * keep working) but not prompt or response bodies.
 *
 * We mirror the value to the PostHog person profile too, so it shows up on
 * the user's profile page and can be filtered on in cohorts.
 */
export function PrivacyToggle({ initial }: PrivacyToggleProps) {
  const [value, setValue] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'fail'; text: string } | null>(null);

  const handleToggle = async (next: boolean) => {
    const previous = value;
    setValue(next);
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch('/api/privacy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ posthogCaptureLlm: next }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Save failed (${res.status})`);
      }
      try {
        posthog.setPersonProperties({ posthog_capture_llm: next });
      } catch {
        // Don't let an analytics hiccup undo a successful DB write.
      }
      setMessage({ kind: 'ok', text: next ? 'Bodies will be captured.' : 'Bodies will NOT be captured.' });
    } catch (err) {
      setValue(previous);
      setMessage({ kind: 'fail', text: err instanceof Error ? err.message : 'Save failed.' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-[14px] border border-[var(--line)] bg-[var(--surface-1)] px-5 py-4 flex flex-col gap-3">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <h2 className="font-[Inter] text-[15px] font-semibold text-[var(--ink)]">
            Send LLM prompt + response bodies to PostHog
          </h2>
          <p className="text-[12.5px] text-[var(--ink-2)] mt-1.5 leading-relaxed">
            We always capture token counts, cost, and latency so you can see
            how much each run costs. With this on, we also capture the prompt
            + response bodies, which may include derived brand/source
            summaries, so we can debug Council disagreements and improve
            prompts. We <span className="font-semibold text-[var(--ink)]">never</span> capture
            decrypted API keys, raw uploaded files, your email, or your name.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={value}
          disabled={saving}
          onClick={() => handleToggle(!value)}
          className={
            'relative shrink-0 w-11 h-6 rounded-full transition-colors disabled:opacity-50 ' +
            (value ? 'bg-[var(--accent)]' : 'bg-[var(--surface-3)]')
          }
        >
          <span
            className={
              'absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ' +
              (value ? 'translate-x-5' : 'translate-x-0')
            }
          />
        </button>
      </div>
      {message && (
        <p
          className={
            'text-[12.5px] ' + (message.kind === 'ok' ? 'text-emerald-500' : 'text-red-500')
          }
        >
          {message.text}
        </p>
      )}
    </div>
  );
}
