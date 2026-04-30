import { useEffect, useState } from 'react';
import { useBodyScrollLock } from '../hooks/useBodyScrollLock';
import type { Source } from '../types';

interface EditSourceModalProps {
  source: Source | null;
  onClose: () => void;
  onSave: (next: Source) => void;
}

export function EditSourceModal({ source, onClose, onSave }: EditSourceModalProps) {
  const [title, setTitle] = useState('');
  const [meta, setMeta] = useState('');
  const [snippet, setSnippet] = useState('');

  useBodyScrollLock(source !== null);

  useEffect(() => {
    if (source) {
      setTitle(source.title);
      setMeta(source.meta);
      setSnippet(source.snippet);
    }
  }, [source]);

  if (!source) return null;

  const dirty = title !== source.title || meta !== source.meta || snippet !== source.snippet;

  const save = () => {
    if (!title.trim()) return;
    onSave({ ...source, title: title.trim(), meta: meta.trim(), snippet: snippet.trim() });
    onClose();
  };

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
        aria-labelledby="edit-source-title"
      >
        <div className="flex items-center justify-between px-5 pt-4 pb-3 border-b border-[var(--line-2)]">
          <div>
            <h3 id="edit-source-title" className="text-[15px] font-semibold text-[var(--ink)]">
              Edit source
            </h3>
            <p className="text-[12px] text-[var(--ink-3)] mt-0.5">Update the title, meta, or summary indexed by the agent.</p>
          </div>
          <button type="button" onClick={onClose} className="btn-ghost px-2 py-1 text-[11.5px] text-[var(--ink-3)] hover:text-[var(--ink)]">
            Close
          </button>
        </div>
        <div className="p-5 space-y-3">
          <div>
            <label className="text-[11.5px] uppercase tracking-wider text-[var(--ink-3)] font-medium">Title</label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="mt-1 w-full rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3 py-2.5 text-[14px] focus-ring text-[var(--ink)] placeholder:text-[var(--ink-3)]"
            />
          </div>
          <div>
            <label className="text-[11.5px] uppercase tracking-wider text-[var(--ink-3)] font-medium">Meta</label>
            <input
              value={meta}
              onChange={(e) => setMeta(e.target.value)}
              placeholder="e.g. 14 pages · uploaded 2 min ago"
              className="mt-1 w-full rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3 py-2.5 text-[14px] focus-ring text-[var(--ink)] placeholder:text-[var(--ink-3)]"
            />
          </div>
          <div>
            <label className="text-[11.5px] uppercase tracking-wider text-[var(--ink-3)] font-medium">Summary</label>
            <textarea
              value={snippet}
              onChange={(e) => setSnippet(e.target.value)}
              rows={5}
              className="mt-1 w-full rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3 py-2.5 text-[14px] leading-[1.55] focus-ring text-[var(--ink)] placeholder:text-[var(--ink-3)] resize-none"
            />
          </div>
        </div>
        <div className="px-5 pb-5 pt-1 flex items-center justify-end gap-2">
          <button type="button" onClick={onClose} className="btn-ghost px-3 py-2 text-[13px] text-[var(--ink-2)]">
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={!dirty || !title.trim()}
            className={`px-3.5 py-2 rounded-xl text-[13px] font-medium transition
              ${
                dirty && title.trim()
                  ? 'bg-[var(--btn-primary-bg)] text-[var(--btn-primary-fg)] hover:bg-[var(--btn-primary-hover)]'
                  : 'bg-[var(--btn-disabled-bg)] text-[var(--btn-disabled-fg)] cursor-not-allowed'
              }`}
          >
            Save changes
          </button>
        </div>
      </div>
    </div>
  );
}
