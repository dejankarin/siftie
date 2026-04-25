import { useEffect, useRef, useState, type ChangeEvent, type DragEvent, type FormEvent } from 'react';
import type { AddSourcePayload } from '../hooks/useWorkspace';

type AddTab = 'pdf' | 'url' | 'doc' | 'md';

interface AddSourceModalProps {
  open: boolean;
  initialTab?: AddTab;
  onClose: () => void;
  /**
   * Returns the persisted source on success or throws on failure. The
   * modal awaits this so it can show its own "submitting" state and
   * keep the dialog open if the user needs to correct something.
   */
  onAdd: (payload: AddSourcePayload) => Promise<unknown>;
}

export function AddSourceModal({ open, initialTab = 'pdf', onClose, onAdd }: AddSourceModalProps) {
  const [tab, setTab] = useState<AddTab>(initialTab);
  const [url, setUrl] = useState('');
  const [text, setText] = useState('');
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [docFile, setDocFile] = useState<File | null>(null);
  const [dropping, setDropping] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pdfInputRef = useRef<HTMLInputElement>(null);
  const docInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setTab(initialTab);
      setError(null);
    } else {
      // Clear all inputs when the dialog closes so we don't leak the
      // user's last attempt into the next session.
      setUrl('');
      setText('');
      setPdfFile(null);
      setDocFile(null);
      setSubmitting(false);
      setError(null);
    }
  }, [open, initialTab]);

  if (!open) return null;

  const onPdfPick = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) {
      setPdfFile(f);
      setError(null);
    }
  };
  const onDocPick = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) {
      setDocFile(f);
      setError(null);
    }
  };

  const onPdfDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDropping(false);
    const f = e.dataTransfer.files?.[0];
    if (f) {
      if (f.type !== 'application/pdf' && !f.name.toLowerCase().endsWith('.pdf')) {
        setError('Please drop a PDF file.');
        return;
      }
      setPdfFile(f);
      setError(null);
    }
  };
  const onDocDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDropping(false);
    const f = e.dataTransfer.files?.[0];
    if (f) {
      const lower = f.name.toLowerCase();
      if (!lower.endsWith('.doc') && !lower.endsWith('.docx')) {
        setError('Please drop a .doc or .docx file.');
        return;
      }
      setDocFile(f);
      setError(null);
    }
  };

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (submitting) return;

    let payload: AddSourcePayload | null = null;
    if (tab === 'pdf' && pdfFile) {
      payload = { kind: 'pdf', file: pdfFile };
    } else if (tab === 'url' && url.trim()) {
      // Defensive: prepend https:// if the user pasted a bare host.
      const trimmed = url.trim();
      const final = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
      payload = { kind: 'url', url: final };
    } else if (tab === 'doc' && docFile) {
      payload = { kind: 'doc', file: docFile };
    } else if (tab === 'md' && text.trim()) {
      payload = { kind: 'md', text: text.trim() };
    }
    if (!payload) return;

    setSubmitting(true);
    setError(null);
    try {
      await onAdd(payload);
      onClose();
    } catch (err) {
      // Surface server-mapped error codes verbatim — they're already
      // user-friendly enough for v1 (e.g. "Missing gemini API key").
      const msg = err instanceof Error ? err.message : 'Could not add source.';
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  const tabs: { id: AddTab; label: string }[] = [
    { id: 'pdf', label: 'PDF' },
    { id: 'url', label: 'URL' },
    { id: 'doc', label: 'Word doc' },
    { id: 'md', label: '.md' },
  ];

  const canSubmit =
    !submitting &&
    ((tab === 'pdf' && !!pdfFile) ||
      (tab === 'url' && url.trim().length > 0) ||
      (tab === 'doc' && !!docFile) ||
      (tab === 'md' && text.trim().length > 0));

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[var(--overlay)] backdrop-blur-[2px]"
      onClick={submitting ? undefined : onClose}
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
            <p className="text-[12px] text-[var(--ink-3)] mt-0.5">
              The agent will index it and reference it in the chat.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="btn-ghost px-2 py-1 text-[11.5px] text-[var(--ink-3)] hover:text-[var(--ink)] disabled:opacity-50"
          >
            Close
          </button>
        </div>
        <div className="flex gap-1 px-3 pt-3 border-b border-[var(--line-2)]">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => {
                setTab(t.id);
                setError(null);
              }}
              disabled={submitting}
              className={`px-3 py-2 text-[12.5px] font-medium rounded-t-md border-b-2 transition disabled:opacity-50
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
          {tab === 'pdf' && (
            <>
              <input
                ref={pdfInputRef}
                type="file"
                accept="application/pdf,.pdf"
                onChange={onPdfPick}
                className="hidden"
              />
              <div
                onClick={() => !submitting && pdfInputRef.current?.click()}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDropping(true);
                }}
                onDragLeave={() => setDropping(false)}
                onDrop={onPdfDrop}
                className={`rounded-xl border-2 border-dashed py-10 text-center transition cursor-pointer
                  ${
                    dropping
                      ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
                      : 'border-[var(--line)] bg-[var(--surface-2)]'
                  }
                  ${submitting ? 'pointer-events-none opacity-60' : ''}`}
              >
                {pdfFile ? (
                  <>
                    <p className="text-[13.5px] font-medium text-[var(--ink)] truncate px-4">
                      {pdfFile.name}
                    </p>
                    <p className="text-[11.5px] text-[var(--ink-3)] mt-1">
                      {formatBytes(pdfFile.size)} · click to change
                    </p>
                  </>
                ) : (
                  <>
                    <p className="text-[13.5px] font-medium text-[var(--ink)]">
                      Drop a PDF, or click to browse
                    </p>
                    <p className="text-[11.5px] text-[var(--ink-3)] mt-1">PDF files up to 50 MB</p>
                  </>
                )}
              </div>
            </>
          )}
          {tab === 'url' && (
            <div>
              <label className="text-[11.5px] uppercase tracking-wider text-[var(--ink-3)] font-medium">
                URL
              </label>
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                disabled={submitting}
                placeholder="https://competitor.com/about"
                className="mt-1 w-full rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3 py-2.5 text-[14px] focus-ring text-[var(--ink)] placeholder:text-[var(--ink-3)] disabled:opacity-60"
              />
              <p className="text-[11.5px] text-[var(--ink-3)] mt-2">
                Paste a competitor page, review article, or your own brand site.
              </p>
            </div>
          )}
          {tab === 'doc' && (
            <>
              <input
                ref={docInputRef}
                type="file"
                accept=".doc,.docx,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                onChange={onDocPick}
                className="hidden"
              />
              <div
                onClick={() => !submitting && docInputRef.current?.click()}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDropping(true);
                }}
                onDragLeave={() => setDropping(false)}
                onDrop={onDocDrop}
                className={`rounded-xl border-2 border-dashed py-10 text-center transition cursor-pointer
                  ${
                    dropping
                      ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
                      : 'border-[var(--line)] bg-[var(--surface-2)]'
                  }
                  ${submitting ? 'pointer-events-none opacity-60' : ''}`}
              >
                {docFile ? (
                  <>
                    <p className="text-[13.5px] font-medium text-[var(--ink)] truncate px-4">
                      {docFile.name}
                    </p>
                    <p className="text-[11.5px] text-[var(--ink-3)] mt-1">
                      {formatBytes(docFile.size)} · click to change
                    </p>
                  </>
                ) : (
                  <>
                    <p className="text-[13.5px] font-medium text-[var(--ink)]">
                      Drop a Word document, or click to browse
                    </p>
                    <p className="text-[11.5px] text-[var(--ink-3)] mt-1">
                      DOC or DOCX files up to 50 MB
                    </p>
                  </>
                )}
              </div>
            </>
          )}
          {tab === 'md' && (
            <div>
              <label className="text-[11.5px] uppercase tracking-wider text-[var(--ink-3)] font-medium">
                Markdown
              </label>
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                disabled={submitting}
                rows={6}
                placeholder="Paste markdown notes — interview transcripts, research summaries, anything text-based."
                className="mt-1 w-full rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3 py-2.5 text-[14px] leading-[1.55] focus-ring text-[var(--ink)] placeholder:text-[var(--ink-3)] resize-none disabled:opacity-60"
              />
            </div>
          )}
          {error && (
            <p className="mt-3 text-[12px] text-[var(--danger,#dc2626)]" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="px-5 pb-5 pt-1 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="btn-ghost px-3 py-2 text-[13px] text-[var(--ink-2)] disabled:opacity-50"
          >
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
            {submitting ? 'Indexing…' : 'Add source'}
          </button>
        </div>
      </div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export type { AddTab };
