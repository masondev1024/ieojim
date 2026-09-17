import { useEffect, useRef, useState } from 'react';
import { ClipboardCheck, Copy, Eye, X } from 'lucide-react';
import { buildCurrentPlanBriefText } from './current-plan-brief';
import { loadWorkspaceExport, workspaceExportFailureMessage, workspaceExportTimeoutMs } from './export-reader';
import './current-plan-brief.css';

type BriefStatus = 'idle' | 'loading' | 'ready' | 'copying' | 'copied' | 'manual' | 'error';

type CurrentPlanBriefProps = {
  workspaceId: string;
  currentRevision: number;
  disabled?: boolean;
  shareAudience?: 'companions' | 'general';
};

export default function CurrentPlanBrief({ workspaceId, currentRevision, disabled = false, shareAudience = 'companions' }: CurrentPlanBriefProps) {
  const [status, setStatus] = useState<BriefStatus>('idle');
  const [previewText, setPreviewText] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [includeNotes, setIncludeNotes] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);
  const requestRef = useRef(0);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const openButtonRef = useRef<HTMLButtonElement | null>(null);
  const latestScopeRef = useRef({ workspaceId, currentRevision });
  latestScopeRef.current = { workspaceId, currentRevision };

  useEffect(() => {
    controllerRef.current?.abort();
    requestRef.current += 1;
    setStatus('idle');
    setPreviewText('');
    setMessage(null);
  }, [workspaceId, currentRevision]);

  useEffect(() => () => {
    requestRef.current += 1;
    controllerRef.current?.abort();
  }, []);

  async function loadBriefPreview(nextIncludeNotes = includeNotes) {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const request = requestRef.current + 1;
    requestRef.current = request;
    const requestedWorkspaceId = workspaceId;
    const requestedRevision = currentRevision;
    const timeout = window.setTimeout(() => controller.abort(), workspaceExportTimeoutMs);
    setStatus('loading');
    setPreviewText('');
    setMessage(null);
    try {
      const { exported } = await loadWorkspaceExport(requestedWorkspaceId, controller.signal);
      if (!isCurrentRequest(request, requestedWorkspaceId, requestedRevision)) return;
      const formatted = buildCurrentPlanBriefText(exported, {
        workspaceId: requestedWorkspaceId,
        currentRevision: requestedRevision,
        includeNotes: nextIncludeNotes,
      });
      if (!formatted.ok) {
        setStatus('error');
        setMessage(formatted.message);
        return;
      }
      setPreviewText(formatted.text);
      setStatus('ready');
      const noteMessage = formatted.omittedNoteCount > 0
        ? `메모 ${formatted.omittedNoteCount}개는 제외했습니다.`
        : nextIncludeNotes && formatted.includedNoteCount > 0
          ? `메모 ${formatted.includedNoteCount}개를 포함했습니다.`
          : '메모 없이 현재 저장된 계획을 확인했습니다.';
      setMessage(`${formatted.itemCount}개 저장 항목을 불러왔습니다. ${noteMessage}`);
    } catch (error) {
      if (!isCurrentRequest(request, requestedWorkspaceId, requestedRevision)) return;
      setStatus('error');
      setMessage(workspaceExportFailureMessage(error, '현재 저장된 계획을 확인하지 못했습니다.'));
    } finally {
      window.clearTimeout(timeout);
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  }

  async function copyPreview() {
    if (!previewText) return;
    const request = requestRef.current + 1;
    requestRef.current = request;
    const requestedWorkspaceId = workspaceId;
    const requestedRevision = currentRevision;
    setStatus('copying');
    setMessage(null);
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard_unavailable');
      await navigator.clipboard.writeText(previewText);
      if (!isCurrentRequest(request, requestedWorkspaceId, requestedRevision)) return;
      setStatus('copied');
      setMessage('현재 저장된 계획을 복사했습니다. 원하는 대화에 붙여넣으세요.');
    } catch {
      if (!isCurrentRequest(request, requestedWorkspaceId, requestedRevision)) return;
      setStatus('manual');
      setMessage('브라우저가 클립보드 복사를 허용하지 않았습니다. 아래 미리보기에서 직접 복사해 주세요.');
      window.setTimeout(() => {
        if (!isCurrentRequest(request, requestedWorkspaceId, requestedRevision)) return;
        textareaRef.current?.focus();
        textareaRef.current?.select();
      }, 0);
    }
  }

  function changeIncludeNotes(checked: boolean) {
    setIncludeNotes(checked);
    if (previewText || status === 'ready' || status === 'copied' || status === 'manual') void loadBriefPreview(checked);
  }

  function closePreview() {
    requestRef.current += 1;
    const request = requestRef.current;
    controllerRef.current?.abort();
    setPreviewText('');
    setMessage(null);
    setStatus('idle');
    window.setTimeout(() => {
      if (requestRef.current === request) openButtonRef.current?.focus();
    }, 0);
  }

  function isCurrentRequest(request: number, requestedWorkspaceId: string, requestedRevision: number): boolean {
    return requestRef.current === request &&
      latestScopeRef.current.workspaceId === requestedWorkspaceId &&
      latestScopeRef.current.currentRevision === requestedRevision;
  }

  const canCopy = previewText.length > 0 && !disabled && status !== 'copying' && status !== 'loading';

  return (
    <section className="review-card current-plan-brief" aria-labelledby="current-plan-brief-title" data-open={Boolean(previewText)}>
      <div>
        <h3 id="current-plan-brief-title">현재 저장된 계획</h3>
        <p className="muted">검토 중인 AI 변경 후보 없이, 지금 저장된 값만 모아 {shareAudience === 'general' ? '공유할' : '동행자에게 보낼'} 문장으로 확인합니다.</p>
      </div>
      <div className="current-plan-brief__actions">
        <button ref={openButtonRef} type="button" className="ghost-button" aria-expanded={Boolean(previewText)} aria-controls={previewText ? 'current-plan-brief-preview' : undefined} disabled={disabled || status === 'loading'} onClick={() => void loadBriefPreview()}>
          <Eye size={16} />
          {status === 'loading' ? '확인 중' : shareAudience === 'general' ? '공유할 계획 확인' : '동행자에게 보낼 계획'}
        </button>
        <label className="current-plan-brief__notes">
          <input
            type="checkbox"
            checked={includeNotes}
            disabled={disabled || status === 'loading'}
            onChange={(event) => changeIncludeNotes(event.currentTarget.checked)}
          />
          메모 포함
        </label>
        {previewText ? <button type="button" className="ghost-button" onClick={closePreview}><X size={16} aria-hidden="true" />미리보기 닫기</button> : null}
      </div>
      {previewText ? (
        <>
          <textarea
            id="current-plan-brief-preview"
            ref={textareaRef}
            className="current-plan-brief__preview"
            readOnly
            rows={Math.min(18, Math.max(8, previewText.split('\n').length))}
            value={previewText}
            aria-label="복사할 현재 저장된 계획 미리보기"
          />
          <button type="button" className="primary-action current-plan-brief__copy" disabled={!canCopy} onClick={() => void copyPreview()}>
            {status === 'copied' ? <ClipboardCheck size={16} /> : <Copy size={16} />}
            {status === 'copying' ? '복사 중' : '미리보기 내용 복사'}
          </button>
        </>
      ) : null}
      {message ? <p className={status === 'error' || status === 'manual' ? 'form-error' : 'muted'} role={status === 'error' || status === 'manual' ? 'alert' : 'status'}>{message}</p> : null}
    </section>
  );
}

export type { CurrentPlanBriefProps };
