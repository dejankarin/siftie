'use client';

import { useCallback, useState } from 'react';
import posthog from 'posthog-js';
import type { KeyStatus, Provider } from '@/lib/keys';

/**
 * Per-provider display config kept beside the form because (a) it's the only
 * place that needs it and (b) keeping it out of `lib/keys.ts` lets the
 * server-side helpers stay UI-agnostic.
 *
 * `helpUrl` is where the user clicks to get/copy a key; we surface it as a
 * small link beneath the input so the flow is self-serve.
 */
const PROVIDER_META: Record<Provider, {
  label: string;
  required: boolean;
  caption: string;
  helpUrl: string;
  helpText: string;
}> = {
  openai: {
    label: 'OpenAI (GPT-5.4)',
    required: true,
    caption:
      'Primary for Ideate · Fallback for source ingestion when Gemini is unavailable. Direct from platform.openai.com.',
    helpUrl: 'https://platform.openai.com/api-keys',
    helpText: 'Get a key from OpenAI Platform',
  },
  gemini: {
    label: 'Google Gemini',
    required: true,
    caption:
      'Primary for source ingestion (Flash) · Fallback for Ideate (Pro) when OpenAI is unavailable.',
    helpUrl: 'https://aistudio.google.com/apikey',
    helpText: 'Get a key from Google AI Studio',
  },
  openrouter: {
    label: 'OpenRouter',
    required: true,
    caption: 'Routes Council seats to GPT-5.4 Mini, Gemini 2.5 Flash, and Claude Haiku 4.5.',
    helpUrl: 'https://openrouter.ai/keys',
    helpText: 'Get a key from OpenRouter',
  },
  tavily: {
    label: 'Tavily',
    required: true,
    caption: 'Crawls URLs into clean Markdown for the source library.',
    helpUrl: 'https://app.tavily.com/home',
    helpText: 'Get a key from Tavily',
  },
  peec: {
    label: 'Peec',
    required: false,
    caption: 'Enterprise — adds live brand-mention data per prompt. Optional.',
    helpUrl: 'https://app.peec.ai',
    helpText: 'Get a key from Peec',
  },
};

const ORDER: Provider[] = ['openai', 'gemini', 'openrouter', 'tavily', 'peec'];

interface ApiKeysFormProps {
  initialStatus: KeyStatus[];
  onboarding: boolean;
}

interface RowState {
  hasKey: boolean;
  lastTestStatus: 'ok' | 'fail' | null;
  // Local input value: undefined means "show ••• placeholder for an existing
  // saved key, no edit happening". A string (incl. empty) means "user is
  // typing a new value".
  draft: string | undefined;
  saving: boolean;
  testing: boolean;
  message: { kind: 'ok' | 'fail' | 'info'; text: string } | null;
}

