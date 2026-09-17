import { AlertTriangle, CalendarClock, CheckCircle2, Clock3, FileText, LockKeyhole, Mail, RotateCcw, Save, ShieldCheck } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import AccountLink from '../account/AccountLink';
import { createAnchoredRecoveryExample, createFutureRecoveryExample, createRecoveryExample } from '../../core/schedule-recovery-sample';
import { defaultRecoveryApi, recoveryFailureMessage, type RecoveryApi } from './recovery-api';
import { buildEmailDraft, createLocalRecoveryPlan, createRecoveryInput, defaultRecoveryDraft, draftFromRecoveryInput, invalidateApproval, planFromRecoveryView, planSignature } from './recovery-model';
import type { CalendarConnectionSummary, ExternalActionStatus, PreviewStatus, RecoveryActionView, RecoveryDraft, RecoveryEvent, RecoveryMode, RecoveryPlan, SaveStatus } from './recovery-types';
import type { RecoveryInput } from '../../core/scheduling-contracts';
import './recovery.css';

type RecoveryPageProps = {
  workspaceId?: string;
  api?: RecoveryApi;
};

type RequestState = {
  signature: string;
  requestId: string;
};

type PreviewRequestState = RequestState & {
  recoveryInput: ReturnType<typeof createRecoveryInput>;
};

type EmailFields = {
  recipient: string;
  subject: string;
  body: string;
};
type LocalRecoveryState = { base: RecoveryInput; draft: RecoveryDraft; plan: RecoveryPlan };

const RECOVERY_RETURN_WORKSPACE_KEY = 'ieojim:recovery:returnWorkspaceId';
const EMAIL_RECIPIENT_MAX = 254;
const EMAIL_SUBJECT_MAX = 160;
const EMAIL_BODY_MAX = 4000;
const kindLabels: Record<RecoveryEvent['kind'], string> = {
  fixed: '고정',
  flex: '이동 가능',
  preparation: '준비',
  travel: '이동',
  presentation: '발표',
  busy: '점유',
};

function localRecoveryStateFromNavigation(state: unknown): LocalRecoveryState {
  const anchor = typeof state === 'object' && state !== null && typeof (state as { recoveryAnchor?: unknown }).recoveryAnchor === 'string'
    ? (state as { recoveryAnchor: string }).recoveryAnchor
    : null;
  const base = anchor ? safeAnchoredInput(anchor) : createRecoveryExample();
  const draft = syntheticDefaultDraftFor(base);
  return { base, draft, plan: createLocalRecoveryPlan(draft, false, base) };
}

function safeAnchoredInput(anchor: string): RecoveryInput {
  try {
    return createAnchoredRecoveryExample(anchor);
  } catch {
    return createRecoveryExample();
  }
}

function syntheticDefaultDraftFor(input: RecoveryInput): RecoveryDraft {
  return {
    preparationMinutes: 90,
    submissionDeadline: `${input.change.presentationInterval.start.slice(0, 10)}T10:00`,
    expenseLocked: false,
    availability1430: true,
  };
}

