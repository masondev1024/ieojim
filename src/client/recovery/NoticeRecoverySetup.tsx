import { AlertTriangle, CheckCircle2, ChevronDown, Clock3, FileText, LockKeyhole, Plus, RotateCcw, ShieldCheck, Trash2 } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { BlockItem, Fact, Source, WorkspaceView } from '../../core/contracts';
import { noticeRecoveryRequestSchema, type NoticeRecoveryRequest } from '../../core/notice-recovery';
import type { RecoveryView } from '../../core/recovery-api-contracts';
import { buildNoticeDateSuggestions, buildNoticeSetupPrefill, type NoticeDateSuggestion, type Provenance } from './notice-recovery-prefill';
import AccountLink from '../account/AccountLink';
import './notice-recovery.css';

type NoticeRecoverySetupProps = {
  workspaceId: string;
};

type IntervalDraft = { start: string; end: string };
type MovableDraft = { enabled: boolean; start: string; end: string; durationMinutes: string };
type CommitmentDraft = IntervalDraft & { movable: MovableDraft };
type WorkWindowDraft = IntervalDraft & { id: string; label: string };
type ExtraBusyDraft = IntervalDraft & { id: string; title: string };
type PrepMode = 'existing' | 'new';


type ApiFailure = { code: string; message: string; status?: number };
type RequestToken = { signature: string; requestId: string };

const LOCAL_MINUTE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const uuidFallbackPrefix = 'notice-recovery';

