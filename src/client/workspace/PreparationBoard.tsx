import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CalendarClock, CheckCircle2, Clock, Save, X } from 'lucide-react';
import type { Block, BlockItem, ItemPreparation, Snapshot } from '../../core/contracts';
import { getPreparationItems, type PreparationStatus } from '../../core/preparation';
import './preparation-board.css';

type PreparationBoardProps = {
  workspaceId: string;
  revision: number;
  blocks: Block[];
  disabled: boolean;
  defaultOpen?: boolean;
  onSave: (item: BlockItem, preparation: ItemPreparation, requestId: string) => Promise<boolean>;
  onReopen: (item: BlockItem, requestId: string) => Promise<boolean>;
  onAcknowledgeReview: (item: BlockItem, requestId: string) => Promise<boolean>;
};

type PreparationDraft = {
  dueDate: string;
  durationMinutes: string;
  baseRevision: number;
  request: { signature: string; requestId: string } | null;
};
type SaveState = { itemId: string; status: 'saving' | 'saved' | 'failed'; message: string } | null;

const statusLabels: Record<PreparationStatus, string> = {
  needs_review: '확인 필요',
  overdue: '기한 지남',
  today: '오늘',
  upcoming: '예정',
  unscheduled: '날짜 없음',
  completed: '완료',
};

