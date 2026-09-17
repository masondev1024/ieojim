import { useEffect, useRef, useState } from 'react';
import { loadWorkspaceExport, workspaceExportFailureMessage, workspaceExportTimeoutMs } from './export-reader';
import './workspace-export.css';

type ExportStatus = 'idle' | 'loading' | 'success' | 'error';

type ExportFailure = { message: string };

export default function WorkspaceExportButton({ workspaceId }: { workspaceId: string }) {
  const [status, setStatus] = useState<ExportStatus>('idle');
  const [failure, setFailure] = useState<ExportFailure | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const latestWorkspaceIdRef = useRef(workspaceId);
  const mountedRef = useRef(true);
  latestWorkspaceIdRef.current = workspaceId;

  useEffect(() => {
    controllerRef.current?.abort();
    setStatus('idle');
    setFailure(null);
  }, [workspaceId]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      controllerRef.current?.abort();
      revokeObjectUrl(objectUrlRef);
    };
  }, []);

  async function downloadCurrentWorkspace() {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), workspaceExportTimeoutMs);
    const requestedWorkspaceId = workspaceId;
    setStatus('loading');
    setFailure(null);
    try {
      const { text } = await loadWorkspaceExport(requestedWorkspaceId, controller.signal);
      if (controller.signal.aborted || latestWorkspaceIdRef.current !== requestedWorkspaceId || !mountedRef.current) return;
      revokeObjectUrl(objectUrlRef);
      const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
      objectUrlRef.current = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objectUrlRef.current;
      link.download = `ieojim-workspace-${requestedWorkspaceId}.json`;
      link.rel = 'noopener';
      document.body.appendChild(link);
      link.click();
      link.remove();
      setStatus('success');
    } catch (error) {
      if (latestWorkspaceIdRef.current !== requestedWorkspaceId || !mountedRef.current) return;
      if (controller.signal.aborted) {
        setFailure({ message: '내려받기 요청 시간이 초과됐습니다. 다시 시도해 주세요.' });
      } else {
        setFailure({ message: workspaceExportFailureMessage(error, '현재 저장된 계획을 내려받지 못했습니다.') });
      }
      setStatus('error');
    } finally {
      window.clearTimeout(timeout);
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  }

  return (
    <section className="workspace-export" aria-labelledby="workspace-export-title">
      <div>
        <h3 id="workspace-export-title">현재 데이터 내려받기</h3>
        <p>현재 계획, 저장된 원문, 현재·직전 저장 계획 버전을 JSON으로 내려받습니다. 검토 중인 AI 변경 후보, 계정 정보, 비용 장부는 포함하지 않습니다.</p>
      </div>
      <button type="button" className="primary-action workspace-export__button" onClick={() => void downloadCurrentWorkspace()} disabled={status === 'loading'}>
        {status === 'loading' ? '내려받는 중' : '현재 계획·원문 내려받기'}
      </button>
      {status === 'success' ? <p className="workspace-export__status" role="status">내려받기를 시작했습니다.</p> : null}
      {failure ? <p className="workspace-export__error" role="alert">{failure.message}</p> : null}
    </section>
  );
}

function revokeObjectUrl(ref: { current: string | null }): void {
  if (!ref.current) return;
  URL.revokeObjectURL(ref.current);
  ref.current = null;
}