export function ApiKeysForm({ initialStatus, onboarding }: ApiKeysFormProps) {
  const [rows, setRows] = useState<Record<Provider, RowState>>(() => {
    const out = {} as Record<Provider, RowState>;
    for (const s of initialStatus) {
      out[s.provider] = {
        hasKey: s.hasKey,
        lastTestStatus: s.lastTestStatus,
        draft: undefined,
        saving: false,
        testing: false,
        message: null,
      };
    }
    return out;
  });

  const updateRow = useCallback((provider: Provider, patch: Partial<RowState>) => {
    setRows((prev) => ({ ...prev, [provider]: { ...prev[provider], ...patch } }));
  }, []);

  const handleEdit = (provider: Provider) => {
    updateRow(provider, { draft: '', message: null });
  };

  const handleCancel = (provider: Provider) => {
    updateRow(provider, { draft: undefined, message: null });
  };

  const handleSave = async (provider: Provider) => {
    const draft = rows[provider].draft?.trim() ?? '';
    if (!draft) {
      updateRow(provider, { message: { kind: 'fail', text: 'Paste a key first.' } });
      return;
    }
    updateRow(provider, { saving: true, message: null });
    try {
      const res = await fetch('/api/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, key: draft }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Save failed (${res.status})`);
      }
      // Sync the PostHog person profile so analytics reflect the new state.
      try {
        const newCount =
          Object.values(rows).filter((r) => r.hasKey).length + (rows[provider].hasKey ? 0 : 1);
        posthog.setPersonProperties({
          [`has_${provider}_key`]: true,
          keys_count: newCount,
        });
        posthog.capture('key_added', { provider });
      } catch {
        // PostHog might not be initialised in some edge environments — never
        // let analytics block a successful save.
      }
      updateRow(provider, {
        hasKey: true,
        draft: undefined,
        saving: false,
        lastTestStatus: null,
        message: { kind: 'ok', text: 'Saved. Hit Test to verify.' },
      });
    } catch (err) {
      updateRow(provider, {
        saving: false,
        message: { kind: 'fail', text: err instanceof Error ? err.message : 'Save failed.' },
      });
    }
  };

  const handleTest = async (provider: Provider) => {
    updateRow(provider, { testing: true, message: null });
    try {
      const res = await fetch(`/api/keys/test/${provider}`, { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.ok) {
        updateRow(provider, {
          testing: false,
          lastTestStatus: 'ok',
          message: { kind: 'ok', text: body.message || 'Key works.' },
        });
      } else {
        updateRow(provider, {
          testing: false,
          lastTestStatus: 'fail',
          message: { kind: 'fail', text: body.message || `Test failed (${res.status})` },
        });
      }
    } catch (err) {
      updateRow(provider, {
        testing: false,
        lastTestStatus: 'fail',
        message: { kind: 'fail', text: err instanceof Error ? err.message : 'Test failed.' },
      });
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="font-[Inter] text-[24px] font-semibold tracking-tight">
          {onboarding ? 'Welcome to Siftie. Add your provider keys to get started.' : 'API Keys'}
        </h1>
        <p className="text-[14px] text-[var(--ink-2)] mt-1.5 leading-relaxed">
          Bring your own provider keys. Siftie stores every key encrypted and
          only decrypts it on the server when a request needs it.
        </p>
      </header>

      <ol className="flex flex-col gap-3">
        {ORDER.map((provider) => (
          <KeyRow
            key={provider}
            provider={provider}
            row={rows[provider]}
            onEdit={() => handleEdit(provider)}
            onCancel={() => handleCancel(provider)}
            onSave={() => handleSave(provider)}
            onTest={() => handleTest(provider)}
            onDraftChange={(v) => updateRow(provider, { draft: v })}
          />
        ))}
      </ol>
    </div>
  );
}

interface KeyRowProps {
  provider: Provider;
  row: RowState;
  onEdit: () => void;
  onCancel: () => void;
  onSave: () => void;
  onTest: () => void;
  onDraftChange: (v: string) => void;
}

function KeyRow({ provider, row, onEdit, onCancel, onSave, onTest, onDraftChange }: KeyRowProps) {
  const meta = PROVIDER_META[provider];
  const editing = row.draft !== undefined;

  return (
    <li className="rounded-[14px] border border-[var(--line)] bg-[var(--surface-1)] px-5 py-4">
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <h2 className="font-[Inter] text-[15px] font-semibold text-[var(--ink)]">{meta.label}</h2>
          {meta.required ? (
            <span className="text-[10.5px] uppercase tracking-wide text-[var(--ink-3)]">Required</span>
          ) : (
            <span className="text-[10.5px] uppercase tracking-wide text-[var(--ink-3)]">Optional</span>
          )}
          <StatusDot row={row} />
        </div>
        <a
          href={meta.helpUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[12px] text-[var(--ink-2)] hover:text-[var(--ink)] underline-offset-4 hover:underline"
        >
          {meta.helpText} →
        </a>
      </div>
      <p className="text-[12.5px] text-[var(--ink-2)] mt-1">{meta.caption}</p>

      <div className="mt-3 flex items-center gap-2">
        {editing ? (
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            className="flex-1 min-w-0 px-3 py-2 rounded-[10px] border border-[var(--line)] bg-[var(--bg)] text-[13.5px] font-mono text-[var(--ink)] focus:outline-none focus:border-[var(--accent)]"
            placeholder={`Paste your ${meta.label} API key`}
            value={row.draft}
            onChange={(e) => onDraftChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onSave();
              if (e.key === 'Escape' && row.hasKey) onCancel();
            }}
            autoFocus
          />
        ) : (
          <div className="flex-1 min-w-0 px-3 py-2 rounded-[10px] border border-[var(--line)] bg-[var(--surface-2)] text-[13.5px] font-mono text-[var(--ink-3)] select-none">
            {row.hasKey ? '••••••••••••••••••••••••' : 'No key saved yet'}
          </div>
        )}

        <div className="flex items-center gap-1.5">
          {editing ? (
            <>
              <button
                type="button"
                disabled={row.saving}
                onClick={onSave}
                className="px-3 py-2 rounded-[10px] bg-[var(--accent)] text-white text-[13px] font-semibold disabled:opacity-50"
              >
                {row.saving ? 'Saving…' : 'Save'}
              </button>
              {row.hasKey && (
                <button
                  type="button"
                  disabled={row.saving}
                  onClick={onCancel}
                  className="px-3 py-2 rounded-[10px] border border-[var(--line)] text-[13px] text-[var(--ink-2)]"
                >
                  Cancel
                </button>
              )}
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={onEdit}
                className="px-3 py-2 rounded-[10px] border border-[var(--line)] text-[13px] text-[var(--ink)] hover:bg-[var(--surface-2)]"
              >
                {row.hasKey ? 'Edit' : 'Add key'}
              </button>
              {row.hasKey && (
                <button
                  type="button"
                  onClick={onTest}
                  disabled={row.testing}
                  className="px-3 py-2 rounded-[10px] border border-[var(--line)] text-[13px] text-[var(--ink-2)] hover:text-[var(--ink)] disabled:opacity-50"
                >
                  {row.testing ? 'Testing…' : 'Test'}
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {row.message && (
        <p
          className={
            'mt-2 text-[12.5px] ' +
            (row.message.kind === 'ok'
              ? 'text-emerald-500'
              : row.message.kind === 'fail'
                ? 'text-red-500'
                : 'text-[var(--ink-2)]')
          }
        >
          {row.message.text}
        </p>
      )}
    </li>
  );
}

function StatusDot({ row }: { row: RowState }) {
  if (!row.hasKey) return null;
  if (row.lastTestStatus === 'ok')
    return <span className="text-[11px] text-emerald-500" title="Last test OK">● tested</span>;
  if (row.lastTestStatus === 'fail')
    return <span className="text-[11px] text-red-500" title="Last test failed">● failing</span>;
  return <span className="text-[11px] text-[var(--ink-3)]" title="Saved, not yet tested">● untested</span>;
}