export default function RecoveryPage({ workspaceId, api = defaultRecoveryApi }: RecoveryPageProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const initialLocal = useMemo(() => localRecoveryStateFromNavigation(location.state), [location.state]);
  const [localBaseInput, setLocalBaseInput] = useState<RecoveryInput>(() => initialLocal.base);
  const [mode, setMode] = useState<RecoveryMode>(workspaceId ? 'persisted' : 'local');
  const [draft, setDraft] = useState<RecoveryDraft>(() => initialLocal.draft);
  const [plan, setPlan] = useState<RecoveryPlan>(() => initialLocal.plan);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(workspaceId ?? null);
  const [revision, setRevision] = useState<number | null>(null);
  const [previewStatus, setPreviewStatus] = useState<PreviewStatus>('idle');
  const [loading, setLoading] = useState(Boolean(workspaceId));
  const [loadError, setLoadError] = useState<string | null>(null);
  const [calendar, setCalendar] = useState<CalendarConnectionSummary | null>(null);
  const [calendarLoading, setCalendarLoading] = useState(false);
  const [calendarAuthRequired, setCalendarAuthRequired] = useState(false);
  const [adoptCalendarId, setAdoptCalendarId] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [saveRequest, setSaveRequest] = useState<RequestState | null>(null);
  const [previewRequest, setPreviewRequest] = useState<PreviewRequestState | null>(null);
  const [approveRequest, setApproveRequest] = useState<RequestState | null>(null);
  const [calendarRequest, setCalendarRequest] = useState<RequestState | null>(null);
  const [emailRequest, setEmailRequest] = useState<RequestState | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [emailFields, setEmailFields] = useState<EmailFields>(() => {
    const draftEmail = buildEmailDraft(createLocalRecoveryPlan(defaultRecoveryDraft));
    return { recipient: draftEmail.recipient, subject: draftEmail.title, body: draftEmail.body };
  });
  const [emailTouched, setEmailTouched] = useState(false);
  const [emailExactApproved, setEmailExactApproved] = useState(false);
  const requestTokenRef = useRef(0);
  const previewTokenRef = useRef(0);
  const latestDraftSignatureRef = useRef(planSignature(defaultRecoveryDraft));

  useEffect(() => {
    if (workspaceId) return;
    const params = new URLSearchParams(location.search);
    if (!params.has('calendar')) return;
    const returnWorkspaceId = window.sessionStorage.getItem(RECOVERY_RETURN_WORKSPACE_KEY);
    if (!returnWorkspaceId) return;
    window.sessionStorage.removeItem(RECOVERY_RETURN_WORKSPACE_KEY);
    navigate(`/recovery/${encodeURIComponent(returnWorkspaceId)}${location.search}`, { replace: true });
  }, [location.search, navigate, workspaceId]);

  useEffect(() => {
    setActiveWorkspaceId(workspaceId ?? null);
    if (!workspaceId) {
      setMode('local');
      setRevision(null);
      return;
    }
    const controller = new AbortController();
    const token = requestTokenRef.current + 1;
    requestTokenRef.current = token;
    setLoading(true);
    setLoadError(null);
    setMessage(null);
    api.loadWorkspaceRecovery(workspaceId, controller.signal).then((payload) => {
      if (requestTokenRef.current !== token) return;
      setMode('persisted');
      setRevision(payload.revision);
      const nextPlan = planFromRecoveryView(payload);
      setDraft(nextPlan.draft);
      latestDraftSignatureRef.current = planSignature(nextPlan.draft);
      setPlan(nextPlan);
      setPreviewStatus('idle');
      setMessage('저장된 계획을 기준으로 일정 조정안을 다시 계산해 불러왔어요.');
    }).catch((error) => {
      if (requestTokenRef.current !== token) return;
      setLoadError(recoveryFailureMessage(error, '저장한 일정 조정안을 불러오지 못했습니다. 다시 접속해 주세요.'));
    }).finally(() => {
      if (requestTokenRef.current === token) setLoading(false);
    });
    return () => {
      controller.abort();
    };
  }, [workspaceId, api]);

  useEffect(() => {
    const controller = new AbortController();
    void refreshCalendarStatus(controller.signal);
    return () => controller.abort();
  }, [api]);

  useEffect(() => {
    if (!activeWorkspaceId || !plan.server?.actions.some((action) => action.status === 'queued' || action.status === 'executing')) return;
    const controller = new AbortController();
    const timer = window.setInterval(() => {
      api.loadWorkspaceRecovery(activeWorkspaceId, controller.signal).then((payload) => {
        const nextPlan = planFromRecoveryView(payload);
        setPlan((current) => {
          if (current.server && planSignature(current.draft) !== planSignature(draftFromRecoveryInput(current.server.input))) {
            return { ...current, server: { ...current.server, actions: payload.actions }, external: nextPlan.external };
          }
          setRevision(payload.revision);
          setDraft(nextPlan.draft);
          latestDraftSignatureRef.current = planSignature(nextPlan.draft);
          return nextPlan;
        });
      }).catch((error) => {
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          setMessage(recoveryFailureMessage(error, '외부 처리 기록을 다시 확인하지 못했습니다.'));
        }
      });
    }, 3_000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [activeWorkspaceId, api, plan.server?.actions]);

  const emailDraft = useMemo(() => buildEmailDraft(plan), [plan]);
  useEffect(() => {
    if (emailTouched) return;
    setEmailFields({ recipient: emailDraft.recipient, subject: emailDraft.title, body: emailDraft.body });
  }, [emailDraft, emailTouched]);

  const baselineDraftSignature = plan.server ? planSignature(draftFromRecoveryInput(plan.server.input)) : null;
  const isDirty = Boolean(plan.server && baselineDraftSignature && planSignature(draft) !== baselineDraftSignature);
  const isRequestBusy = loading || saveStatus === 'saving' || previewStatus === 'previewing' || busyAction !== null;
  const canApprove = plan.feasible && !plan.approval.approved && !isRequestBusy;
  const canSave = mode === 'local' && plan.feasible && !isRequestBusy;
  const canPreviewPersisted = Boolean(activeWorkspaceId && revision !== null && plan.server && isDirty && !isRequestBusy);
  const canApprovePersisted = Boolean(activeWorkspaceId && revision !== null && plan.server && plan.feasible && !plan.approval.approved && !isDirty && !isRequestBusy);
  const canQueueCalendar = Boolean(activeWorkspaceId && revision !== null && plan.server && plan.approval.approved && plan.feasible && !isDirty && !isRequestBusy && calendar?.status === 'connected' && plan.external.calendar !== 'pending' && plan.external.calendar !== 'applied');
  const hasGmailScope = Boolean(calendar?.scopes.includes('https://www.googleapis.com/auth/gmail.send'));
  const emailValidation = validateEmailFields(emailFields);
  const canQueueEmail = Boolean(activeWorkspaceId && revision !== null && plan.server && plan.approval.approved && plan.feasible && !isDirty && !isRequestBusy && hasGmailScope && emailExactApproved && emailValidation.ok && plan.external.email !== 'pending' && plan.external.email !== 'applied');
  const activeDateLabels = recoveryDateLabels(plan.input);
  const origin = plan.server?.origin;

  function updateDraft(updates: Partial<RecoveryDraft>) {
    if (isRequestBusy || origin) return;
    const nextDraft = { ...draft, ...updates };
    setDraft(nextDraft);
    if (mode === 'persisted' && plan.server) {
      const overlay = invalidateApproval(createLocalRecoveryPlan(nextDraft, false, plan.server.input), '직접 확인한 조건을 수정했어요. 다시 계산해야 적용할 수 있습니다.');
      setPlan({ ...overlay, synthetic: false, server: plan.server });
      setPreviewStatus('dirty');
      setPreviewRequest(null);
      setMessage('직접 확인한 조건이 바뀌었어요. 저장된 계획에서 다시 계산한 뒤 적용할 수 있습니다.');
    } else {
      const nextPlan = invalidateApproval(createLocalRecoveryPlan(nextDraft, false, localBaseInput), '직접 확인한 조건이 바뀌어 이전 적용과 외부 처리 기록을 다시 확인해야 합니다.');
      setPlan(nextPlan);
      setMode('local');
      setRevision(null);
      setPreviewStatus('idle');
      setMessage('직접 확인한 조건이 바뀌었어요. 적용 여부와 외부 처리 기록을 다시 확인해야 합니다.');
    }
    setSaveStatus('idle');
    setEmailExactApproved(false);
    latestDraftSignatureRef.current = planSignature(nextDraft);
  }

  async function previewPersistedPlan() {
    if (!activeWorkspaceId || revision === null || !plan.server || !canPreviewPersisted) return;
    const currentDraftSignature = planSignature(draft);
    const recoveryInput = createRecoveryInput(draft, plan.server.input);
    const signature = JSON.stringify({ workspaceId: activeWorkspaceId, baseRevision: revision, conditionRevision: plan.server.conditionRevision, draft: currentDraftSignature });
    const request = previewRequest?.signature === signature ? previewRequest : { signature, requestId: crypto.randomUUID(), recoveryInput };
    setPreviewRequest(request);
    setPreviewStatus('previewing');
    setMessage('저장된 계획에서 바뀐 조건을 다시 확인하고 있어요.');
    const token = previewTokenRef.current + 1;
    previewTokenRef.current = token;
    try {
      const response = await api.previewPlan({
        workspaceId: activeWorkspaceId,
        requestId: request.requestId,
        recoveryInput: request.recoveryInput,
        baseRevision: revision,
        conditionRevision: plan.server.conditionRevision,
      });
      if (previewTokenRef.current !== token || latestDraftSignatureRef.current !== currentDraftSignature) return;
      const serverPlan = planFromRecoveryView(response);
      if (planSignature(serverPlan.draft) !== currentDraftSignature) return;
      setRevision(response.revision);
      setDraft(serverPlan.draft);
      latestDraftSignatureRef.current = planSignature(serverPlan.draft);
      setPlan(serverPlan);
      setPreviewStatus('idle');
      setPreviewRequest(null);
      setMessage('바뀐 조건을 저장된 계획 기준으로 다시 계산했어요.');
    } catch (error) {
      if (previewTokenRef.current !== token) return;
      setPreviewStatus('failed');
      setMessage(recoveryFailureMessage(error, '저장된 계획에서 조건을 다시 확인하지 못했습니다. 화면의 미리보기 계산은 저장되지 않았습니다.'));
    }
  }

  function resetDraft() {
    updateDraft(syntheticDefaultDraftFor(mode === 'persisted' && plan.server ? plan.server.input : localBaseInput));
  }

  function startFuturePreview() {
    if (isRequestBusy) return;
    const base = createFutureRecoveryExample();
    const nextDraft = draftFromRecoveryInput(base);
    const nextPlan = createLocalRecoveryPlan(nextDraft, false, base);
    const draftEmail = buildEmailDraft(nextPlan);
    setLocalBaseInput(base);
    setMode('local');
    setActiveWorkspaceId(null);
    setRevision(null);
    setDraft(nextDraft);
    setPlan(nextPlan);
    setPreviewStatus('idle');
    setLoading(false);
    setSaveStatus('idle');
    setSaveRequest(null);
    setPreviewRequest(null);
    setApproveRequest(null);
    setCalendarRequest(null);
    setEmailRequest(null);
    setBusyAction(null);
    setEmailTouched(false);
    setEmailExactApproved(false);
    setEmailFields({ recipient: draftEmail.recipient, subject: draftEmail.title, body: draftEmail.body });
    latestDraftSignatureRef.current = planSignature(nextDraft);
    requestTokenRef.current += 1;
    previewTokenRef.current += 1;
    setMessage('다음 미래 목·금 기준의 새 체험용 미리보기를 열었어요. 저장 전까지 기존 작업 공간은 바뀌지 않습니다.');
    navigate('/recovery', { state: { recoveryAnchor: base.now } });
  }

  function approveLocalPlan() {
    if (!canApprove) return;
    setPlan((current) => ({ ...current, approval: { approved: true, approvedAt: new Date().toISOString(), invalidatedReason: null } }));
    setMessage('미리보기에서만 일정 조정안을 적용했어요. 외부 반영은 저장과 연결 후 따로 확인해야 합니다.');
  }

  async function saveWorkspace() {
    if (!canSave) return;
    const signature = planSignature(draft);
    const requestId = saveRequest?.signature === signature ? saveRequest.requestId : crypto.randomUUID();
    setSaveRequest({ signature, requestId });
    latestDraftSignatureRef.current = signature;
    setSaveStatus('saving');
    setMessage(null);
    const controller = new AbortController();
    try {
      const response = await api.createWorkspace({ requestId, recoveryInput: plan.input }, controller.signal);
      if (latestDraftSignatureRef.current !== signature) return;
      const nextPlan = planFromRecoveryView(response);
      setMode('persisted');
      setActiveWorkspaceId(response.workspaceId);
      setRevision(response.revision);
      setDraft(nextPlan.draft);
      latestDraftSignatureRef.current = planSignature(nextPlan.draft);
      setPlan(nextPlan);
      setSaveStatus('saved');
      setMessage(`작업 공간 ${response.workspaceId}에 저장했어요. 저장된 계획 기준으로 표시합니다.`);
      navigate(`/recovery/${encodeURIComponent(response.workspaceId)}`);
    } catch (error) {
      setSaveStatus('failed');
      setMessage(recoveryFailureMessage(error, '저장하지 못했습니다. 입력은 화면에 그대로 보존했습니다.'));
    }
  }

  async function approvePersistedPlan() {
    if (!activeWorkspaceId || revision === null || !plan.server || !canApprovePersisted) return;
    const signature = JSON.stringify({ workspaceId: activeWorkspaceId, revision, conditionRevision: plan.server.conditionRevision, proposalId: plan.server.proposalId });
    const draftSignature = planSignature(draft);
    const requestId = approveRequest?.signature === signature ? approveRequest.requestId : crypto.randomUUID();
    setApproveRequest({ signature, requestId });
    setBusyAction('approve');
    setMessage(null);
    try {
      const response = await api.applyPlan({ workspaceId: activeWorkspaceId, proposalId: plan.server.proposalId, baseRevision: revision, conditionRevision: plan.server.conditionRevision, requestId });
      if (latestDraftSignatureRef.current !== draftSignature) return;
      const nextPlan = planFromRecoveryView(response);
      setRevision(response.revision);
      setDraft(nextPlan.draft);
      latestDraftSignatureRef.current = planSignature(nextPlan.draft);
      setPlan(nextPlan);
      setMessage('저장된 계획과 일치하는 일정 조정안을 적용했어요. Calendar 반영은 연결 상태를 확인한 뒤 따로 실행합니다.');
    } catch (error) {
      setMessage(recoveryFailureMessage(error, '적용하지 못했습니다. 최신 일정 조정안을 다시 확인해 주세요.'));
    } finally {
      setBusyAction(null);
    }
  }

  async function refreshCalendarStatus(signal?: AbortSignal) {
    setCalendarLoading(true);
    try {
      const status = await api.calendarStatus(signal);
      setCalendar(status);
      setCalendarAuthRequired(false);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        if (isUnauthorized(error)) {
          setCalendar(null);
          setCalendarAuthRequired(true);
        } else {
          setMessage(recoveryFailureMessage(error, 'Calendar 연결 상태를 확인하지 못했습니다.'));
        }
      }
    } finally {
      setCalendarLoading(false);
    }
  }

  async function connectCalendar(includeEmail = false) {
    try {
      if (activeWorkspaceId) window.sessionStorage.setItem(RECOVERY_RETURN_WORKSPACE_KEY, activeWorkspaceId);
      const response = includeEmail ? await api.connectEmail() : await api.connectCalendar({ includeEmail: false });
      window.location.assign(response.url);
    } catch (error) {
      setMessage(recoveryFailureMessage(error, includeEmail ? 'Gmail 권한 연결을 시작하지 못했습니다.' : 'Calendar 연결을 시작하지 못했습니다.'));
    }
  }

  async function bootstrapCalendar() {
    setCalendarLoading(true);
    setBusyAction('calendar-bootstrap');
    try {
      const response = await api.bootstrapCalendar();
      setCalendar(response);
      setMessage(response.created ? '이어짐 전용 Calendar를 만들었습니다.' : '이미 준비된 이어짐 Calendar를 확인했습니다.');
    } catch (error) {
      setMessage(recoveryFailureMessage(error, '이어짐 전용 Calendar를 준비하지 못했습니다.'));
    } finally {
      setCalendarLoading(false);
      setBusyAction(null);
    }
  }

  async function adoptCalendar() {
    const calendarId = adoptCalendarId.trim();
    if (!calendarId || calendarId.length > 512) return;
    setCalendarLoading(true);
    setBusyAction('calendar-adopt');
    try {
      const response = await api.adoptCalendar({ calendarId });
      setCalendar(response);
      setAdoptCalendarId('');
      setMessage('확인한 이어짐 Calendar를 연결했습니다.');
    } catch (error) {
      setMessage(recoveryFailureMessage(error, '입력한 Calendar를 이어짐 전용 Calendar로 확인하지 못했습니다.'));
    } finally {
      setCalendarLoading(false);
      setBusyAction(null);
    }
  }

  async function disconnectCalendar() {
    setCalendarLoading(true);
    setBusyAction('calendar-disconnect');
    try {
      const response = await api.disconnectCalendar();
      setCalendar(response);
      setMessage('Calendar 연결을 해제했어요. 아직 처리 중인 외부 작업은 다시 확인이 필요한 상태가 됩니다.');
    } catch (error) {
      setMessage(recoveryFailureMessage(error, 'Calendar 연결을 해제하지 못했습니다.'));
    } finally {
      setCalendarLoading(false);
      setBusyAction(null);
    }
  }

  async function queueCalendar() {
    if (!activeWorkspaceId || revision === null || !plan.server || !canQueueCalendar) return;
    const signature = JSON.stringify({ workspaceId: activeWorkspaceId, revision, conditionRevision: plan.server.conditionRevision, kind: 'calendar' });
    const draftSignature = planSignature(draft);
    const requestId = calendarRequest?.signature === signature ? calendarRequest.requestId : crypto.randomUUID();
    setCalendarRequest({ signature, requestId });
    setBusyAction('calendar');
    setMessage(null);
    try {
      const response = await api.enqueueCalendar({ workspaceId: activeWorkspaceId, baseRevision: revision, conditionRevision: plan.server.conditionRevision, requestId });
      if (latestDraftSignatureRef.current !== draftSignature) return;
      const nextPlan = planFromRecoveryView(response);
      setRevision(response.revision);
      setDraft(nextPlan.draft);
      latestDraftSignatureRef.current = planSignature(nextPlan.draft);
      setPlan(nextPlan);
      setMessage('Calendar 반영 작업을 처리 목록에 넣었어요. 실제로 같은 값이 저장됐는지 확인된 뒤에만 완료로 표시합니다.');
    } catch (error) {
      setMessage(recoveryFailureMessage(error, 'Calendar 적용 작업을 시작하지 못했습니다.'));
    } finally {
      setBusyAction(null);
    }
  }

  async function queueEmail() {
    if (!activeWorkspaceId || revision === null || !plan.server || !canQueueEmail) return;
    const signature = JSON.stringify({ workspaceId: activeWorkspaceId, revision, conditionRevision: plan.server.conditionRevision, kind: 'email', emailFields });
    const draftSignature = planSignature(draft);
    const requestId = emailRequest?.signature === signature ? emailRequest.requestId : crypto.randomUUID();
    setEmailRequest({ signature, requestId });
    setBusyAction('email');
    setMessage(null);
    try {
      const response = await api.enqueueEmail({ workspaceId: activeWorkspaceId, baseRevision: revision, conditionRevision: plan.server.conditionRevision, requestId, ...emailFields });
      if (latestDraftSignatureRef.current !== draftSignature) return;
      const nextPlan = planFromRecoveryView(response);
      setRevision(response.revision);
      setDraft(nextPlan.draft);
      latestDraftSignatureRef.current = planSignature(nextPlan.draft);
      setPlan(nextPlan);
      setEmailExactApproved(false);
      setMessage('확인한 수신자, 제목, 본문 그대로 이메일 발송 작업을 처리 목록에 넣었어요. 접수는 수신이나 열람을 뜻하지 않습니다.');
    } catch (error) {
      setMessage(recoveryFailureMessage(error, '이메일 발송 작업을 시작하지 못했습니다.'));
    } finally {
      setBusyAction(null);
    }
  }

  if (workspaceId && !plan.server) {
    return (
      <main className="recovery-page" aria-labelledby="recovery-loading-title">
        <nav className="recovery-nav" aria-label="일정 조정 화면 이동"><Link className="recovery-brand" to="/">이어짐 홈</Link><AccountLink /><Link to="/app">내 작업 공간</Link></nav>
        <section className="recovery-board">
          <h1 id="recovery-loading-title">{loadError ? '일정 조정안을 불러오지 못했습니다.' : '저장한 일정 조정안을 확인하고 있습니다.'}</h1>
          <p role={loadError ? 'alert' : 'status'}>{loadError ?? '원문과 계획의 최신 상태를 확인한 뒤 표시합니다.'}</p>
          {loadError ? <button type="button" className="recovery-primary" onClick={() => window.location.reload()}>다시 불러오기</button> : null}
        </section>
      </main>
    );
  }

  return (
    <main className="recovery-page" data-mode={mode} aria-labelledby="recovery-title">
      <nav className="recovery-nav" aria-label="일정 조정 화면 이동">
        <Link className="recovery-brand" to="/">이어짐 홈</Link>
        <AccountLink />
        {activeWorkspaceId ? <Link to={`/app/workspaces/${encodeURIComponent(activeWorkspaceId)}`}>작업 공간</Link> : null}
        {origin ? <Link to={`/app/workspaces/${encodeURIComponent(origin.workspaceId)}`}>원래 안내와 계획</Link> : null}
      </nav>
      <section className="recovery-hero">
        <div className="recovery-hero__copy">
          <p className="recovery-kicker">{origin ? origin.sourceMode === 'fixture' ? '체험용 원문 · 직접 확인한 일정 조정' : '내 안내문 · 일정 조정' : '체험용 예시 · 일정 조정'}</p>
          <h1 id="recovery-title">일정 하나 바뀌었다고, 처음부터 다시 짜지 마세요.</h1>
          <p>
            {origin ? `${origin.title}의 안내와 직접 확인한 시간으로 준비·이동·다른 일정을 함께 조정해요. 원래 안내와 계획은 별도로 남겨 둡니다.` : '금요일 발표가 16시에서 11시로 당겨졌어요. 오전 10시까지 자료도 내야 해요. 다른 약속을 지키면서 준비와 이동 시간을 확보할 수 있을까요? 준비된 데이터로 계산하는 체험이며, AI를 호출하지 않아요.'}
          </p>
          <div className="recovery-hero__badges" aria-label="일정 조정 상태 요약">
            <span><ShieldCheck size={15} aria-hidden="true" /> 고정 약속 변경 0개</span>
            <span><Clock3 size={15} aria-hidden="true" /> 준비 {plan.draft.preparationMinutes}분</span>
            <span data-state={isDirty ? 'dirty' : plan.feasible ? 'ready' : 'blocked'}><FileText size={15} aria-hidden="true" /> {isDirty ? '다시 계산 필요' : plan.feasible ? '조정안 확인됨' : '확인 필요'}</span>
          </div>
          <div className="recovery-hero__actions">
            {!origin ? <button type="button" className="recovery-ghost recovery-future-button" onClick={startFuturePreview} disabled={isRequestBusy}>
              다음 목·금으로 새 체험
            </button> : null}
            <span>{origin ? `${plan.input.horizon.start.replace('T', ' ')}–${plan.input.horizon.end.replace('T', ' ')} · 한국 시간` : `${activeDateLabels.thu} · ${activeDateLabels.fri}`}</span>
            <a className="recovery-inline-link recovery-next-link" href="#recovery-actions-title">조정안 저장·적용으로 이동 ↓</a>
          </div>
        </div>
        <NoticeCard plan={plan} />
      </section>

      {message ? <p className="recovery-message" role={saveStatus === 'failed' || !plan.feasible ? 'alert' : 'status'}>{message}</p> : null}
      {loading ? <p className="recovery-message" role="status">저장한 일정 조정안을 불러오는 중입니다.</p> : null}
      {previewStatus === 'previewing' ? <p className="recovery-message" role="status">변경한 조건을 같은 작업 공간에서 다시 계산하고 있습니다.</p> : null}

      <section className="recovery-grid" aria-label="일정 조정 계획 검토">
        <aside className="recovery-controls" aria-labelledby="recovery-controls-title">
          <div>
            <p className="recovery-kicker">확인된 조건</p>
            <h2 id="recovery-controls-title">지킬 조건과 준비 시간</h2>
          </div>
          <details className="recovery-condition-details">
            <summary>확인된 조건 {plan.confirmedConstraints.length}개 보기</summary>
            <ul className="recovery-constraint-list">
              {plan.confirmedConstraints.map((constraint) => <li key={constraint}>{constraint}</li>)}
            </ul>
          </details>
          {origin ? (
            <div className="recovery-control-stack">
              <p>준비 {plan.input.change.preparationDurationMinutes}분 · 이동 {plan.input.change.travelDurationMinutes}분</p>
              <p>준비 마감 {plan.input.change.preparationDeadline.replace('T', ' ')}</p>
              <p>이 일정 조정안은 저장할 때 직접 확인한 조건으로 계산합니다. 시간을 바꾸려면 원래 안내에서 조건을 다시 확인해 주세요.</p>
              <Link className="recovery-inline-link" to={`/app/workspaces/${encodeURIComponent(origin.workspaceId)}/recovery/setup`}>조건을 다시 확인해 새 조정안 만들기</Link>
            </div>
          ) : <><div className="recovery-control-stack" aria-label="조건을 바꿔 계산해 보기">
            <label>
              준비 시간(분)
              <input type="number" min={1} max={240} step={15} value={draft.preparationMinutes} disabled={isRequestBusy} onChange={(event) => updateDraft({ preparationMinutes: Number(event.currentTarget.value) })} />
            </label>
            <label>
              자료 제출 마감
              <input type="datetime-local" value={draft.submissionDeadline} disabled={isRequestBusy} onChange={(event) => updateDraft({ submissionDeadline: event.currentTarget.value })} />
            </label>
            <label className="recovery-check-row">
              <input type="checkbox" checked={draft.expenseLocked} disabled={isRequestBusy} onChange={(event) => updateDraft({ expenseLocked: event.currentTarget.checked })} />
              경비 정리도 고정하기
            </label>
            <label className="recovery-check-row">
              <input type="checkbox" checked={draft.availability1430} disabled={isRequestBusy} onChange={(event) => updateDraft({ availability1430: event.currentTarget.checked })} />
              목요일 14:30–15:00 사용 가능
            </label>
          </div>
          {mode === 'persisted' ? <button type="button" className="recovery-primary" onClick={() => void previewPersistedPlan()} disabled={!canPreviewPersisted}>변경 조건 다시 계산</button> : null}
          <button type="button" className="recovery-ghost" onClick={resetDraft} disabled={isRequestBusy}><RotateCcw size={16} aria-hidden="true" /> 체험용 기준으로 복원</button>
          </>}
        </aside>

        <section className="recovery-board" aria-labelledby="recovery-board-title">
          <div className="recovery-board__header">
            <div>
              <p className="recovery-kicker">전후 일정</p>
              <h2 id="recovery-board-title">바뀐 일정과 지켜진 약속</h2>
            </div>
            <strong data-feasible={plan.feasible && !isDirty}>{isDirty ? '재계산 필요' : plan.feasible ? '적용 가능' : '확인 필요'}</strong>
          </div>
          {isDirty ? <p className="recovery-draft-note" role="status">조건을 수정했습니다. 아래 일정은 마지막 계산 결과입니다. 다시 계산한 뒤 적용해 주세요.</p> : null}
          <div className="recovery-timelines" data-feasible={plan.feasible}>
            {!plan.feasible ? <aside className="recovery-violations"><h3>조건을 만족하는 새 일정이 없습니다.</h3><p>기존 일정은 그대로 유지됩니다. 아래에서 어떤 조건 때문에 막혔는지 확인해 주세요.</p></aside> : null}
            <Timeline title="변경 전" events={plan.before} movedIds={[]} generic={Boolean(origin)} />
            {plan.feasible ? <Timeline title="조건을 만족하는 일정 조정안" events={plan.after} movedIds={plan.movedEventIds} generic={Boolean(origin)} /> : null}
          </div>
          {plan.violations.length > 0 ? <ViolationList plan={plan} /> : plan.feasible && !isDirty ? <SuccessSummary plan={plan} /> : null}
        </section>
      </section>

      <section className="recovery-actions" aria-labelledby="recovery-actions-title">
        <div className="recovery-actions__header">
          <div>
            <p className="recovery-kicker">01 · 이어짐에 반영</p>
            <h2 id="recovery-actions-title">일정 조정안을 저장하고 적용하세요.</h2>
          </div>
          <p>
            저장된 계획에 적용한 뒤, 필요한 외부 작업을 선택할 수 있습니다.
          </p>
        </div>
        <div className="recovery-action-grid">
          <ActionCard
            icon="save"
            title="작업 공간 저장"
            statusText={plan.server ? '저장됨' : saveStatus === 'saving' ? '저장 중' : saveStatus === 'failed' ? '저장 실패' : '저장 전'}
            status={plan.server || saveStatus === 'saved' ? 'applied' : saveStatus === 'failed' ? 'failed' : saveStatus === 'saving' ? 'pending' : 'not_configured'}
            body={origin ? '직접 확인한 조건을 별도 작업 공간에 저장했습니다. 원래 안내와 계획은 유지됩니다.' : '아래 저장 버튼을 누르면 작업 공간이 만들어져요. 저장에 실패해도 입력한 내용은 이 화면에 남아요.'}
          >
            <button type="button" onClick={() => void saveWorkspace()} disabled={!canSave}>
              <Save size={16} aria-hidden="true" /> {plan.server ? '저장됨' : saveStatus === 'saving' ? '저장 중' : '작업 공간으로 저장'}
            </button>
          </ActionCard>
          <ActionCard icon="approve" title="일정 조정안 적용" status={isDirty ? 'needs_review' : plan.approval.approved ? 'applied' : plan.feasible ? 'ready' : 'needs_review'} body="직접 확인한 변경만 저장된 계획에 적용합니다. 조건을 수정했다면 다시 계산해 주세요.">
            {mode === 'persisted' ? (
              <button type="button" onClick={() => void approvePersistedPlan()} disabled={!canApprovePersisted || previewStatus === 'previewing'}>조정안 적용하기</button>
            ) : (
              <button type="button" onClick={approveLocalPlan} disabled={!canApprove}>미리보기에서 적용</button>
            )}
            {plan.approval.invalidatedReason ? <small>{plan.approval.invalidatedReason}</small> : null}
          </ActionCard>
        </div>
        <div className="recovery-actions__header recovery-external-header">
          <div>
            <p className="recovery-kicker">02 · 선택 사항</p>
            <h2 id="recovery-external-title">캘린더와 메일에도 반영하기</h2>
          </div>
          <p>연결과 별도 확인이 필요합니다. 이어짐에 저장하는 것만으로 발송되지는 않습니다.</p>
        </div>
        <div className="recovery-external-grid" role="group" aria-labelledby="recovery-external-title">
          <ActionCard icon="calendar" title="Google Calendar" status={calendarActionStatus(plan, calendar)} body={calendarActionText(calendar, plan)}>
            <CalendarControls
              calendar={calendar}
              authRequired={calendarAuthRequired}
              adoptCalendarId={adoptCalendarId}
              loading={calendarLoading}
              canQueue={canQueueCalendar}
              busy={isRequestBusy}
              onAdoptCalendarId={setAdoptCalendarId}
              onConnect={() => void connectCalendar(false)}
              onBootstrap={() => void bootstrapCalendar()}
              onAdopt={() => void adoptCalendar()}
              onQueue={() => void queueCalendar()}
              onDisconnect={() => void disconnectCalendar()}
            />
          </ActionCard>
          <ActionCard icon="mail" title="이메일" status={emailActionStatus(plan, hasGmailScope)} body="수신자, 제목, 본문을 화면에서 확정한 뒤에만 처리 목록에 넣습니다. 접수는 수신이나 열람을 뜻하지 않습니다.">
            {!hasGmailScope ? <button type="button" onClick={() => void connectCalendar(true)} disabled={calendar?.status !== 'connected' || isRequestBusy}>Gmail 권한 연결</button> : null}
            <EmailDraftPanel fields={emailFields} disabled={isRequestBusy} onChange={(next) => { setEmailTouched(true); setEmailExactApproved(false); setEmailFields(next); }} />
            <label className="recovery-exact-check">
              <input type="checkbox" checked={emailExactApproved} disabled={isRequestBusy || !emailValidation.ok} onChange={(event) => setEmailExactApproved(event.currentTarget.checked)} />
              표시된 수신자, 제목, 본문 그대로 확인
            </label>
            {!emailValidation.ok ? <small>{emailValidation.message}</small> : null}
            <button type="button" disabled={!canQueueEmail} onClick={() => void queueEmail()}>이메일 발송 작업 등록</button>
          </ActionCard>
        </div>
        <ActionLog actions={plan.server?.actions ?? []} />
        <p className="recovery-scope-note">{origin ? `${origin.sourceMode === 'live' ? '기존 AI 분석에서 확인한 안내' : origin.sourceMode === 'fixture' ? '체험용 원문' : '저장된 안내'}와 사용자가 직접 확인한 조건을 연결했습니다. 최대 48시간·30개 일정·이동 가능한 다른 업무 1개를 검증합니다. 원래 안내나 계획이 바뀌면 적용을 중단합니다. 이어짐 전용 Calendar에만 별도 확인한 일정의 개인 사본을 만듭니다.` : '준비된 데이터로 만든 이틀 일정 예시예요. 최대 30개 일정과 옮길 수 있는 다른 업무 1개를 계산해요. 새 안내문 분석이나 AI 호출은 하지 않아요.'}</p>
      </section>
    </main>
  );
}

