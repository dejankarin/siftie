import { useEffect, useState, type FormEvent } from 'react';
import type { Source } from '../types';

type NewSourcePayload = Omit<Source, 'id'>;
type AddTab = 'upload' | 'url' | 'text' | 'db';

interface AddSourceModalProps {
  open: boolean;
  initialTab?: AddTab;
  onClose: () => void;
  onAdd: (payload: NewSourcePayload) => void;
}

export function AddSourceModal({ open, initialTab = 'upload', onClose, onAdd }: AddSourceModalProps) {
  const [tab, setTab] = useState<AddTab>(initialTab);
  const [url, setUrl] = useState('');
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [dropping, setDropping] = useState(false);

  useEffect(() => {
    if (open) {
      setTab(initialTab);
    } else {
      setUrl('');
      setText('');
      setQuery('');
    }
  }, [open, initialTab]);

  if (!open) return null;

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    let payload: NewSourcePayload | null = null;
    if (tab === 'upload')
      payload = {
        type: 'pdf',
        title: 'Competitor_Teardown_Q1.pdf',
        meta: '8 pages · just now',
        snippet:
          'Lululemon, Athleta, Vuori, Outdoor Voices — pricing, sustainability claims, content positioning, customer review themes.',
      };
    if (tab === 'url' && url.trim())
      payload = {
        type: 'url',
        title: url.replace(/^https?:\/\//, '').slice(0, 48),
        meta: 'Fetched · just now',
        snippet:
          'Page indexed. Headings, body copy, and meta extracted. Page contains 1,240 words across 4 sections.',
      };
    if (tab === 'text' && text.trim()) {
      const t = text.trim();
      const words = t.split(/\s+/).filter(Boolean).length;
      payload = {
        type: 'paste',
        title: 'Pasted text',
        meta: `${words} words · just now`,
        snippet: t.slice(0, 200) + (t.length > 200 ? '…' : ''),
      };
    }
    if (tab === 'db' && query.trim())
      payload = {
        type: 'db',
        title: `DB result — "${query.trim()}"`,
        meta: 'Internal database · 6 matches',
        snippet:
          'Returned 6 records from the activewear AEO benchmark. Top match: "Sustainable running brands" — 247 query variants.',
      };
    if (payload) {
      onAdd(payload);
      onClose();
    }
  };

  const tabs: { id: AddTab; label: string }[] = [
    { id: 'upload', label: 'Upload' },
    { id: 'url', label: 'URL' },
    { id: 'text', label: 'Paste text' },
    { id: 'db', label: 'Database' },
  ];

  const canSubmit =
    tab === 'upload' || (tab === 'url' && url.trim()) || (tab === 'text' && text.trim()) || (tab === 'db' && query.trim());

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[var(--overlay)] backdrop-blur-[2px]"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="w-full max-w-[520px] bg-[var(--surface)] rounded-2xl border border-[var(--line)] shadow-[var(--shadow-pop)] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-source-title"
      >
        <div className="flex items-center justify-between px-5 pt-4 pb-3 border-b border-[var(--line-2)]">
          <div>
            <h3 id="add-source-title" className="text-[15px] font-semibold text-[var(--ink)]">
              Add a source
            </h3>
            <p className="text-[12px] text-[var(--ink-3)] mt-0.5">The agent will index it and reference it in the chat.</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="btn-ghost px-2 py-1 text-[11.5px] text-[var(--ink-3)] hover:text-[var(--ink)]"
          >
            Close
          </button>
        </div>
        <div className="flex gap-1 px-3 pt-3 border-b border-[var(--line-2)]">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`px-3 py-2 text-[12.5px] font-medium rounded-t-md border-b-2 transition
                ${
                  tab === t.id
                    ? 'border-[var(--ink)] text-[var(--ink)]'
                    : 'border-transparent text-[var(--ink-3)] hover:text-[var(--ink-2)]'
                }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="p-5">
          {tab === 'upload' && (
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDropping(true);
              }}
              onDragLeave={() => setDropping(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDropping(false);
              }}
              className={`rounded-xl border-2 border-dashed py-10 text-center transition
                ${
                  dropping
                    ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
                    : 'border-[var(--line)] bg-[var(--surface-2)]'
                }`}
            >
              <p className="text-[13.5px] font-medium text-[var(--ink)]">Drop a file, or click to browse</p>
              <p className="text-[11.5px] text-[var(--ink-3)] mt-1">PDF, DOCX, TXT, MD — up to 50 MB</p>
            </div>
          )}
          {tab === 'url' && (
            <div>
              <label className="text-[11.5px] uppercase tracking-wider text-[var(--ink-3)] font-medium">URL</label>
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://competitor.com/about"
                className="mt-1 w-full rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3 py-2.5 text-[14px] focus-ring text-[var(--ink)] placeholder:text-[var(--ink-3)]"
              />
              <p className="text-[11.5px] text-[var(--ink-3)] mt-2">Paste a competitor page, review article, or your own brand site.</p>
            </div>
          )}
          {tab === 'text' && (
            <div>
              <label className="text-[11.5px] uppercase tracking-wider text-[var(--ink-3)] font-medium">Text</label>
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={6}
                placeholder="Paste a customer interview transcript, brand brief, or notes…"
                className="mt-1 w-full rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3 py-2.5 text-[14px] leading-[1.55] focus-ring text-[var(--ink)] placeholder:text-[var(--ink-3)] resize-none"
              />
            </div>
          )}
          {tab === 'db' && (
            <div>
              <label className="text-[11.5px] uppercase tracking-wider text-[var(--ink-3)] font-medium">Search internal database</label>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="e.g. sustainable activewear, recycled textiles, DTC pricing"
                className="mt-1 w-full rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3 py-2.5 text-[14px] focus-ring text-[var(--ink)] placeholder:text-[var(--ink-3)]"
              />
              <div className="mt-3 space-y-1.5">
                {['Activewear AEO benchmark', 'Sustainability claim audit', 'DTC challenger pricing'].map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setQuery(s)}
                    className="w-full text-left px-3 py-2 rounded-lg hover:bg-[var(--surface-2)] text-[12.5px] text-[var(--ink-2)]"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="px-5 pb-5 pt-1 flex items-center justify-end gap-2">
          <button type="button" onClick={onClose} className="btn-ghost px-3 py-2 text-[13px] text-[var(--ink-2)]">
            Cancel
          </button>
          <button
            type="button"
            onClick={() => submit()}
            disabled={!canSubmit}
            className={`px-3.5 py-2 rounded-xl text-[13px] font-medium transition
              ${
                canSubmit
                  ? 'bg-[var(--btn-primary-bg)] text-[var(--btn-primary-fg)] hover:bg-[var(--btn-primary-hover)]'
                  : 'bg-[var(--btn-disabled-bg)] text-[var(--btn-disabled-fg)] cursor-not-allowed'
              }`}
          >
            Add source
          </button>
        </div>
      </div>
    </div>
  );
}

export type { AddTab };
