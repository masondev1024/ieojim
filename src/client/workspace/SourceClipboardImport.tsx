import { useEffect, useRef, useState } from 'react';
import { ClipboardPaste, X } from 'lucide-react';
import {
  beginClipboardRead,
  failClipboardRead,
  initialClipboardImportState,
  receiveClipboardText,
  requestClipboardImport,
  resetClipboardImport,
  type ClipboardImportState,
} from './source-clipboard-import';
import './source-clipboard-import.css';

type SourceClipboardImportProps = {
  disabled: boolean;
  maxLength: number;
  hasDraft: boolean;
  onImport: (text: string) => void;
  scopeKey: string;
  draftVersion?: string;
};

export default function SourceClipboardImport({
  disabled,
  maxLength,
  hasDraft,
  onImport,
  scopeKey,
  draftVersion = hasDraft ? 'draft' : '',
}: SourceClipboardImportProps) {
  const [state, setState] = useState<ClipboardImportState>(() => initialClipboardImportState());
  const latestRef = useRef({ scopeKey, disabled, draftVersion });
  const requestSequenceRef = useRef(0);
  latestRef.current = { scopeKey, disabled, draftVersion };

  useEffect(() => {
    setState((current) => resetClipboardImport(current));
  }, [scopeKey, disabled]);

  async function readClipboard() {
    if (disabled) return;
    const requestedScopeKey = scopeKey;
    const requestId = requestSequenceRef.current + 1;
    requestSequenceRef.current = requestId;
    const next = { ...beginClipboardRead(state, requestedScopeKey), requestId };
    setState(next);
    try {
      if (!navigator.clipboard?.readText) throw new Error('clipboard_unavailable');
      const text = await navigator.clipboard.readText();
      setState((current) => receiveClipboardText(current, {
        requestId: next.requestId,
        requestedScopeKey,
        currentScopeKey: latestRef.current.scopeKey,
        disabled: latestRef.current.disabled,
        text,
        maxLength,
        draftVersion: latestRef.current.draftVersion,
      }).state);
    } catch {
      setState((current) => failClipboardRead(current, {
        requestId: next.requestId,
        requestedScopeKey,
        currentScopeKey: latestRef.current.scopeKey,
        disabled: latestRef.current.disabled,
      }).state);
    }
  }

  function importPreview() {
    const result = requestClipboardImport(state, {
      scopeKey,
      draftVersion,
      hasDraft,
      disabled,
      maxLength,
    });
    setState(result.state);
    if (result.action === 'import') onImport(result.text);
  }

  const hasPreview = state.previewText.length > 0;
  const canImport = hasPreview && state.previewText.length <= maxLength && !disabled && state.status !== 'reading';
  const messageIsAlert = state.status === 'error' || state.status === 'manual';

  return (
    <section className="source-clipboard-import" aria-label="클립보드 원문 가져오기">
      <div className="source-clipboard-import__actions">
        <button type="button" className="ghost-button" onClick={() => void readClipboard()} disabled={disabled || state.status === 'reading'}>
          <ClipboardPaste size={16} aria-hidden="true" />
          {state.status === 'reading' ? '클립보드 확인 중' : '클립보드에서 원문 읽기'}
        </button>
        {hasPreview ? (
          <button type="button" className="ghost-button" onClick={() => setState((current) => resetClipboardImport(current))} disabled={disabled}>
            <X size={16} aria-hidden="true" />
            미리보기 닫기
          </button>
        ) : null}
      </div>
      {hasPreview ? (
        <div className="source-clipboard-import__preview">
          <textarea
            readOnly
            rows={Math.min(8, Math.max(4, state.previewText.split('\n').length))}
            value={state.previewText}
            aria-label="클립보드에서 읽은 원문 미리보기"
          />
          <button type="button" className="primary-action" onClick={importPreview} disabled={!canImport}>
            {state.status === 'confirm_replace' ? '작성 중인 원문을 바꾸기' : '이 내용 가져오기'}
          </button>
        </div>
      ) : null}
      {state.message ? (
        <p className={messageIsAlert ? 'form-error' : 'muted'} role={messageIsAlert ? 'alert' : 'status'}>{state.message}</p>
      ) : null}
    </section>
  );
}

export type { SourceClipboardImportProps };
