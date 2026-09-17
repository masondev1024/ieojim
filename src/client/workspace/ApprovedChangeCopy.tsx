import { useEffect, useRef, useState } from 'react';
import { ClipboardCheck, Copy, Eye } from 'lucide-react';
import { buildApprovedRevisionCopyText } from './approved-change-copy';
import { loadWorkspaceExport, workspaceExportFailureMessage, workspaceExportTimeoutMs } from './export-reader';

type CopyStatus = 'idle' | 'loading' | 'ready' | 'copying' | 'copied' | 'manual' | 'error';

type ApprovedChangeCopyProps = {
  workspaceId: string;
  currentRevision: number;
  disabled?: boolean;
};

export default function ApprovedChangeCopy({ workspaceId, currentRevision, disabled = false }: ApprovedChangeCopyProps) {
  const [status, setStatus] = useState<CopyStatus>('idle');
  const [previewText, setPreviewText] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const requestRef = useRef(0);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
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

  async function loadApprovedPreview() {
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
      const formatted = buildApprovedRevisionCopyText(exported, requestedWorkspaceId, requestedRevision);
      if (!formatted.ok) {
        setStatus('error');
        setMessage(formatted.message);
        return;
      }
      setPreviewText(formatted.text);
      setStatus('ready');
      setMessage(`${formatted.changeCount}개 실제 전후 차이를 확인했습니다. 내용을 확인한 뒤 복사하세요.`);
    } catch (error) {
      if (!isCurrentRequest(request, requestedWorkspaceId, requestedRevision)) return;
      setStatus('error');
      setMessage(workspaceExportFailureMessage(error, '승인한 변경 내용을 확인하지 못했습니다.'));
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
      setMessage('변경 안내를 복사했습니다. 원하는 대화에 붙여넣으세요.');
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

  function isCurrentRequest(request: number, requestedWorkspaceId: string, requestedRevision: number): boolean {
    return requestRef.current === request &&
      latestScopeRef.current.workspaceId === requestedWorkspaceId &&
      latestScopeRef.current.currentRevision === requestedRevision;
  }

  const canCopy = previewText.length > 0 && !disabled && status !== 'copying' && status !== 'loading';

  return (
    <section className="review-card" aria-labelledby="approved-copy-title">
      <div>
        <h3 id="approved-copy-title">동행자에게 변경 안내</h3>
        <p className="muted">사용자가 승인해 저장한 변경만 모았습니다. 함께 보낼 내용을 확인하고 복사하세요.</p>
      </div>
      <button type="button" className="ghost-button" disabled={disabled || status === 'loading'} onClick={() => void loadApprovedPreview()}>
        <Eye size={16} />
        {status === 'loading' ? '확인 중' : '승인해 저장한 변경 보기'}
      </button>
      {previewText ? (
        <>
          <textarea
            ref={textareaRef}
            readOnly
            rows={Math.min(14, Math.max(6, previewText.split('\n').length))}
            value={previewText}
            aria-label="복사할 승인 저장 변경 요약 미리보기"
          />
          <button type="button" className="primary-action" disabled={!canCopy} onClick={() => void copyPreview()}>
            {status === 'copied' ? <ClipboardCheck size={16} /> : <Copy size={16} />}
            {status === 'copying' ? '복사 중' : '미리보기 내용 복사'}
          </button>
        </>
      ) : null}
      {message ? <p className={status === 'error' || status === 'manual' ? 'form-error' : 'muted'} role={status === 'error' || status === 'manual' ? 'alert' : 'status'}>{message}</p> : null}
    </section>
  );
}

export type { ApprovedChangeCopyProps };