export default function PreparationBoard(props: PreparationBoardProps) {
  const [open, setOpen] = useState(props.defaultOpen === true);
  const [drafts, setDrafts] = useState<Record<string, PreparationDraft>>({});
  const [saveState, setSaveState] = useState<SaveState>(null);
  const [referenceDate, setReferenceDate] = useState(() => todayDate());
  const [acknowledgeRequests, setAcknowledgeRequests] = useState<Record<string, { signature: string; requestId: string }>>({});
  const snapshot = useMemo<Snapshot>(() => ({ facts: [], blocks: props.blocks }), [props.blocks]);
  const items = useMemo(() => getPreparationItems(snapshot, referenceDate), [snapshot, referenceDate]);
  const itemById = useMemo(() => {
    const index = new Map<string, BlockItem>();
    for (const block of props.blocks) for (const item of block.items) index.set(item.id, item);
    return index;
  }, [props.blocks]);

  useEffect(() => {
    setDrafts({});
    setSaveState(null);
    setAcknowledgeRequests({});
  }, [props.workspaceId]);

  useEffect(() => {
    const refreshReferenceDate = () => {
      const next = todayDate();
      setReferenceDate((current) => current === next ? current : next);
    };
    const intervalId = window.setInterval(refreshReferenceDate, 60_000);
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') refreshReferenceDate();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []);

  if (items.length === 0) return null;

  function draftFor(item: BlockItem): PreparationDraft {
    return drafts[item.id] ?? {
      dueDate: item.preparation?.dueDate ?? '',
      durationMinutes: item.preparation?.durationMinutes ? String(item.preparation.durationMinutes) : '',
      baseRevision: props.revision,
      request: null,
    };
  }

  function updateDraft(item: BlockItem, field: keyof Pick<PreparationDraft, 'dueDate' | 'durationMinutes'>, value: string) {
    setDrafts((current) => ({ ...current, [item.id]: { ...draftFor(item), baseRevision: props.revision, request: null, [field]: value } }));
  }

  async function save(item: BlockItem, clear = false) {
    const currentDraft = draftFor(item);
    const draft = clear ? { ...currentDraft, dueDate: '', durationMinutes: '', baseRevision: props.revision } : currentDraft;
    if (draft.baseRevision !== props.revision) {
      setSaveState({ itemId: item.id, status: 'failed', message: '다른 변경이 먼저 저장됐습니다. 최신 저장 계획을 확인한 뒤 다시 입력해 주세요.' });
      return;
    }
    const duration = draft.durationMinutes.trim() === '' ? null : Number(draft.durationMinutes);
    const preparation: ItemPreparation = {
      version: 1,
      dueDate: draft.dueDate.trim() === '' ? null : draft.dueDate.trim(),
      durationMinutes: Number.isInteger(duration) ? duration : null,
    };
    const signature = JSON.stringify({ workspaceId: props.workspaceId, revision: draft.baseRevision, itemId: item.id, preparation });
    const requestId = draft.request?.signature === signature ? draft.request.requestId : crypto.randomUUID();
    setDrafts((current) => ({ ...current, [item.id]: { ...draft, request: { signature, requestId } } }));
    setSaveState({ itemId: item.id, status: 'saving', message: '저장 중' });
    const saved = await props.onSave(item, preparation, requestId);
    if (saved) {
      setDrafts((current) => {
        const next = { ...current };
        delete next[item.id];
        return next;
      });
      setSaveState({ itemId: item.id, status: 'saved', message: '저장됨' });
    } else {
      setSaveState({ itemId: item.id, status: 'failed', message: '저장 실패. 입력은 유지됩니다.' });
    }
  }

  async function acknowledgeReview(item: BlockItem, reopen = false) {
    const signature = JSON.stringify({ workspaceId: props.workspaceId, revision: props.revision, itemId: item.id, acknowledgeReview: true, reopen });
    const previous = acknowledgeRequests[item.id];
    const requestId = previous?.signature === signature ? previous.requestId : crypto.randomUUID();
    setAcknowledgeRequests((current) => ({ ...current, [item.id]: { signature, requestId } }));
    setSaveState({ itemId: item.id, status: 'saving', message: '확인 저장 중' });
    const saved = await (reopen ? props.onReopen(item, requestId) : props.onAcknowledgeReview(item, requestId));
    if (saved) {
      setAcknowledgeRequests((current) => {
        const next = { ...current };
        delete next[item.id];
        return next;
      });
      setSaveState({ itemId: item.id, status: 'saved', message: reopen ? '다시 할 일로 저장됨' : '확인 완료로 저장됨' });
    } else {
      setSaveState({ itemId: item.id, status: 'failed', message: '확인 완료 저장 실패. 항목은 그대로 유지됩니다.' });
    }
  }

  const needsAttention = items.filter((item) => item.status === 'needs_review' || item.status === 'overdue' || item.status === 'today').length;

  return (
    <section className="review-card preparation-board" data-open={open} aria-labelledby="preparation-board-title">
      <button type="button" className="preparation-board__toggle" onClick={() => setOpen((value) => !value)} aria-expanded={open} aria-controls="preparation-board-panel">
        <span><CalendarClock size={18} aria-hidden="true" /> <strong id="preparation-board-title">준비 업무</strong></span>
        <small>한국시간 {referenceDate} · {items.length}개 · 주의 {needsAttention}개</small>
      </button>
      {open ? (
        <div id="preparation-board-panel" className="preparation-board__panel">
          <p className="preparation-board__help">마감일과 예상 시간은 담당자가 직접 입력한 값입니다. 날짜가 가까운 일과 원문 변경 뒤 다시 봐야 할 일을 먼저 찾을 수 있게 상태를 붙여요.</p>
          {items.map((entry) => {
            const item = itemById.get(entry.itemId);
            if (!item) return null;
            const draft = draftFor(item);
            const duration = draft.durationMinutes.trim() ? Number(draft.durationMinutes) : null;
            const itemState = saveState?.itemId === item.id ? saveState : null;
            const canSave = (draft.dueDate.trim() === '' || /^\d{4}-\d{2}-\d{2}$/.test(draft.dueDate.trim())) &&
              (draft.durationMinutes.trim() === '' || (Number.isInteger(duration) && duration !== null && duration >= 1 && duration <= 1440));
            return (
              <article key={entry.itemId} className="preparation-board__row" data-status={entry.status} aria-label={`준비 항목: ${entry.label} · 준비 설정`}>
                <div>
                  <span className="preparation-board__status">{statusIcon(entry.status)}{statusLabels[entry.status]}</span>
                  <strong>{entry.label} · 준비 설정</strong>
                  <p>{entry.blockTitle}</p>
                </div>
                <label>
                  마감일
                  <input type="date" value={draft.dueDate} disabled={props.disabled || itemState?.status === 'saving'} onChange={(event) => updateDraft(item, 'dueDate', event.currentTarget.value)} />
                </label>
                <label>
                  예상 시간(분)
                  <input type="number" min={1} max={1440} step={5} inputMode="numeric" value={draft.durationMinutes} disabled={props.disabled || itemState?.status === 'saving'} onChange={(event) => updateDraft(item, 'durationMinutes', event.currentTarget.value)} />
                </label>
                <div className="preparation-board__actions">
                  <button type="button" aria-label="준비 저장" disabled={props.disabled || !canSave || itemState?.status === 'saving'} onClick={() => void save(item)}>
                    <Save size={15} />
                    <span>준비 저장</span>
                  </button>
                  {item.preparation ? (
                    <button type="button" aria-label="준비 설정 비우기" disabled={props.disabled || itemState?.status === 'saving'} onClick={() => void save(item, true)}>
                      <X size={15} />
                    </button>
                  ) : null}
                </div>
                {item.stale ? (
                  <div className="preparation-board__review">
                    <p>{item.completed
                      ? '이전 자료로 끝낸 기록은 남아 있어요. 바뀐 내용도 확인했는지, 다시 해야 할 일이 있는지 골라 주세요.'
                      : '관련 원문이 바뀌어 확인이 필요한 준비 업무예요. 내용을 검토한 뒤 확인 표시를 해제해 주세요.'}</p>
                    {item.completed ? <button type="button" disabled={props.disabled || itemState?.status === 'saving'} onClick={() => void acknowledgeReview(item, true)}>다시 할 일로 표시</button> : null}
                    <button type="button" disabled={props.disabled || itemState?.status === 'saving'} onClick={() => void acknowledgeReview(item)}>{item.completed ? '확인했어요, 완료 유지' : '준비 내용 확인 완료'}</button>
                  </div>
                ) : null}
                {itemState ? <p className={`preparation-board__save-state ${itemState.status}`} role={itemState.status === 'failed' ? 'alert' : 'status'}>{itemState.message}</p> : null}
              </article>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}

function statusIcon(status: PreparationStatus) {
  if (status === 'completed') return <CheckCircle2 size={13} aria-hidden="true" />;
  if (status === 'needs_review' || status === 'overdue' || status === 'today') return <AlertTriangle size={13} aria-hidden="true" />;
  return <Clock size={13} aria-hidden="true" />;
}

function todayDate(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}