export default function NoticeRecoverySetup({ workspaceId }: NoticeRecoverySetupProps) {
  const navigate = useNavigate();
  const [workspace, setWorkspace] = useState<WorkspaceView | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [sourceId, setSourceId] = useState('');
  const [targetItemId, setTargetItemId] = useState('');
  const [targetBefore, setTargetBefore] = useState<IntervalDraft>({ start: '', end: '' });
  const [targetAfter, setTargetAfter] = useState<IntervalDraft>({ start: '', end: '' });
  const [prepMode, setPrepMode] = useState<PrepMode>('existing');
  const [prepItemId, setPrepItemId] = useState('');
  const [newPrepTitle, setNewPrepTitle] = useState('');
  const [prepBefore, setPrepBefore] = useState<IntervalDraft>({ start: '', end: '' });
  const [prepDurationMinutes, setPrepDurationMinutes] = useState('');
  const [prepDeadline, setPrepDeadline] = useState('');
  const [travelMinutes, setTravelMinutes] = useState('');
  const [horizonStart, setHorizonStart] = useState(() => kstNowMinute());
  const [horizonEnd, setHorizonEnd] = useState('');
  const [workWindows, setWorkWindows] = useState<WorkWindowDraft[]>([]);
  const [commitments, setCommitments] = useState<Record<string, CommitmentDraft>>({});
  const [extraBusy, setExtraBusy] = useState<ExtraBusyDraft[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const [touchedFields, setTouchedFields] = useState<Set<string>>(() => new Set());
  const [prefillNotes, setPrefillNotes] = useState<Record<string, Provenance>>({});
  const requestRef = useRef<RequestToken | null>(null);
  const loadControllerRef = useRef<AbortController | null>(null);
  const submitControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    loadControllerRef.current?.abort();
    loadControllerRef.current = controller;
    setLoading(true);
    setMessage(null);
    setWorkspace(null);
    resetFormDraft();
    readJson<WorkspaceView>(`/api/workspaces/${encodeURIComponent(workspaceId)}`, { signal: controller.signal }).then((payload) => {
      if (controller.signal.aborted) return;
      setWorkspace(payload);
      setHorizonStart(kstNowMinute());
      setSourceId((current) => current || defaultSourceId(payload.sources));
      setCommitments((current) => seedCommitments(payload, current));
    }).catch((error) => {
      if (isAbort(error)) return;
      setMessage(failureMessage(error, '작업 공간을 불러오지 못했습니다. 권한 또는 최신 상태를 확인해 주세요.'));
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [workspaceId]);

  useEffect(() => () => {
    loadControllerRef.current?.abort();
    submitControllerRef.current?.abort();
  }, []);

  useEffect(() => {
    const leavePrivateView = () => {
      loadControllerRef.current?.abort();
      submitControllerRef.current?.abort();
      setWorkspace(null);
      navigate('/app', { replace: true });
    };
    window.addEventListener('ieojim-identity-change', leavePrivateView);
    return () => {
      window.removeEventListener('ieojim-identity-change', leavePrivateView);
    };
  }, [navigate]);

  const allItems = useMemo(() => workspace ? workspace.snapshot.blocks.flatMap((block) => block.items.map((item) => ({ blockType: block.type, blockTitle: block.title, item }))) : [], [workspace]);
  const scheduleItems = allItems.filter((entry) => entry.blockType === 'schedule');
  const preparationItems = allItems.filter((entry) => entry.blockType === 'checklist');
  const selectedTarget = scheduleItems.find((entry) => entry.item.id === targetItemId)?.item ?? null;
  const selectedPreparation = preparationItems.find((entry) => entry.item.id === prepItemId)?.item ?? null;
  const source = workspace?.sources.find((entry) => entry.id === sourceId) ?? null;
  const supersededSourceIds = useMemo(() => supersededSources(workspace?.sources ?? []), [workspace]);
  const selectableSources = useMemo(() => (workspace?.sources ?? []).filter((entry) => !supersededSourceIds.has(entry.id)), [workspace, supersededSourceIds]);
  const selectedTargetFacts = useMemo(() => selectedTarget && workspace ? factsForItem(workspace, selectedTarget) : [], [selectedTarget, workspace]);
  const sourceFacts = selectedTargetFacts.filter((fact) => fact.evidence.sourceId === sourceId && evidenceMatches(workspace?.sources ?? [], fact));
  const dateSuggestions = useMemo(() => workspace ? buildNoticeDateSuggestions(workspace, sourceId) : [], [workspace, sourceId]);
  const setupPrefill = useMemo(() => workspace ? buildNoticeSetupPrefill(workspace, sourceId, targetItemId, prepItemId) : null, [workspace, sourceId, targetItemId, prepItemId]);
  const review = useMemo(() => validateAndBuildRequest(), [
    workspace, sourceId, targetItemId, targetBefore, targetAfter, prepMode, prepItemId, newPrepTitle,
    prepBefore, prepDurationMinutes, prepDeadline, travelMinutes, horizonStart, horizonEnd,
    workWindows, commitments, extraBusy, confirmed,
  ]);
  const oldTravelSentence = oldTravelSummary(targetBefore.start, travelMinutes);
  const appliedSourceRuns = workspace?.runs.filter((run) => run.sourceId === sourceId && run.status === 'applied') ?? [];
  const latestRunMode = appliedSourceRuns.some((run) => run.mode === 'fixture') ? 'fixture' : appliedSourceRuns.some((run) => run.mode === 'live') ? 'live' : null;
  const prefilledCount = Object.keys(prefillNotes).filter((key) => key !== 'prepDueDate' && key !== 'prepDeadline').length;
  const prepDeadlineSuggestions = useMemo(() => buildPrepDeadlineSuggestions(dateSuggestions, workspace, selectedPreparation, prepMode), [dateSuggestions, workspace, selectedPreparation, prepMode]);
  const prepDeadlineEvidenceIds = [
    prefillNotes.prepDeadline ? 'notice-prep-deadline-evidence' : '',
    prefillNotes.prepDueDate ? 'notice-prep-due-evidence' : '',
  ].filter(Boolean).join(' ') || undefined;

  useEffect(() => {
    if (!setupPrefill) return;
    let changed = false;
    const notes: Record<string, Provenance> = {};
    if (!targetItemId && setupPrefill.targetItemId && !touchedFields.has('targetItemId')) {
      setTargetItemId(setupPrefill.targetItemId);
      changed = true;
    }
    if (!targetAfter.start && setupPrefill.targetAfterStart && !touchedFields.has('targetAfter.start')) {
      setTargetAfter((current) => current.start ? current : { ...current, start: setupPrefill.targetAfterStart!.value });
      notes['targetAfter.start'] = setupPrefill.targetAfterStart.provenance;
      changed = true;
    }
    if (prepMode === 'existing' && !prepItemId && setupPrefill.prepItemId && !touchedFields.has('prepItemId')) {
      setPrepItemId(setupPrefill.prepItemId);
      changed = true;
    }
    if (prepMode === 'existing' && !prepDurationMinutes && setupPrefill.prepDurationMinutes && !touchedFields.has('prepDurationMinutes')) {
      setPrepDurationMinutes(setupPrefill.prepDurationMinutes.value);
      notes.prepDurationMinutes = setupPrefill.prepDurationMinutes.provenance;
      changed = true;
    }
    if (prepMode === 'existing' && setupPrefill.prepDueDate) notes.prepDueDate = setupPrefill.prepDueDate;
    if (Object.keys(notes).length > 0) setPrefillNotes((current) => ({ ...current, ...notes }));
    if (changed) setConfirmed(false);
  }, [setupPrefill, targetItemId, targetAfter.start, prepMode, prepItemId, prepDurationMinutes, touchedFields]);

  function resetConfirmation() {
    setConfirmed(false);
    setMessage(null);
  }

  function resetFormDraft() {
    setSourceId('');
    setTargetItemId('');
    setTargetBefore({ start: '', end: '' });
    setTargetAfter({ start: '', end: '' });
    setPrepMode('existing');
    setPrepItemId('');
    setNewPrepTitle('');
    setPrepBefore({ start: '', end: '' });
    setPrepDurationMinutes('');
    setPrepDeadline('');
    setTravelMinutes('');
    setHorizonEnd('');
    setWorkWindows([]);
    setCommitments({});
    setExtraBusy([]);
    setConfirmed(false);
    setTouchedFields(new Set());
    setPrefillNotes({});
    requestRef.current = null;
  }

  function markTouched(field: string) {
    setTouchedFields((current) => {
      if (current.has(field)) return current;
      const next = new Set(current);
      next.add(field);
      return next;
    });
    setPrefillNotes((current) => {
      if (!(field in current)) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
  }

  function changeSource(nextSourceId: string) {
    resetConfirmation();
    setSourceId(nextSourceId);
    setTargetItemId('');
    setTargetBefore({ start: '', end: '' });
    setTargetAfter({ start: '', end: '' });
    if (prefillNotes.prepDeadline) setPrepDeadline('');
    setTouchedFields((current) => {
      const next = new Set([...current].filter((field) => !field.startsWith('target')));
      return next;
    });
    setPrefillNotes((current) => clearNotePrefix(current, ['target', 'prepDurationMinutes', 'prepDueDate', 'prepDeadline']));
  }

  function chooseTarget(itemId: string) {
    resetConfirmation();
    setTargetItemId(itemId);
    setTargetBefore({ start: '', end: '' });
    setTargetAfter({ start: '', end: '' });
    setTouchedFields((current) => {
      const next = new Set([...current].filter((field) => !field.startsWith('targetBefore') && !field.startsWith('targetAfter')));
      next.add('targetItemId');
      return next;
    });
    setPrefillNotes((current) => clearNotePrefix(current, ['targetBefore', 'targetAfter']));
  }

  function updateInterval(setter: (value: IntervalDraft) => void, current: IntervalDraft, field: keyof IntervalDraft, value: string) {
    resetConfirmation();
    setter({ ...current, [field]: value });
  }

  function updateNamedInterval(keyPrefix: string, setter: (value: IntervalDraft) => void, current: IntervalDraft, field: keyof IntervalDraft, value: string) {
    markTouched(`${keyPrefix}.${field}`);
    updateInterval(setter, current, field, value);
  }

  function choosePreparationMode(mode: PrepMode) {
    resetConfirmation();
    setPrepMode(mode);
    if (prefillNotes.prepDeadline) setPrepDeadline('');
    if (mode === 'new') {
      setPrepItemId('');
      if (!touchedFields.has('prepDurationMinutes')) setPrepDurationMinutes('');
      setPrefillNotes((current) => clearNotePrefix(current, ['prepDurationMinutes', 'prepDueDate', 'prepDeadline']));
      return;
    }
    setPrefillNotes((current) => clearNotePrefix(current, ['prepDeadline']));
    setNewPrepTitle('');
  }

  function chooseExistingPreparation(itemId: string) {
    resetConfirmation();
    markTouched('prepItemId');
    setPrepItemId(itemId);
    const item = preparationItems.find((entry) => entry.item.id === itemId)?.item;
    if (prefillNotes.prepDeadline) setPrepDeadline('');
    setPrefillNotes((current) => clearNotePrefix(current, ['prepDurationMinutes', 'prepDueDate', 'prepDeadline']));
    if (!touchedFields.has('prepDurationMinutes')) {
      setPrepDurationMinutes('');
    }
    if (!item?.preparation) return;
    if (item.preparation.durationMinutes && !touchedFields.has('prepDurationMinutes')) {
      setPrepDurationMinutes(String(item.preparation.durationMinutes));
      setPrefillNotes((current) => ({ ...current, prepDurationMinutes: { label: '준비 설정에서 가져옴', detail: `${item.label}에 저장된 준비 시간` } }));
    }
    if (item.preparation.dueDate) {
      setPrefillNotes((current) => ({ ...current, prepDueDate: { label: '준비 설정에 저장된 마감일', detail: `${item.label}: ${item.preparation!.dueDate}` } }));
    }
  }

  function choosePrepDeadlineSuggestion(suggestion: NoticeDateSuggestion) {
    markTouched('prepDeadline');
    resetConfirmation();
    setPrepDeadline(suggestion.value);
    setPrefillNotes((current) => ({
      ...current,
      prepDeadline: {
        label: '원문 근거를 골라 입력함',
        detail: `${suggestion.label}: "${suggestion.quote}"`,
      },
    }));
  }

  function addWorkWindow() {
    resetConfirmation();
    setWorkWindows((current) => [...current, { id: cryptoId(), label: '', start: '', end: '' }]);
  }

  function updateWorkWindow(id: string, patch: Partial<WorkWindowDraft>) {
    resetConfirmation();
    setWorkWindows((current) => current.map((entry) => entry.id === id ? { ...entry, ...patch } : entry));
  }

  function removeWorkWindow(id: string) {
    resetConfirmation();
    setWorkWindows((current) => current.filter((entry) => entry.id !== id));
  }

  function updateCommitment(itemId: string, patch: Partial<CommitmentDraft>) {
    resetConfirmation();
    setCommitments((current) => ({ ...current, [itemId]: { ...commitmentFor(current, itemId), ...patch } }));
  }

  function updateMovable(itemId: string, patch: Partial<MovableDraft>) {
    resetConfirmation();
    const current = commitmentFor(commitments, itemId);
    setCommitments((drafts) => ({ ...drafts, [itemId]: { ...current, movable: { ...current.movable, ...patch } } }));
  }

  function addExtraBusy() {
    resetConfirmation();
    setExtraBusy((current) => [...current, { id: cryptoId(), title: '', start: '', end: '' }]);
  }

  function updateExtraBusy(id: string, patch: Partial<ExtraBusyDraft>) {
    resetConfirmation();
    setExtraBusy((current) => current.map((entry) => entry.id === id ? { ...entry, ...patch } : entry));
  }

  function removeExtraBusy(id: string) {
    resetConfirmation();
    setExtraBusy((current) => current.filter((entry) => entry.id !== id));
  }

  async function submit() {
    if (!review.ok) {
      setMessage(review.errors[0] ?? '필수 확인값을 먼저 입력해 주세요.');
      return;
    }
    submitControllerRef.current?.abort();
    const controller = new AbortController();
    submitControllerRef.current = controller;
    const signature = JSON.stringify({ ...review.request, requestId: undefined });
    const request = requestRef.current?.signature === signature
      ? requestRef.current
      : { signature, requestId: cryptoId() };
    requestRef.current = request;
    const payload = { ...review.request, requestId: request.requestId };
    setSubmitting(true);
    setMessage('확인한 조건으로 별도 일정 조정 작업 공간을 만드는 중입니다.');
    try {
      const response = await readJson<RecoveryView>(`/api/workspaces/${encodeURIComponent(workspaceId)}/recovery/from-notice`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      navigate(`/recovery/${encodeURIComponent(response.workspaceId)}`);
    } catch (error) {
      if (isAbort(error)) return;
      setMessage(failureMessage(error, '일정 조정 작업 공간을 만들지 못했습니다. 같은 입력으로 다시 시도할 수 있습니다.'));
    } finally {
      if (!controller.signal.aborted) setSubmitting(false);
    }
  }

  function validateAndBuildRequest(): { ok: true; request: NoticeRecoveryRequest; warnings: string[] } | { ok: false; errors: string[]; warnings: string[] } {
    const errors: string[] = [];
    const warnings: string[] = [];
    if (!workspace) errors.push('작업 공간을 먼저 불러와야 합니다.');
    if (!source) errors.push('근거 원문을 선택해 주세요.');
    if (source && supersededSourceIds.has(source.id)) errors.push('이미 정정·대체된 이전 원문은 기준 원문으로 사용할 수 없습니다. 최신 원문을 선택해 주세요.');
    if (!selectedTarget) errors.push('바뀐 일정을 선택해 주세요.');
    const targetReason = selectedTarget ? blockedReason(selectedTarget) : null;
    if (targetReason) errors.push(`선택한 일정은 조정 대상으로 사용할 수 없습니다. ${targetReason}`);
    if (selectedTarget && sourceFacts.length === 0) errors.push('선택한 일정에는 이 원문과 일치하는 저장 근거가 없습니다.');
    validateInterval('기존 일정 시간', targetBefore, errors);
    validateInterval('변경된 일정 시간', targetAfter, errors);
    validateInterval('준비 기존 시간', prepBefore, errors);
    const parsedTravel = parseBoundedNumber(travelMinutes, 1, 240);
    const parsedPrepDuration = parseBoundedNumber(prepDurationMinutes, 1, 240);
    if (parsedTravel === null) errors.push('이동 시간은 1분 이상 240분 이하로 입력해 주세요.');
    if (parsedPrepDuration === null) errors.push('준비 시간은 1분 이상 240분 이하로 입력해 주세요.');
    if (!isLocalMinute(prepDeadline)) errors.push('준비 마감의 날짜와 시간을 확인해 주세요.');
    if (prepMode === 'existing') {
      if (!selectedPreparation) errors.push('기존 준비 항목을 선택해 주세요.');
      const prepReason = selectedPreparation ? blockedReason(selectedPreparation) : null;
      if (prepReason) errors.push(`선택한 준비 항목은 사용할 수 없습니다. ${prepReason}`);
      if (selectedPreparation?.preparation?.durationMinutes && parsedPrepDuration !== selectedPreparation.preparation.durationMinutes) {
        errors.push(`기존 준비 시간 ${selectedPreparation.preparation.durationMinutes}분을 보존해야 합니다.`);
      }
      if (selectedPreparation?.preparation?.dueDate && prepDeadline && !prepDeadline.startsWith(`${selectedPreparation.preparation.dueDate}T`)) {
        errors.push(`기존 준비 마감일 ${selectedPreparation.preparation.dueDate}을 보존해야 합니다.`);
      }
    } else if (newPrepTitle.trim().length === 0) {
      errors.push('새 준비 작업 제목을 입력해 주세요.');
    }
    if (!isLocalMinute(horizonStart)) errors.push('계획 기준 시간이 정확하지 않습니다. 새로고침 후 다시 시도해 주세요.');
    if (!isLocalMinute(horizonEnd) || compareLocal(horizonStart, horizonEnd) >= 0) errors.push('조정 범위 끝 시간을 정확히 입력해 주세요.');
    if (isLocalMinute(horizonEnd) && minutesBetween(horizonStart, horizonEnd) > 48 * 60) errors.push('선택한 기준 시각부터 최대 48시간까지 계산할 수 있습니다.');
    if (workWindows.length === 0) errors.push('가용 시간을 최소 하나 입력해 주세요.');
    for (const [index, window] of workWindows.entries()) {
      if (window.label.trim().length === 0) errors.push(`가용 시간 ${index + 1}의 이름을 입력해 주세요.`);
      validateInterval(`가용 시간 ${index + 1}`, window, errors);
    }
    const commitmentRows = scheduleItems.filter(({ item }) => item.id !== targetItemId);
    const movableCount = commitmentRows.filter(({ item }) => commitmentFor(commitments, item.id).movable.enabled).length;
    if (movableCount > 1) errors.push('다른 일정 중 이동 가능 항목은 최대 1개만 선택할 수 있습니다.');
    for (const { item } of commitmentRows) {
      const draft = commitmentFor(commitments, item.id);
      validateInterval(`${item.label} 일정`, draft, errors);
      if (draft.movable.enabled) {
        if (blockedReason(item)) errors.push(`${item.label}은 보호 상태라 이동 가능 항목으로 둘 수 없습니다.`);
        validateInterval(`${item.label} 이동 가능 범위`, draft.movable, errors);
        if (parseBoundedNumber(draft.movable.durationMinutes, 1, 240) === null) errors.push(`${item.label} 이동 시간은 1분 이상 240분 이하로 입력해 주세요.`);
      }
    }
    for (const [index, busy] of extraBusy.entries()) {
      if (busy.title.trim().length === 0) errors.push(`추가 바쁨 ${index + 1}의 이름을 입력해 주세요.`);
      validateInterval(`추가 바쁨 ${index + 1}`, busy, errors);
    }
    if (!confirmed) errors.push('검토 내용을 확인했다는 체크가 필요합니다.');
    if (!workspace || !source || !selectedTarget || parsedTravel === null || parsedPrepDuration === null || !confirmed || errors.length > 0) {
      return { ok: false, errors, warnings };
    }
    const request: NoticeRecoveryRequest = {
      requestId: '',
      baseRevision: workspace.revision,
      baseSourceRevision: workspace.sourceRevision,
      sourceId,
      targetItemId,
      targetBefore,
      targetAfter,
      preparation: {
        itemId: prepMode === 'existing' ? prepItemId : null,
        title: prepMode === 'existing' ? selectedPreparation?.label ?? '' : newPrepTitle.trim(),
        before: prepBefore,
        durationMinutes: parsedPrepDuration,
        deadline: prepDeadline,
      },
      travelMinutes: parsedTravel,
      horizon: { start: horizonStart, end: horizonEnd },
      workWindows: workWindows.map(({ label, start, end }) => ({ label: label.trim(), start, end })),
      commitments: commitmentRows.map(({ item }) => {
        const draft = commitmentFor(commitments, item.id);
        return {
          itemId: item.id,
          interval: { start: draft.start, end: draft.end },
          movableWindow: draft.movable.enabled ? {
            start: draft.movable.start,
            end: draft.movable.end,
            durationMinutes: Number(draft.movable.durationMinutes),
          } : null,
        };
      }),
      extraBusy: extraBusy.map(({ title, start, end }) => ({ title: title.trim(), interval: { start, end } })),
      confirmed: true,
    };
    const parsed = noticeRecoveryRequestSchema.safeParse({ ...request, requestId: '00000000-0000-4000-8000-000000000001' });
    if (!parsed.success) return { ok: false, errors: [parsed.error.issues[0]?.message ?? '일정 조정 요청 형식이 올바르지 않습니다.'], warnings };
    return { ok: true, request, warnings };
  }

  if (loading) {
    return (
      <main className="notice-recovery" aria-busy="true">
        <section className="notice-recovery__shell">
          <p className="notice-recovery__eyebrow">일정 조정 준비</p>
          <h1>원문과 현재 계획을 불러오는 중입니다.</h1>
        </section>
      </main>
    );
  }

  if (!workspace) {
    return (
      <main className="notice-recovery">
        <section className="notice-recovery__shell">
          <p className="notice-recovery__eyebrow">일정 조정 준비</p>
          <h1>이 작업 공간에서 일정 조정을 시작할 수 없습니다.</h1>
          {message ? <p className="notice-recovery__alert" role="alert">{message}</p> : null}
        </section>
      </main>
    );
  }

  return (
    <main className="notice-recovery">
      <section className="notice-recovery__shell">
        <nav className="notice-recovery__nav" aria-label="일정 설정 화면 이동"><Link to={`/app/workspaces/${encodeURIComponent(workspaceId)}`}>← 원래 작업 공간으로</Link></nav>
        <div className="notice-recovery__hero">
          <div>
            <p className="notice-recovery__eyebrow">안내문에서 일정 조정으로 연결</p>
            <h1>바뀐 일정에 맞춰, 준비할 시간까지 확인해요.</h1>
            <p>안내문에서 정리한 일정과 원문 근거를 가져왔어요. 준비·이동 시간과 지켜야 할 약속을 직접 확인하면, 가능한 새 일정을 계산해요. 모든 시간은 한국 시간 기준이에요.</p>
          </div>
          <aside className="notice-recovery__workspace-card" aria-label="출처 작업 공간">
            <strong>{workspace.title}</strong>
            <span>계획 버전 {workspace.revision} · 원문 버전 {workspace.sourceRevision}</span>
            <span>{latestRunMode === 'live' ? 'AI로 정리한 내 안내문' : latestRunMode === 'fixture' ? '체험용 예시 원문' : '사용자 저장 원문'}</span>
            <AccountLink />
          </aside>
        </div>

        {message ? <p className="notice-recovery__alert" role="alert">{message}</p> : null}

        <form className="notice-recovery__form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <Step number="1" title="원문과 일정 선택" description="현재 계획에 저장된 최신 원문 근거와 바뀐 일정을 연결합니다. 이미 정정·대체된 이전 원문은 고르지 않습니다." defaultOpen>
            <label className="notice-field">
              <span>근거 원문</span>
              <select value={sourceId} onChange={(event) => changeSource(event.currentTarget.value)}>
                <option value="">원문 선택</option>
                {selectableSources.map((entry) => <option key={entry.id} value={entry.id}>{entry.title || entry.id}</option>)}
              </select>
            </label>
            {source ? <SourcePreview source={source} /> : <p className="notice-recovery__hint">기준이 될 원문이 필요해요. 원래 작업 공간에서 안내문을 먼저 저장해 주세요.</p>}

            <fieldset className="notice-choice-list">
              <legend>바뀐 일정</legend>
              {scheduleItems.map(({ item, blockTitle }) => {
                const reason = blockedReason(item);
                return (
                  <label key={item.id} className="notice-choice" data-disabled={reason ? 'true' : 'false'}>
                    <input type="radio" name="target" value={item.id} checked={targetItemId === item.id} disabled={Boolean(reason)} onChange={() => chooseTarget(item.id)} />
                    <span>
                      <strong>{item.label}</strong>
                      <small>{blockTitle} · {item.value}</small>
                      {reason ? <em>{reason}</em> : null}
                    </span>
                  </label>
                );
              })}
            </fieldset>

            {selectedTarget ? (
              <div className="notice-recovery__evidence">
                <h3>현재 사실과 원문 인용</h3>
                {selectedTargetFacts.length > 0 ? selectedTargetFacts.map((fact) => (
                  <article key={fact.id}>
                    <strong>{fact.label}</strong>
                    <p>{String(fact.value)}</p>
                    <blockquote>{fact.evidence.quote}</blockquote>
                  </article>
                )) : <p>이 일정과 연결된 저장 사실이 없습니다.</p>}
              </div>
            ) : null}

            <div className="notice-recovery__two">
              <IntervalFields label="기존 일정 시간" value={targetBefore} onChange={(field, value) => updateNamedInterval('targetBefore', setTargetBefore, targetBefore, field, value)} />
              <IntervalFields label="변경된 일정 시간" value={targetAfter} onChange={(field, value) => updateNamedInterval('targetAfter', setTargetAfter, targetAfter, field, value)} suggestions={dateSuggestions} provenance={{ start: prefillNotes['targetAfter.start'] }} />
            </div>
          </Step>

          <Step number="2" title="준비·이동·다른 일정 확인" description="준비 업무와 이동 시간은 사용자가 확인한 값만 보냅니다. 다른 일정은 기본적으로 고정이며, 하나만 명시한 범위 안에서 이동할 수 있습니다.">
            <fieldset className="notice-segment">
              <legend>준비 작업</legend>
              <label><input type="radio" checked={prepMode === 'existing'} onChange={() => choosePreparationMode('existing')} /> 기존 체크리스트 사용</label>
              <label><input type="radio" checked={prepMode === 'new'} onChange={() => choosePreparationMode('new')} /> 새 준비 작업 만들기</label>
            </fieldset>

            {prepMode === 'existing' ? (
              <fieldset className="notice-choice-list">
                <legend>기존 준비 항목</legend>
                {preparationItems.map(({ item, blockTitle }) => {
                  const reason = blockedReason(item);
                  return (
                    <label key={item.id} className="notice-choice" data-disabled={reason ? 'true' : 'false'}>
                      <input type="radio" name="preparation" value={item.id} checked={prepItemId === item.id} disabled={Boolean(reason)} onChange={() => chooseExistingPreparation(item.id)} />
                      <span>
                        <strong>{item.label}</strong>
                        <small>{blockTitle} · {item.value}</small>
                        {item.preparation ? <small>저장된 준비: {item.preparation.durationMinutes ?? '시간 없음'}분 · {item.preparation.dueDate ?? '마감일 없음'}</small> : null}
                        {reason ? <em>{reason}</em> : null}
                      </span>
                    </label>
                  );
                })}
              </fieldset>
            ) : (
              <label className="notice-field">
                <span>새 준비 작업 제목</span>
                <input value={newPrepTitle} maxLength={120} onChange={(event) => { resetConfirmation(); setNewPrepTitle(event.currentTarget.value); }} />
              </label>
            )}

            <div className="notice-recovery__two">
              <IntervalFields label="준비 기존 시간" value={prepBefore} onChange={(field, value) => updateNamedInterval('prepBefore', setPrepBefore, prepBefore, field, value)} />
            </div>
            <div className="notice-recovery__three">
              <label className="notice-field">
                <span>준비 시간(분)</span>
                <input aria-label="준비 시간(분)" aria-describedby={prefillNotes.prepDurationMinutes ? "notice-prep-duration-evidence" : undefined} type="number" min={1} max={240} inputMode="numeric" value={prepDurationMinutes} onChange={(event) => { markTouched('prepDurationMinutes'); resetConfirmation(); setPrepDurationMinutes(event.currentTarget.value); }} />
                <ProvenanceNote id="notice-prep-duration-evidence" note={prefillNotes.prepDurationMinutes} />
              </label>
              <div className="notice-field">
                <label>
                  <span>준비 마감</span>
                  <input aria-label="준비 마감" aria-describedby={prepDeadlineEvidenceIds} type="datetime-local" value={prepDeadline} onChange={(event) => { markTouched('prepDeadline'); resetConfirmation(); setPrepDeadline(event.currentTarget.value); }} />
                </label>
                <PrepDeadlineSuggestions suggestions={prepDeadlineSuggestions} onSelect={choosePrepDeadlineSuggestion} />
                <ProvenanceNote id="notice-prep-deadline-evidence" note={prefillNotes.prepDeadline} prefix="입력 근거" />
                <ProvenanceNote id="notice-prep-due-evidence" note={prefillNotes.prepDueDate} prefix="참고" />
              </div>
              <label className="notice-field">
                <span>일정 직전 이동(분)</span>
                <input type="number" min={1} max={240} inputMode="numeric" value={travelMinutes} onChange={(event) => { resetConfirmation(); setTravelMinutes(event.currentTarget.value); }} />
              </label>
            </div>
            {oldTravelSentence ? <p className="notice-recovery__calculation"><Clock3 size={16} aria-hidden="true" /> {oldTravelSentence}</p> : null}

            <section className="notice-subsection" aria-labelledby="commitments-title">
              <h3 id="commitments-title">다른 일정 확인</h3>
              {scheduleItems.filter(({ item }) => item.id !== targetItemId).map(({ item }) => {
                const draft = commitmentFor(commitments, item.id);
                const protectedReason = blockedReason(item);
                return (
                  <article key={item.id} className="notice-commitment">
                    <div>
                      <strong>{item.label}</strong>
                      <small>{protectedReason ? `고정 처리 · ${protectedReason}` : '기본 고정'}</small>
                    </div>
                    <IntervalFields label={`${item.label} 시간`} value={draft} compact onChange={(field, value) => updateCommitment(item.id, { [field]: value } as Partial<CommitmentDraft>)} />
                    <label className="notice-check">
                      <input type="checkbox" checked={draft.movable.enabled} disabled={Boolean(protectedReason)} onChange={(event) => updateMovable(item.id, { enabled: event.currentTarget.checked })} />
                      정해진 범위 안에서 이동 가능
                    </label>
                    {draft.movable.enabled ? (
                      <div className="notice-recovery__three">
                        <label className="notice-field">
                          <span>이동 범위 시작</span>
                          <input type="datetime-local" value={draft.movable.start} onChange={(event) => updateMovable(item.id, { start: event.currentTarget.value })} />
                        </label>
                        <label className="notice-field">
                          <span>이동 범위 끝</span>
                          <input type="datetime-local" value={draft.movable.end} onChange={(event) => updateMovable(item.id, { end: event.currentTarget.value })} />
                        </label>
                        <label className="notice-field">
                          <span>필요 시간(분)</span>
                          <input type="number" min={1} max={240} value={draft.movable.durationMinutes} onChange={(event) => updateMovable(item.id, { durationMinutes: event.currentTarget.value })} />
                        </label>
                      </div>
                    ) : null}
                  </article>
                );
              })}
            </section>
          </Step>

          <Step number="3" title="가용 시간과 확인" description="계획할 날짜를 선택하고, 그 시각부터 최대 48시간 안에서 쓸 수 있는 시간을 알려 주세요. 다음 주 일정도 선택할 수 있습니다.">
            <div className="notice-recovery__two">
              <label className="notice-field">
                <span>계획 기준 시간</span>
                <input type="datetime-local" value={horizonStart} onChange={(event) => { resetConfirmation(); setHorizonStart(event.currentTarget.value); }} />
              </label>
              <label className="notice-field">
                <span>조정 범위 끝</span>
                <input type="datetime-local" value={horizonEnd} onChange={(event) => { resetConfirmation(); setHorizonEnd(event.currentTarget.value); }} />
              </label>
            </div>

            <DynamicList title="가용 시간" actionLabel="가용 시간 추가" onAdd={addWorkWindow}>
              {workWindows.map((window) => (
                <article key={window.id} className="notice-dynamic-row">
                  <label className="notice-field"><span>이름</span><input value={window.label} onChange={(event) => updateWorkWindow(window.id, { label: event.currentTarget.value })} /></label>
                  <IntervalFields label="시간" value={window} compact onChange={(field, value) => updateWorkWindow(window.id, { [field]: value } as Partial<WorkWindowDraft>)} />
                  <button type="button" className="notice-icon-button" aria-label="가용 시간 삭제" onClick={() => removeWorkWindow(window.id)}><Trash2 size={17} /></button>
                </article>
              ))}
            </DynamicList>

            <DynamicList title="추가 바쁨" actionLabel="추가 바쁨 입력" onAdd={addExtraBusy}>
              {extraBusy.map((busy) => (
                <article key={busy.id} className="notice-dynamic-row">
                  <label className="notice-field"><span>제목</span><input value={busy.title} onChange={(event) => updateExtraBusy(busy.id, { title: event.currentTarget.value })} /></label>
                  <IntervalFields label="시간" value={busy} compact onChange={(field, value) => updateExtraBusy(busy.id, { [field]: value } as Partial<ExtraBusyDraft>)} />
                  <button type="button" className="notice-icon-button" aria-label="추가 바쁨 삭제" onClick={() => removeExtraBusy(busy.id)}><Trash2 size={17} /></button>
                </article>
              ))}
            </DynamicList>

            <section className="notice-review" aria-labelledby="notice-review-title">
              <h3 id="notice-review-title">확인 요약</h3>
              <ul>
                <li><ShieldCheck size={16} aria-hidden="true" /> 원래 작업 공간은 보존하고 별도 일정 조정 작업 공간을 만듭니다.</li>
                <li><FileText size={16} aria-hidden="true" /> 원문 인용과 사용자가 확인한 조건은 분리되어 저장됩니다.</li>
                <li><LockKeyhole size={16} aria-hidden="true" /> 잠금·완료·직접 수정·확인 필요 항목은 조정 대상으로 쓰지 않습니다.</li>
                {prefilledCount > 0 ? <li><CheckCircle2 size={16} aria-hidden="true" /> 저장된 근거와 준비 설정에서 {prefilledCount}개 값을 미리 채웠습니다. 필요한 값은 수정한 뒤 확인하면 됩니다.</li> : null}
              </ul>
              {review.ok ? <p className="notice-review__ready"><CheckCircle2 size={16} aria-hidden="true" /> 확인한 조건으로 새 일정을 계산할 준비가 됐습니다.</p> : (
                <div className="notice-review__errors" role="alert">
                  <AlertTriangle size={17} aria-hidden="true" />
                  <div>
                    <strong>아직 확인할 값이 있습니다.</strong>
                    <ul>{review.errors.slice(0, 6).map((error) => <li key={error}>{error}</li>)}</ul>
                  </div>
                </div>
              )}
              <label className="notice-confirm">
                <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.currentTarget.checked)} />
                위 시간, 준비 조건, 다른 일정, 가용 시간을 내가 확인했습니다.
              </label>
            </section>

            <div className="notice-actions">
              <button type="button" className="notice-secondary" onClick={() => { resetConfirmation(); setHorizonStart(kstNowMinute()); }}>
                <RotateCcw size={17} aria-hidden="true" /> 기준 시간 새로 고침
              </button>
              <button type="submit" disabled={submitting || !review.ok}>일정 조정 작업 공간 만들기</button>
            </div>
          </Step>
        </form>
      </section>
    </main>
  );
}

function Step(props: { number: string; title: string; description: string; defaultOpen?: boolean; children: ReactNode }) {
  return (
    <details className="notice-step" open={props.defaultOpen}>
      <summary className="notice-step__head">
        <span>{props.number}</span>
        <div>
          <h2 id={`notice-step-${props.number}`}>{props.title}</h2>
          <p>{props.description}</p>
        </div>
      </summary>
      <div className="notice-step__body">{props.children}</div>
    </details>
  );
}

function SourcePreview({ source }: { source: Source }) {
  const text = source.text.length > 900 ? `${source.text.slice(0, 900)}...` : source.text;
  return (
    <details className="notice-source-preview">
      <summary><ChevronDown size={16} aria-hidden="true" /> 원문 보기 · {source.title || source.id}</summary>
      <p>{text}</p>
    </details>
  );
}

function IntervalFields(props: {
  label: string;
  value: IntervalDraft;
  compact?: boolean;
  suggestions?: NoticeDateSuggestion[];
  provenance?: Partial<Record<keyof IntervalDraft, Provenance>>;
  onChange: (field: keyof IntervalDraft, value: string) => void;
}) {
  const evidenceId = useId();
  return (
    <div className={props.compact ? 'notice-interval compact' : 'notice-interval'}>
      <span>{props.label}</span>
      <label>
        시작
        <input aria-label="시작" aria-describedby={props.provenance?.start ? `${evidenceId}-start` : undefined} type="datetime-local" value={props.value.start} onChange={(event) => props.onChange('start', event.currentTarget.value)} />
        <ProvenanceNote id={`${evidenceId}-start`} note={props.provenance?.start} />
      </label>
      <label>
        끝
        <input aria-label="끝" aria-describedby={props.provenance?.end ? `${evidenceId}-end` : undefined} type="datetime-local" value={props.value.end} onChange={(event) => props.onChange('end', event.currentTarget.value)} />
        <ProvenanceNote id={`${evidenceId}-end`} note={props.provenance?.end} />
      </label>
      {props.suggestions && props.suggestions.length > 0 ? (
        <div className="notice-suggestions" aria-label={`${props.label} 제안`}>
          {props.suggestions.slice(0, 4).map((suggestion) => (
            <button key={suggestion.id} type="button" onClick={() => props.onChange('start', suggestion.value)}>
              {suggestion.label} {suggestion.value}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ProvenanceNote({ id, note, prefix = '자동 채움' }: { id?: string; note?: Provenance; prefix?: string }) {
  if (!note) return null;
  return <small id={id} className="notice-provenance">{prefix} · {note.label}<span>{note.detail}</span></small>;
}

function PrepDeadlineSuggestions(props: { suggestions: NoticeDateSuggestion[]; onSelect: (suggestion: NoticeDateSuggestion) => void }) {
  if (props.suggestions.length === 0) return null;
  return (
    <div className="notice-suggestions" role="group" aria-label="준비 마감 제안">
      {props.suggestions.slice(0, 4).map((suggestion) => (
        <button key={suggestion.id} type="button" onClick={() => props.onSelect(suggestion)}>
          마감으로 입력: {suggestion.label} {suggestion.value}
        </button>
      ))}
    </div>
  );
}

function DynamicList(props: { title: string; actionLabel: string; onAdd: () => void; children: ReactNode }) {
  return (
    <section className="notice-subsection">
      <div className="notice-subsection__head">
        <h3>{props.title}</h3>
        <button type="button" className="notice-secondary" onClick={props.onAdd}><Plus size={16} aria-hidden="true" /> {props.actionLabel}</button>
      </div>
      <div className="notice-dynamic-list">{props.children}</div>
    </section>
  );
}

function defaultSourceId(sources: Source[]): string {
  const disabled = supersededSources(sources);
  return [...sources].reverse().find((source) => !disabled.has(source.id))?.id ?? '';
}

function supersededSources(sources: Source[]): Set<string> {
  return new Set(sources.flatMap((source) => source.targetSourceId && (source.relation === 'correction' || source.relation === 'replacement') ? [source.targetSourceId] : []));
}

function clearNotePrefix(notes: Record<string, Provenance>, prefixes: string[]): Record<string, Provenance> {
  const next = Object.fromEntries(Object.entries(notes).filter(([key]) => !prefixes.some((prefix) => key.startsWith(prefix))));
  return next;
}

function seedCommitments(workspace: WorkspaceView, current: Record<string, CommitmentDraft>): Record<string, CommitmentDraft> {
  const next = { ...current };
  for (const block of workspace.snapshot.blocks) {
    if (block.type !== 'schedule') continue;
    for (const item of block.items) next[item.id] = commitmentFor(next, item.id);
  }
  return next;
}

function commitmentFor(commitments: Record<string, CommitmentDraft>, itemId: string): CommitmentDraft {
  return commitments[itemId] ?? { start: '', end: '', movable: { enabled: false, start: '', end: '', durationMinutes: '' } };
}

function factsForItem(workspace: WorkspaceView, item: BlockItem): Fact[] {
  const keys = new Set(item.factKeys);
  if (item.valueFactKey) keys.add(item.valueFactKey);
  return workspace.snapshot.facts.filter((fact) => keys.has(fact.key));
}

function evidenceMatches(sources: Source[], fact: Fact): boolean {
  const source = sources.find((entry) => entry.id === fact.evidence.sourceId);
  return Boolean(source && source.text.slice(fact.evidence.start, fact.evidence.end) === fact.evidence.quote);
}

function buildPrepDeadlineSuggestions(suggestions: NoticeDateSuggestion[], workspace: WorkspaceView | null, selectedPreparation: BlockItem | null, prepMode: PrepMode): NoticeDateSuggestion[] {
  if (prepMode === 'new') return suggestions;
  if (!workspace || !selectedPreparation) return [];
  const factIds = new Set(factsForItem(workspace, selectedPreparation).flatMap((fact) => [fact.id, fact.key]));
  const dueDate = selectedPreparation.preparation?.dueDate ?? null;
  return suggestions.filter((suggestion) => {
    if (!factIds.has(suggestion.id)) return false;
    return !dueDate || suggestion.value.startsWith(`${dueDate}T`);
  });
}

function blockedReason(item: BlockItem): string | null {
  if (item.locked) return '사용자가 고정한 항목입니다.';
  if (item.completed) return '이미 완료한 항목입니다.';
  if (item.edited) return '직접 수정한 항목입니다.';
  if (item.stale) return '확인 필요 상태입니다.';
  return null;
}

function validateInterval(label: string, value: IntervalDraft, errors: string[]) {
  if (!isLocalMinute(value.start) || !isLocalMinute(value.end)) {
    errors.push(`${label}의 시작과 끝 날짜·시간을 확인해 주세요.`);
    return;
  }
  if (compareLocal(value.start, value.end) >= 0) errors.push(`${label}의 끝은 시작보다 늦어야 합니다.`);
}

function parseBoundedNumber(value: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(value.trim())) return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max ? number : null;
}

function isLocalMinute(value: string): boolean {
  if (!LOCAL_MINUTE_PATTERN.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const hour = Number(value.slice(11, 13));
  const minute = Number(value.slice(14, 16));
  if (hour > 23 || minute > 59) return false;
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day && date.getUTCHours() === hour && date.getUTCMinutes() === minute;
}

function compareLocal(left: string, right: string): number {
  return left.localeCompare(right);
}

function minutesBetween(start: string, end: string): number {
  const toMinutes = (value: string) => Date.UTC(Number(value.slice(0, 4)), Number(value.slice(5, 7)) - 1, Number(value.slice(8, 10)), Number(value.slice(11, 13)), Number(value.slice(14, 16))) / 60_000;
  return toMinutes(end) - toMinutes(start);
}

function oldTravelSummary(targetStart: string, travel: string): string | null {
  const minutes = parseBoundedNumber(travel, 1, 240);
  if (!isLocalMinute(targetStart) || minutes === null) return null;
  const travelStart = shiftLocalMinute(targetStart, -minutes);
  return `기존 이동은 확인한 ${minutes}분을 기준으로 ${travelStart}부터 ${targetStart}까지로 계산합니다.`;
}

function shiftLocalMinute(value: string, deltaMinutes: number): string {
  const date = new Date(Date.UTC(Number(value.slice(0, 4)), Number(value.slice(5, 7)) - 1, Number(value.slice(8, 10)), Number(value.slice(11, 13)), Number(value.slice(14, 16))) + deltaMinutes * 60_000);
  const pad = (input: number) => String(input).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

function kstNowMinute(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? '00';
  return `${pick('year')}-${pick('month')}-${pick('day')}T${pick('hour')}:${pick('minute')}`;
}

function cryptoId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `${uuidFallbackPrefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function readJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, { credentials: 'same-origin', ...init });
  const text = await response.text();
  const payload = text ? safeJson(text) : null;
  if (!response.ok) throw readFailure(payload, response.status);
  return payload as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function readFailure(payload: unknown, status: number): ApiFailure {
  if (typeof payload === 'object' && payload && 'error' in payload) {
    const error = (payload as { error?: unknown }).error;
    if (typeof error === 'object' && error && typeof (error as { message?: unknown }).message === 'string') {
      return { code: String((error as { code?: unknown }).code ?? 'REQUEST_FAILED'), message: (error as { message: string }).message, status };
    }
  }
  if (typeof payload === 'object' && payload && typeof (payload as { message?: unknown }).message === 'string') {
    return { code: String((payload as { code?: unknown }).code ?? 'REQUEST_FAILED'), message: (payload as { message: string }).message, status };
  }
  const code = status === 401 ? 'UNAUTHORIZED' : status === 404 ? 'WORKSPACE_NOT_FOUND' : status === 409 ? 'STALE_REVISION' : 'REQUEST_FAILED';
  return { code, message: statusMessage(code), status };
}

function statusMessage(code: string): string {
  if (code === 'UNAUTHORIZED') return '로그인 또는 게스트 권한이 만료되었습니다. 같은 작업 공간 권한으로 다시 열어 주세요.';
  if (code === 'WORKSPACE_NOT_FOUND') return '작업 공간을 찾을 수 없습니다. 삭제됐거나 현재 계정의 작업 공간이 아닙니다.';
  if (code === 'STALE_REVISION') return '원문 또는 계획이 먼저 바뀌었습니다. 최신 작업 공간에서 다시 확인해 주세요.';
  if (code === 'PENDING_CHANGESET') return '검토 중인 변경안이 있습니다. 먼저 적용하거나 취소한 뒤 일정 조정을 시작해 주세요.';
  if (code === 'STALE_WORKSPACE') return '계획이나 원문이 먼저 바뀌었습니다. 최신 작업 공간에서 조건을 다시 확인해 주세요.';
  if (code === 'TARGET_PROTECTED') return '선택한 일정은 보호된 상태입니다. 다른 일정을 선택하거나 보호 상태를 먼저 확인해 주세요.';
  if (code === 'PREPARATION_PROTECTED') return '선택한 준비 항목은 보호된 상태입니다. 다른 준비 항목을 선택하거나 보호 상태를 먼저 확인해 주세요.';
  if (code === 'TOO_MANY_EVENTS') return '일정이 너무 많아 이 화면에서 계산할 수 없습니다. 범위를 줄인 뒤 다시 시도해 주세요.';
  if (code === 'TOO_MANY_MOVABLE_COMMITMENTS') return '이 화면에서는 이동 가능한 기존 업무를 하나만 선택할 수 있습니다.';
  if (code === 'INVALID_NOTICE_RECOVERY_REQUEST') return '확인한 조건 형식이 맞지 않습니다. 입력값을 다시 확인해 주세요.';
  return '요청을 처리하지 못했습니다. 입력은 유지되며 다시 시도할 수 있습니다.';
}

function failureMessage(error: unknown, fallback: string): string {
  if (isApiFailure(error)) return statusMessage(error.code) === statusMessage('REQUEST_FAILED') ? error.message : statusMessage(error.code);
  return fallback;
}

function isApiFailure(error: unknown): error is ApiFailure {
  return typeof error === 'object' && error !== null && typeof (error as { message?: unknown }).message === 'string';
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}