function NoticeCard({ plan }: { plan: RecoveryPlan }) {
  return (
    <article className="recovery-notice" aria-label="새 안내와 계산 결과">
      <span>새 안내</span>
      <blockquote>{plan.changedNotice.length > 400 ? `${plan.changedNotice.slice(0, 400)}…` : plan.changedNotice}</blockquote>
      {plan.changedNotice.length > 400 ? <details className="recovery-evidence-details"><summary>원문 전체 보기</summary><p className="recovery-source-text">{plan.changedNotice}</p></details> : null}
      <details className="recovery-evidence-details"><summary>어떤 근거로 연결했나요?</summary><SourceEvidence plan={plan} /></details>
      <dl>
        <div><dt>자료 준비</dt><dd>{plan.draft.preparationMinutes}분 연속</dd></div>
        <div><dt>이동한 작업</dt><dd>{plan.summary.movedTask ?? '없음'}</dd></div>
        <div><dt>보호 일정</dt><dd>{plan.summary.protectedCount}개 유지</dd></div>
      </dl>
    </article>
  );
}

function SourceEvidence({ plan }: { plan: RecoveryPlan }) {
  const relationEvidence = plan.input.relations
    .filter((relation) => plan.input.change.confirmedByRelationIds.includes(relation.id))
    .flatMap((relation) => relation.evidence.map((entry) => ({ id: `${relation.id}:${entry.start}`, kind: relation.kind, quote: entry.quote })));
  return (
    <ul className="recovery-evidence-list" aria-label="확인된 원문 근거">
      {relationEvidence.map((entry) => (
        <li key={entry.id}>
          <strong>{relationLabel(entry.kind)}{plan.server?.origin ? ' · 사용자 확인' : ''}</strong>
          <span>{entry.quote}</span>
        </li>
      ))}
    </ul>
  );
}

function Timeline({ title, events, movedIds, generic = false }: { title: string; events: RecoveryEvent[]; movedIds: string[]; generic?: boolean }) {
  const dates = [...new Set(events.map((event) => event.start.slice(0, 10)))].sort();
  return (
    <section className="recovery-timeline" aria-labelledby={`${slug(title)}-title`}>
      <h3 id={`${slug(title)}-title`}>{title}</h3>
      {dates.map((day) => (
        <div className="recovery-day" key={day}>
          <strong>{calendarDayLabel(day)}</strong>
          <div>
            {events.filter((event) => event.start.startsWith(day)).sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id)).map((event) => (
              <article key={event.id} data-kind={event.kind} data-moved={event.moved || movedIds.includes(event.id)}>
                <span>{timeOnly(event.start)}–{event.end.startsWith(day) ? '' : `${shortDate(event.end)} `}{timeOnly(event.end)}</span>
                <b>{event.title}</b>
                <small>{generic && event.kind === 'presentation' ? '일정' : kindLabels[event.kind]}{event.locked ? ' · 보호' : ''}</small>
              </article>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}

function ViolationList({ plan }: { plan: RecoveryPlan }) {
  return (
    <section className="recovery-violations" aria-labelledby="recovery-violations-title">
      <h3 id="recovery-violations-title"><AlertTriangle size={18} aria-hidden="true" /> 지금 조건에서는 적용할 수 없습니다.</h3>
      {plan.violations.map((violation) => (
        <article key={violation.code}>
          <strong>{violation.message}</strong>
          <ul>{violation.blockers.map((blocker) => <li key={blocker}>{plan.input.events.find((event) => event.id === blocker)?.title ?? '관련 일정'}</li>)}</ul>
        </article>
      ))}
    </section>
  );
}

function SuccessSummary({ plan }: { plan: RecoveryPlan }) {
  return (
    <section className="recovery-success" aria-labelledby="recovery-success-title">
      <h3 id="recovery-success-title"><CheckCircle2 size={18} aria-hidden="true" /> 조건을 만족하는 일정 조정안</h3>
      <ul>
        <li>{plan.summary.preparationWindow}에 {plan.server?.origin ? plan.input.events.find((event) => event.id === plan.input.change.preparationEventId)?.title ?? '준비 시간' : '발표자료 준비'}를 확보합니다.</li>
        {plan.summary.movedTask ? <li>{plan.summary.movedTask}</li> : null}
        <li>{plan.server?.origin ? `보호된 일정 ${plan.summary.protectedCount}개는 그대로 둡니다.` : '목요일 17:00 보호 일정과 금요일 09:00 고정 일정은 그대로 둡니다.'}</li>
        <li>Calendar 후보 작업 {plan.summary.calendarActions}개는 사용자가 따로 확인하기 전까지 외부에 쓰지 않습니다.</li>
      </ul>
    </section>
  );
}

function ActionCard(props: { icon: 'save' | 'approve' | 'calendar' | 'mail'; title: string; status: ExternalActionStatus; statusText?: string; body: string; children: ReactNode }) {
  const Icon = props.icon === 'calendar' ? CalendarClock : props.icon === 'mail' ? Mail : props.icon === 'approve' ? LockKeyhole : Save;
  return (
    <article className="recovery-action-card" data-status={props.status}>
      <Icon size={20} aria-hidden="true" />
      <div>
        <span className="recovery-action-status">{props.statusText ?? statusLabel(props.status)}</span>
        <strong>{props.title}</strong>
        <p>{props.body}</p>
        <div className="recovery-action-card__controls">{props.children}</div>
      </div>
    </article>
  );
}

function CalendarControls(props: {
  calendar: CalendarConnectionSummary | null;
  authRequired: boolean;
  adoptCalendarId: string;
  loading: boolean;
  canQueue: boolean;
  busy: boolean;
  onAdoptCalendarId: (value: string) => void;
  onConnect: () => void;
  onBootstrap: () => void;
  onAdopt: () => void;
  onQueue: () => void;
  onDisconnect: () => void;
}) {
  if (props.loading) return <small>Calendar 상태를 확인하는 중입니다.</small>;
  if (props.authRequired) return <Link className="recovery-inline-link" to="/login">Google 로그인 후 Calendar 연결</Link>;
  if (!props.calendar || props.calendar.status === 'not_configured') return <small>Google Calendar 연결 설정이 아직 준비되지 않았습니다.</small>;
  if (props.calendar.status === 'not_connected' || props.calendar.status === 'needs_reauth') {
    return <button type="button" onClick={props.onConnect} disabled={props.busy}>{props.calendar.status === 'needs_reauth' ? 'Calendar 다시 연결' : 'Calendar 연결'}</button>;
  }
  if (props.calendar.status === 'calendar_missing') {
    return (
      <>
        <button type="button" onClick={props.onBootstrap} disabled={props.busy}>전용 Calendar 만들기</button>
        <button type="button" className="recovery-secondary-button" onClick={props.onDisconnect} disabled={props.busy}>연결 해제</button>
      </>
    );
  }
  if (props.calendar.status === 'bootstrap_uncertain') {
    return (
      <>
        <label className="recovery-calendar-adopt">
          확인한 Calendar ID
          <input value={props.adoptCalendarId} maxLength={512} disabled={props.busy} onChange={(event) => props.onAdoptCalendarId(event.currentTarget.value)} />
        </label>
        <button type="button" onClick={props.onAdopt} disabled={props.busy || props.adoptCalendarId.trim().length === 0 || props.adoptCalendarId.length > 512}>확인한 Calendar 연결</button>
        <button type="button" className="recovery-secondary-button" onClick={props.onDisconnect} disabled={props.busy}>연결 해제</button>
      </>
    );
  }
  return (
    <>
      <small>{props.calendar.calendarSummary ?? '이어짐 Calendar'}의 개인 사본에만 씁니다. 기본 Calendar는 빈 시간 확인에만 사용합니다.</small>
      <button type="button" disabled={!props.canQueue} onClick={props.onQueue}>Calendar 반영 작업 등록</button>
      <button type="button" className="recovery-secondary-button" onClick={props.onDisconnect} disabled={props.busy}>연결 해제</button>
    </>
  );
}

function ActionLog({ actions }: { actions: RecoveryActionView[] }) {
  if (actions.length === 0) return null;
  return (
    <section className="recovery-action-log" aria-labelledby="recovery-action-log-title">
      <h3 id="recovery-action-log-title">외부 처리 기록</h3>
      <ul>
        {actions.map((action) => (
          <li key={action.id} data-status={action.status}>
            <strong>{action.kind === 'calendar' ? 'Calendar' : '이메일'} · {recoveryActionStatusLabel(action.status)}</strong>
            <span>{actionProgressMessage(action)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function EmailDraftPanel({ fields, disabled, onChange }: { fields: EmailFields; disabled: boolean; onChange: (fields: EmailFields) => void }) {
  return (
    <section className="recovery-email" aria-labelledby="recovery-email-title">
      <h3 id="recovery-email-title">이메일 확인 내용</h3>
      <div className="recovery-email-field">
        <label htmlFor="recovery-email-recipient">수신자</label>
        <input id="recovery-email-recipient" type="email" maxLength={EMAIL_RECIPIENT_MAX} value={fields.recipient} disabled={disabled} onChange={(event) => onChange({ ...fields, recipient: event.currentTarget.value })} />
      </div>
      <div className="recovery-email-field">
        <label htmlFor="recovery-email-subject">제목</label>
        <input id="recovery-email-subject" maxLength={EMAIL_SUBJECT_MAX} value={fields.subject} disabled={disabled} onChange={(event) => onChange({ ...fields, subject: event.currentTarget.value })} />
      </div>
      <div className="recovery-email-field">
        <label htmlFor="recovery-email-body">본문</label>
        <textarea id="recovery-email-body" rows={9} maxLength={EMAIL_BODY_MAX} value={fields.body} disabled={disabled} onChange={(event) => onChange({ ...fields, body: event.currentTarget.value })} />
      </div>
    </section>
  );
}

function calendarActionStatus(plan: RecoveryPlan, calendar: CalendarConnectionSummary | null): ExternalActionStatus {
  if (plan.external.calendar !== 'not_configured') return plan.external.calendar;
  if (calendar?.status === 'connected') return plan.approval.approved ? 'ready' : 'not_configured';
  return 'not_configured';
}

function emailActionStatus(plan: RecoveryPlan, hasGmailScope: boolean): ExternalActionStatus {
  if (plan.external.email !== 'not_configured') return plan.external.email;
  return hasGmailScope && plan.approval.approved ? 'ready' : 'not_configured';
}

function calendarActionText(calendar: CalendarConnectionSummary | null, plan: RecoveryPlan): string {
  if (plan.external.calendar === 'pending') return '반영 작업을 처리 중입니다. 실제로 저장됐는지 확인하기 전까지 완료로 표시하지 않습니다.';
  if (plan.external.calendar === 'applied') return '확인한 일정 값이 이어짐 전용 Calendar에 실제 저장됐습니다.';
  if (plan.external.calendar === 'needs_review') return '외부 상태가 바뀌었거나 확인이 불확실해 다시 검토해야 합니다.';
  if (!calendar || calendar.status === 'not_configured') return 'Google Calendar 설정이 준비되어야 연결할 수 있습니다.';
  if (calendar.status === 'connected') return '사용자가 따로 확인한 뒤 이어짐 전용 Calendar에만 반영합니다.';
  if (calendar.status === 'calendar_missing') return '권한은 연결됐고, 이어짐 전용 Calendar 준비가 필요합니다.';
  if (calendar.status === 'bootstrap_uncertain') return '전용 Calendar 생성 결과를 다시 확인해야 합니다.';
  if (calendar.status === 'needs_reauth') return 'Calendar 권한을 다시 연결해야 합니다.';
  return 'Calendar 연결이 필요합니다.';
}

function calendarDayLabel(date: string): string {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  return `${['일', '월', '화', '수', '목', '금', '토'][day]} ${shortDate(date)}`;
}

function recoveryDateLabels(input: RecoveryInput): { thu: string; fri: string } {
  const thu = input.now.slice(0, 10);
  const friday = input.change.presentationInterval.start.slice(0, 10);
  return { thu: `목 ${shortDate(thu)}`, fri: `금 ${shortDate(friday)}` };
}

function shortDate(value: string): string {
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  return `${month}/${day}`;
}

function relationLabel(kind: string): string {
  const labels: Record<string, string> = {
    time_change: '시간 변경',
    deadline: '마감',
    travel_before: '이동',
    required_for: '준비 관계',
  };
  return labels[kind] ?? '근거';
}

function statusLabel(status: ExternalActionStatus): string {
  const labels: Record<ExternalActionStatus, string> = {
    not_configured: '연결 필요',
    ready: '확인 가능',
    pending: '확인 중',
    applied: '적용 확인',
    accepted: '접수됨',
    failed: '실패',
    needs_review: '재검토 필요',
  };
  return labels[status];
}

function recoveryActionStatusLabel(status: RecoveryActionView['status']): string {
  const labels: Record<RecoveryActionView['status'], string> = {
    queued: '대기 중',
    executing: '실행 중',
    verified: '적용 확인',
    accepted: '접수됨',
    uncertain: '확인 필요',
    conflict: '충돌',
    failed: '실패',
    cancelled: '취소됨',
  };
  return labels[status];
}

function actionProgressMessage(action: RecoveryActionView): string {
  const progress = action as RecoveryActionView & { verifiedEvents?: number; totalEvents?: number };
  if (action.kind === 'calendar' && typeof progress.verifiedEvents === 'number' && typeof progress.totalEvents === 'number' && progress.totalEvents > 0 && progress.verifiedEvents < progress.totalEvents) {
    return `Calendar ${progress.verifiedEvents}/${progress.totalEvents}개 확인 · 나머지 재검토`;
  }
  return action.message || '상태 메시지가 없습니다.';
}

function validateEmailFields(fields: EmailFields): { ok: true; message: null } | { ok: false; message: string } {
  const recipient = fields.recipient.trim();
  const subject = fields.subject.trim();
  const body = fields.body.trim();
  if (!recipient) return { ok: false, message: '수신자를 입력해 주세요.' };
  if (recipient.length > EMAIL_RECIPIENT_MAX || /[\r\n]/.test(recipient) || !/^\S+@\S+\.\S+$/.test(recipient)) return { ok: false, message: '수신자 이메일을 확인해 주세요.' };
  if (!subject) return { ok: false, message: '제목을 입력해 주세요.' };
  if (subject.length > EMAIL_SUBJECT_MAX || /[\r\n]/.test(subject)) return { ok: false, message: '제목은 한 줄 160자 이하여야 합니다.' };
  if (!body) return { ok: false, message: '본문을 입력해 주세요.' };
  if (body.length > EMAIL_BODY_MAX) return { ok: false, message: '본문은 4000자 이하여야 합니다.' };
  return { ok: true, message: null };
}

function isUnauthorized(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { status?: unknown }).status === 401;
}

function slug(value: string): string {
  return value.replace(/[^a-z0-9가-힣]+/gi, '-').replace(/^-|-$/g, '');
}

function timeOnly(value: string): string {
  return value.slice(11, 16);
}
