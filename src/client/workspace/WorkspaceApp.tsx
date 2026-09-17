import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, matchPath, useLocation, useNavigate } from 'react-router-dom';
import WorkspaceExportButton from './WorkspaceExportButton';
import ApprovedChangeCopy from './ApprovedChangeCopy';
import WorkspaceStart from './WorkspaceStart';
import CurrentPlanBrief from './CurrentPlanBrief';
import PreparationBoard from './PreparationBoard';
import { readStartContext, type StartTemplate } from './workspace-start-context';
import {
  AlertTriangle,
  ArrowRight,
  Check,
  CheckCircle2,
  CalendarClock,
  Clock,
  FileText,
  History,
  Lock,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Trash2,
  Unlock,
} from 'lucide-react';
import type {
  AppConfig,
  Block,
  BlockItem,
  Change,
  Conflict,
  Evidence,
  Fact,
  RevisionSummary,
  RunSummary,
  Source,
  WorkspaceSummary,
  WorkspaceView,
  Resolution,
} from '../../core/contracts';
import { resolveChangeSet } from '../../core/engine';
import './workspace.css';
import AccountLink from '../account/AccountLink';

type ApiFailure = { code: string; message: string };
type DisplayFailure = { title: string; message: string };
type SourceRelation = 'initial' | 'addition' | 'correction' | 'replacement';
type SampleScenario = NonNullable<WorkspaceView['sampleScenario']>;
type SampleStep = 'update' | 'conflict';
type ConflictChoice = 'keep_user' | 'use_source';
type WorkspaceWithSampleScenario = WorkspaceView & { sampleScenario?: SampleScenario | null };
type ItemPatch = Partial<Pick<BlockItem, 'label' | 'value' | 'completed' | 'locked' | 'preparation'>> & { acknowledgeReview?: true };
type DraftValue = { label: string; value: string; request?: { signature: string; requestId: string } };
type WorkspaceRequestToken = { workspaceId: string | null; selectionEpoch: number; sequence: number };
type AnswerContext = {
  changeSetId: string;
  proposalRevision: number;
  baseRevision: number;
  baseSourceRevision: number;
  questions: string[];
};
type SourceComposerDraft = {
  title: string;
  text: string;
  relation: SourceRelation;
  targetSourceId: string | null;
  answerContext: AnswerContext | null;
};
type BusyAction =
  | 'boot'
  | 'load'
  | 'create'
  | 'sample'
  | 'source'
  | 'edit'
  | 'apply'
  | 'restore'
  | 'delete'
  | 'sample-update'
  | 'retry';
type ImpactItem = Pick<BlockItem, 'id' | 'label' | 'value' | 'edited' | 'locked' | 'completed' | 'stale' | 'calculation' | 'preparation'> & {
  blockTitle: string;
  blockType: Block['type'];
  status: Change['status'];
  outcome: ImpactOutcome;
  finalValue: string | null;
};
type ChangeImpact = { change: Change; relatedItems: ImpactItem[]; fanoutSummary: string[] };
type ImpactOutcome = 'candidate' | 'changed' | 'preserved' | 'deleted' | 'stale';
type WorkspaceTab = 'plan' | 'source' | 'review' | 'history';

type PendingImpactReview = {
  counts: Record<Change['status'], number>;
  changeImpacts: ChangeImpact[];
  protectedItems: ImpactItem[];
  finalCounts: Record<Exclude<ImpactOutcome, 'candidate'>, number>;
  previewReady: boolean;
  previewError: boolean;
};

const workspaceStorageKey = 'ieojim:selected-workspace';
const apiTimeoutMs = 15_000;

const relationLabels: Record<SourceRelation, string> = {
  initial: '처음 자료',
  addition: '추가 자료',
  correction: '정정 자료',
  replacement: '대체 자료',
};

const relationHelp: Record<SourceRelation, string> = {
  initial: '이 작업 공간의 첫 원문입니다. 이후 변경 검토는 이 원문과 현재 계획을 함께 봅니다.',
  addition: '기존 원문은 유지하고 새 안내를 더합니다. 일반 공지나 추가 확인에 맞습니다.',
  correction: '기존 원문의 일부가 틀렸거나 숫자·시간이 바뀌었을 때 사용합니다. 어떤 원문을 고치는지 골라 주세요.',
  replacement: '이전 안내를 새 안내로 대체할 때 사용합니다. 어떤 원문을 바꾸는지 선택해야 합니다.',
};

const blockLabels: Record<Block['type'], string> = {
  schedule: '일정',
  cost: '비용',
  checklist: '체크리스트',
  note: '안내',
};

const statusCopy = {
  changed: { label: '변경됨', icon: ArrowRight },
  preserved: { label: '보존됨', icon: ShieldCheck },
  needs_review: { label: '확인 필요', icon: AlertTriangle },
} as const;
const reviewMetricLabels: Record<Change['status'], string> = {
  changed: '변경',
  preserved: '보존',
  needs_review: '확인 필요',
};
const ledgerStatusLabels: Record<Change['status'], string> = {
  changed: '변경 영향',
  preserved: '보존됨',
  needs_review: '확인 필요',
};

const changeStatusReasons: Record<Change['status'], string> = {
  changed: '원문 근거와 현재 계획을 대조한 결과, 이 값은 적용하면 바뀝니다.',
  preserved: '사용자가 정한 상태가 있어 자동으로 덮어쓰지 않고 현재 값을 유지해요.',
  needs_review: '원문과 사용자 상태가 함께 걸려 있어 적용 전에 선택이 필요합니다.',
};

const runStatusLabels: Record<RunSummary['status'], string> = {
  pending: '대기 중',
  running: '처리 중',
  ready: '검토 가능',
  needs_input: '선택 필요',
  failed: '처리 실패',
  uncertain: '결과 불확실',
  applied: '반영됨',
};

const revisionReasonLabels: Record<string, string> = {
  created: '작업 공간 생성',
  sample_initial: '체험용 예시 시작',
  notice_recovery_initial: '확인한 일정 조정 조건 저장',
  recovery_approved: '승인한 일정 조정안 반영',
  apply_changeset: '확인한 변경 저장',
  manual_edit: '사용자 직접 수정',
};

const errorLabels: Record<string, string> = {
  REQUEST_FAILED: '요청을 완료하지 못했습니다.',
  REQUEST_TIMEOUT: '요청 시간이 초과됐습니다.',
  INVALID_RESPONSE: '서버 응답 형식이 올바르지 않습니다.',
  REVIEW_REQUIRED: '검토가 더 필요합니다.',
  STALE_REVISION: '다른 변경이 먼저 저장됐습니다. 최신 저장 계획을 다시 불러온 뒤 진행해 주세요.',
  STALE_SOURCE_REVISION: '원문 목록이 먼저 바뀌었습니다. 최신 원문을 다시 불러온 뒤 진행해 주세요.',
  MODEL_UNAVAILABLE: '지금은 실제 AI 처리를 사용할 수 없습니다.',
  CORE_UNAVAILABLE: '변경을 확인하는 코드가 아직 준비되지 않았습니다. 잠시 후 다시 시도해 주세요.',
  SAMPLES_UNAVAILABLE: '체험용 예시가 아직 준비되지 않았습니다.',
  CHANGESET_NOT_FOUND: '저장할 변경 내용을 찾지 못했습니다. 최신 검토 화면에서 다시 확인해 주세요.',
  NOT_SYNTHETIC_WORKSPACE: '체험용 예시 작업 공간에서만 사용할 수 있는 기능입니다.',
  CSRF_BLOCKED: '동일 출처 요청만 허용됩니다.',
  MODEL_INPUT_TOO_LARGE: 'AI가 한 번에 읽을 수 있는 원문 길이를 넘었습니다. 원문을 나누거나 줄인 뒤 다시 저장해 주세요.',
  NUMERIC_EVIDENCE_UNSUPPORTED: '숫자 근거를 확인할 수 없습니다.',
  NUMERIC_EVIDENCE_AMBIGUOUS: '숫자 근거가 모호합니다.',
  NUMERIC_EVIDENCE_MISMATCH: '숫자 값이 근거와 일치하지 않습니다.',
  FACT_IDENTITY_COLLISION: '정정한 사실을 기존 항목과 연결하지 못했습니다.',
};

function newRequestId(): string {
  return crypto.randomUUID();
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), apiTimeoutMs);
  init?.signal?.addEventListener('abort', () => controller.abort(), { once: true });
  try {
    const response = await fetch(path, {
      ...init,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
    });
    if (response.status === 204) return undefined as T;
    const payload = await readResponsePayload(response);
    if (!response.ok) throw readFailure(payload);
    return payload as T;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw { code: 'REQUEST_TIMEOUT', message: '요청 시간이 초과됐습니다. 다시 시도할 수 있습니다.' } satisfies ApiFailure;
    }
    if (isApiFailure(error)) throw error;
    throw readFailure(error);
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

async function readResponsePayload(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.trim().length === 0) {
    if (response.ok) throw { code: 'INVALID_RESPONSE', message: '서버 응답 형식이 올바르지 않습니다.' } satisfies ApiFailure;
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    if (response.ok) throw { code: 'INVALID_RESPONSE', message: '서버 응답 형식이 올바르지 않습니다.' } satisfies ApiFailure;
    return null;
  }
}

function readFailure(payload: unknown): ApiFailure {
  if (isApiFailure(payload)) return payload;
  if (payload instanceof Error) return { code: payload.name || 'ERROR', message: payload.message };
  if (typeof payload === 'object' && payload !== null && 'error' in payload) {
    const error = (payload as { error?: { code?: unknown; message?: unknown } }).error;
    if (error && typeof error.code === 'string' && typeof error.message === 'string') {
      return { code: error.code, message: error.message };
    }
  }
  return { code: 'REQUEST_FAILED', message: '요청을 처리하지 못했습니다.' };
}

function isApiFailure(value: unknown): value is ApiFailure {
  return typeof value === 'object' && value !== null && 'code' in value && 'message' in value;
}

function formatItemValue(blockType: Block['type'], value: string) {
  if (blockType !== 'cost') return value;
  const trimmed = value.trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(trimmed)) return value;
  const numeric = Number(trimmed);
  if (!Number.isFinite(numeric)) return value;
  return `${new Intl.NumberFormat('ko-KR').format(numeric)}원`;
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
}

function formatRevisionReason(reason: string): string {
  if (reason.startsWith('restore_')) return '이전 내용 복원';
  return revisionReasonLabels[reason] ?? reason;
}

function isOlderWorkspaceView(next: WorkspaceView, current: WorkspaceView) {
  return next.revision < current.revision || next.sourceRevision < current.sourceRevision;
}

function manualEditSignature(workspaceId: string, baseRevision: number, itemId: string, draft: Pick<DraftValue, 'label' | 'value'>) {
  return JSON.stringify({ workspaceId, baseRevision, itemId, label: draft.label, value: draft.value });
}

function draftKey(workspaceId: string, itemId: string) {
  return `${workspaceId}:${itemId}`;
}

function answerContextFromPending(pending: NonNullable<WorkspaceView['pending']>): AnswerContext {
  return {
    changeSetId: pending.id,
    proposalRevision: pending.proposalRevision,
    baseRevision: pending.baseRevision,
    baseSourceRevision: pending.baseSourceRevision,
    questions: pending.questions,
  };
}

function answerPayload(context: AnswerContext) {
  return {
    changeSetId: context.changeSetId,
    proposalRevision: context.proposalRevision,
    baseRevision: context.baseRevision,
    baseSourceRevision: context.baseSourceRevision,
  };
}

function isCurrentAnswerContext(pending: WorkspaceView['pending'], context: AnswerContext) {
  return Boolean(
    pending &&
    pending.id === context.changeSetId &&
    pending.proposalRevision === context.proposalRevision &&
    pending.baseRevision === context.baseRevision &&
    pending.baseSourceRevision === context.baseSourceRevision &&
    pending.questions.length > 0,
  );
}

function focusDraftValue(key: string) {
  window.setTimeout(() => {
    document.querySelector<HTMLTextAreaElement>(`[data-draft-value-for="${escapeAttributeSelectorValue(key)}"]`)?.focus();
  });
}

function escapeAttributeSelectorValue(value: string) {
  return value.replace(/["\\]/g, '\\$&');
}

function sanitizeSourceRelation(relation: SourceRelation, sourceCount: number, targetSourceId: string | null): SourceRelation {
  if (sourceCount === 0) return 'initial';
  if ((relation === 'correction' || relation === 'replacement') && !targetSourceId) return 'addition';
  return relation === 'initial' ? 'addition' : relation;
}

function WorkspaceApp() {
  const location = useLocation();
  const navigate = useNavigate();
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [view, setView] = useState<WorkspaceView | null>(null);
  const [busy, setBusy] = useState<BusyAction | null>('boot');
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [notice, setNotice] = useState('저장된 계획을 불러오는 중입니다.');
  const [createTemplate, setCreateTemplate] = useState<StartTemplate>(() => readStartContext(location.search).template);
  const [createDrafts, setCreateDrafts] = useState({
    travel: { title: '우리 여행', purpose: '여행 안내에서 일정, 비용, 준비할 일을 정리하고 변경 시 내가 고정한 약속과 직접 고친 내용을 보존한다.' },
    coordination: { title: '외부 미팅 준비', purpose: '미팅 안내에서 일정, 장소, 자료 마감과 준비 업무를 정리하고 변경 시 내가 정한 준비 마감과 소요 시간을 보존한다.' },
    custom: { title: '나의 작업 공간', purpose: '자료 변경을 반영하되 내가 고친 내용과 확정한 결정을 보존한다.' },
  });
  const { title: createTitle, purpose: createPurpose } = createDrafts[createTemplate];
  const [sourceTitle, setSourceTitleState] = useState('새 안내');
  const [sourceText, setSourceTextState] = useState('');
  const [sourceRelation, setSourceRelationState] = useState<SourceRelation>('addition');
  const [targetSourceId, setTargetSourceIdState] = useState<string | null>(null);
  const [answerContext, setAnswerContextState] = useState<AnswerContext | null>(null);
  const [draftValues, setDraftValues] = useState<Record<string, DraftValue>>({});
  const [resolutions, setResolutions] = useState<Record<string, ConflictChoice>>({});
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('plan');
  const [bootReady, setBootReady] = useState(false);
  const activeWorkspaceIdRef = useRef<string | null>(null);
  const latestViewRef = useRef<WorkspaceView | null>(null);
  const selectionEpochRef = useRef(0);
  const requestSequenceRef = useRef(0);
  const acceptedRequestSequenceRef = useRef<Record<string, number>>({});
  const readControllersRef = useRef(new Set<AbortController>());
  const sourceDraftRef = useRef<SourceComposerDraft>({
    title: '새 안내',
    text: '',
    relation: 'addition',
    targetSourceId: null,
    answerContext: null,
  });
  const sourceDraftsByWorkspaceRef = useRef(new Map<string, SourceComposerDraft>());

  const workspaceRouteMatch = useMemo(() => matchPath('/app/workspaces/:workspaceId', location.pathname), [location.pathname]);
  const routeWorkspaceId = workspaceRouteMatch?.params.workspaceId ?? null;
  const isWorkspaceHome = location.pathname === '/app' || location.pathname === '/app/';
  const pendingWork = useMemo(() => view?.runs.some((run) => run.status === 'pending' || run.status === 'running') ?? false, [view]);
  const queryState = useMemo(() => readStartContext(location.search), [location.search]);

  const isCurrentToken = useCallback((token: WorkspaceRequestToken) => {
    return activeWorkspaceIdRef.current === token.workspaceId && selectionEpochRef.current === token.selectionEpoch;
  }, []);

  const isCurrentEpoch = useCallback((token: WorkspaceRequestToken) => {
    return selectionEpochRef.current === token.selectionEpoch;
  }, []);

  const currentSelectionToken = useCallback(() => {
    return { workspaceId: activeWorkspaceIdRef.current, selectionEpoch: selectionEpochRef.current, sequence: requestSequenceRef.current += 1 };
  }, []);

  const setSourceComposerDraft = useCallback((draft: SourceComposerDraft) => {
    sourceDraftRef.current = draft;
    setSourceTitleState(draft.title);
    setSourceTextState(draft.text);
    setSourceRelationState(draft.relation);
    setTargetSourceIdState(draft.targetSourceId);
    setAnswerContextState(draft.answerContext);
  }, []);

  const setSourceTitle = useCallback((title: string) => {
    sourceDraftRef.current = { ...sourceDraftRef.current, title };
    setSourceTitleState(title);
  }, []);

  const setSourceText = useCallback((text: string) => {
    sourceDraftRef.current = { ...sourceDraftRef.current, text };
    setSourceTextState(text);
  }, []);

  const setSourceRelation = useCallback((relation: SourceRelation) => {
    sourceDraftRef.current = { ...sourceDraftRef.current, relation };
    setSourceRelationState(relation);
  }, []);

  const setTargetSourceId = useCallback((targetSourceId: string | null) => {
    sourceDraftRef.current = { ...sourceDraftRef.current, targetSourceId };
    setTargetSourceIdState(targetSourceId);
  }, []);

  const setAnswerContext = useCallback((answerContext: AnswerContext | null) => {
    sourceDraftRef.current = { ...sourceDraftRef.current, answerContext };
    setAnswerContextState(answerContext);
  }, []);

  const captureSourceComposerDraft = useCallback((workspaceId: string | null = activeWorkspaceIdRef.current) => {
    if (!workspaceId) return;
    if (latestViewRef.current?.id !== workspaceId) return;
    sourceDraftsByWorkspaceRef.current.set(workspaceId, { ...sourceDraftRef.current });
  }, []);

  const restoreSourceComposerDraft = useCallback((next: WorkspaceView) => {
    const saved = sourceDraftsByWorkspaceRef.current.get(next.id);
    const targetFromSaved = saved?.targetSourceId && next.sources.some((source) => source.id === saved.targetSourceId)
      ? saved.targetSourceId
      : null;
    const fallbackTarget = next.sources.at(-1)?.id ?? null;
    const relation = sanitizeSourceRelation(saved?.relation ?? (next.sources.length === 0 ? 'initial' : 'addition'), next.sources.length, targetFromSaved ?? fallbackTarget);
    const targetSourceId = relation === 'initial' ? null : targetFromSaved ?? (relation === 'addition' ? fallbackTarget : null);
    const answerContext = saved?.answerContext && isCurrentAnswerContext(next.pending, saved.answerContext) ? saved.answerContext : null;
    setSourceComposerDraft({
      title: saved?.title ?? '새 안내',
      text: saved?.text ?? '',
      relation: answerContext ? 'addition' : relation,
      targetSourceId: answerContext ? null : targetSourceId,
      answerContext,
    });
  }, [setSourceComposerDraft]);

  const nextWorkspaceRequest = useCallback((workspaceId: string, options: { select?: boolean; read?: boolean } = {}) => {
    if (options.select) {
      const switchingWorkspace = activeWorkspaceIdRef.current !== workspaceId;
      captureSourceComposerDraft();
      selectionEpochRef.current += 1;
      activeWorkspaceIdRef.current = workspaceId;
      for (const controller of readControllersRef.current) controller.abort();
      readControllersRef.current.clear();
      if (switchingWorkspace) {
        latestViewRef.current = null;
        setView(null);
        setAnswerContext(null);
        setResolutions({});
        setConfirmDelete(false);
      }
    }
    const controller = options.read ? new AbortController() : null;
    if (controller) readControllersRef.current.add(controller);
    return {
      token: { workspaceId, selectionEpoch: selectionEpochRef.current, sequence: requestSequenceRef.current += 1 },
      controller,
    };
  }, [captureSourceComposerDraft]);

  const finishReadRequest = useCallback((controller: AbortController | null) => {
    if (controller) readControllersRef.current.delete(controller);
  }, []);

  const acceptWorkspaceView = useCallback((next: WorkspaceView, options: { expectedWorkspaceId?: string; select?: boolean; token?: WorkspaceRequestToken } = {}) => {
    if (options.expectedWorkspaceId && activeWorkspaceIdRef.current !== options.expectedWorkspaceId) return false;
    if (options.token && !isCurrentToken(options.token)) return false;
    const current = latestViewRef.current;
    if (current?.id === next.id && isOlderWorkspaceView(next, current)) return false;
    const sameVersion = current?.id === next.id && current.revision === next.revision && current.sourceRevision === next.sourceRevision;
    if (sameVersion && options.token && options.token.sequence < (acceptedRequestSequenceRef.current[next.id] ?? 0)) return false;
    if (options.select) activeWorkspaceIdRef.current = next.id;
    if (options.token) acceptedRequestSequenceRef.current[next.id] = Math.max(acceptedRequestSequenceRef.current[next.id] ?? 0, options.token.sequence);
    latestViewRef.current = next;
    setView(next);
    localStorage.setItem(workspaceStorageKey, next.id);
    return true;
  }, [isCurrentToken]);

  const refreshWorkspaces = useCallback(async () => {
    const list = await api<WorkspaceSummary[]>('/api/workspaces');
    setWorkspaces(list);
    return list;
  }, []);

  const loadWorkspace = useCallback(async (workspaceId: string) => {
    const { token, controller } = nextWorkspaceRequest(workspaceId, { select: true, read: true });
    setBusy('load');
    setFailure(null);
    try {
      const next = await api<WorkspaceView>(`/api/workspaces/${workspaceId}`, { signal: controller?.signal });
      if (acceptWorkspaceView(next, { expectedWorkspaceId: workspaceId, select: true, token })) {
        restoreSourceComposerDraft(next);
        setNotice('작업 공간을 불러왔습니다.');
      }
      return next;
    } catch (error) {
      if (isCurrentToken(token) && !controller?.signal.aborted) setFailure(readFailure(error));
      return null;
    } finally {
      finishReadRequest(controller);
      if (isCurrentToken(token)) setBusy(null);
    }
  }, [acceptWorkspaceView, finishReadRequest, isCurrentToken, nextWorkspaceRequest, restoreSourceComposerDraft]);

  const pollWorkspace = useCallback(async (workspaceId: string) => {
    const { token, controller } = nextWorkspaceRequest(workspaceId, { read: true });
    try {
      const next = await api<WorkspaceView>(`/api/workspaces/${workspaceId}`, { signal: controller?.signal });
      acceptWorkspaceView(next, { expectedWorkspaceId: workspaceId, token });
      return next;
    } catch (error) {
      if (isCurrentToken(token) && !controller?.signal.aborted) setFailure(readFailure(error));
      return null;
    } finally {
      finishReadRequest(controller);
    }
  }, [acceptWorkspaceView, finishReadRequest, isCurrentToken, nextWorkspaceRequest]);

  useEffect(() => {
    let cancelled = false;
    async function boot() {
      try {
        setBootReady(false);
        setBusy('boot');
        const [nextConfig, list] = await Promise.all([api<AppConfig>('/api/config'), refreshWorkspaces()]);
        if (cancelled) return;
        setConfig(nextConfig);
        setNotice(list.length > 0 ? '최근 작업 공간을 불러왔습니다. 이어서 열 작업을 선택하세요.' : '저장된 작업 공간이 없습니다. 체험용 예시나 새 공간으로 시작하세요.');
      } catch (error) {
        if (!cancelled) setFailure(readFailure(error));
      } finally {
        if (!cancelled) {
          setBusy(null);
          setBootReady(true);
        }
      }
    }
    void boot();
    return () => {
      cancelled = true;
    };
  }, [refreshWorkspaces]);

  useEffect(() => {
    if (!isWorkspaceHome || !queryState.hasSelection) return;
    setCreateTemplate(queryState.template);
  }, [isWorkspaceHome, queryState.template, queryState.example, queryState.hasSelection]);

  useEffect(() => {
    if (!bootReady) return;
    if (!routeWorkspaceId) {
      setBusy(null);
      setFailure(null);
      captureSourceComposerDraft();
      for (const controller of readControllersRef.current) controller.abort();
      readControllersRef.current.clear();
      selectionEpochRef.current += 1;
      activeWorkspaceIdRef.current = null;
      latestViewRef.current = null;
      setView(null);
      setAnswerContext(null);
      setResolutions({});
      setConfirmDelete(false);
      return;
    }
    if (activeWorkspaceIdRef.current === routeWorkspaceId && latestViewRef.current?.id === routeWorkspaceId) return;
    void loadWorkspace(routeWorkspaceId);
  }, [bootReady, captureSourceComposerDraft, loadWorkspace, routeWorkspaceId]);

  useEffect(() => {
    if (!view || !pendingWork) return;
    const intervalId = window.setInterval(() => {
      void pollWorkspace(view.id);
    }, 2_000);
    return () => window.clearInterval(intervalId);
  }, [pendingWork, pollWorkspace, view]);

  useEffect(() => {
    if (answerContext && !isCurrentAnswerContext(view?.pending ?? null, answerContext)) {
      setAnswerContext(null);
    }
  }, [answerContext, view?.pending]);

  async function perform(action: BusyAction, work: () => Promise<void>, token?: WorkspaceRequestToken): Promise<boolean> {
    try {
      setBusy(action);
      setFailure(null);
      await work();
      return true;
    } catch (error) {
      if (!token || isCurrentEpoch(token)) setFailure(readFailure(error));
      return false;
    } finally {
      if (!token || isCurrentEpoch(token)) setBusy(null);
    }
  }

  async function createWorkspace() {
    const token = currentSelectionToken();
    await perform('create', async () => {
      const next = await api<WorkspaceView>('/api/workspaces', {
        method: 'POST',
        body: JSON.stringify({ title: createTitle, purpose: createPurpose }),
      });
      captureSourceComposerDraft();
      if (isCurrentToken(token) && acceptWorkspaceView(next, { select: true })) {
        restoreSourceComposerDraft(next);
        setAnswerContext(null);
        navigate(`/app/workspaces/${next.id}`, { replace: false });
        setActiveTab('source');
        setNotice('새 작업 공간을 만들었어요. 원문을 붙여넣으면 AI가 변경 후보와 근거를 정리합니다.');
        void refreshWorkspaces().catch((error) => {
          if (isCurrentEpoch(token)) setFailure(readFailure(error));
        });
      }
    }, token);
  }

  async function startSample(scenario: SampleScenario) {
    const token = currentSelectionToken();
    await perform('sample', async () => {
      const next = await api<WorkspaceView>('/api/workspaces/sample', {
        method: 'POST',
        body: JSON.stringify({ scenario }),
      });
      captureSourceComposerDraft();
      if (isCurrentToken(token) && acceptWorkspaceView(next, { select: true })) {
        restoreSourceComposerDraft(next);
        setAnswerContext(null);
        navigate(`/app/workspaces/${next.id}`, { replace: false });
        setActiveTab('plan');
        setNotice('준비된 체험용 예시를 열었습니다. 실제 AI 호출 결과와 구분됩니다.');
        await refreshWorkspaces();
      }
    }, token);
  }

  async function addSource() {
    if (!view) return;
    const activeAnswer = answerContext;
    if (activeAnswer && !isCurrentAnswerContext(view.pending, activeAnswer)) {
      setFailure({ code: 'STALE_REVISION', message: '답변하려던 확인 질문이 더 이상 최신 상태가 아닙니다. 현재 변경 검토를 다시 확인해 주세요.' });
      return;
    }
    const { token } = nextWorkspaceRequest(view.id);
    await perform('source', async () => {
      const next = await api<WorkspaceView>(`/api/workspaces/${view.id}/sources`, {
        method: 'POST',
        body: JSON.stringify({
          title: sourceTitle,
          text: sourceText,
          relation: activeAnswer ? 'addition' : view.sources.length === 0 ? 'initial' : sourceRelation,
          targetSourceId: activeAnswer ? null : sourceRelation === 'initial' ? null : targetSourceId,
          requestId: newRequestId(),
          ...(activeAnswer ? { answerTo: answerPayload(activeAnswer) } : {}),
        }),
      });
      if (acceptWorkspaceView(next, { expectedWorkspaceId: view.id, token })) {
        if (sourceDraftRef.current.text === sourceText) {
          setSourceText('');
        }
        setAnswerContext(null);
        captureSourceComposerDraft(view.id);
        setActiveTab('plan');
        setNotice('원문을 저장했어요. Gemini가 변경 후보와 근거를 정리하면 검토 화면에 표시됩니다.');
        await refreshWorkspaces();
      }
    }, token);
  }

  async function editItem(item: BlockItem, updates: ItemPatch, requestId = newRequestId()) {
    if (!view) return false;
    const { token } = nextWorkspaceRequest(view.id);
    let accepted = false;
    const succeeded = await perform('edit', async () => {
      const next = await api<WorkspaceView>(`/api/workspaces/${view.id}/items`, {
        method: 'PATCH',
        body: JSON.stringify({ baseRevision: view.revision, requestId, itemId: item.id, ...updates }),
      });
      accepted = acceptWorkspaceView(next, { expectedWorkspaceId: view.id, token });
      if (accepted) {
        await refreshWorkspaces();
        if (!isCurrentToken(token)) return;
        setNotice('직접 수정한 값을 저장했습니다. 이후 AI 변경 후보는 이 값을 자동으로 덮어쓰지 않습니다.');
      }
    }, token);
    return succeeded && accepted;
  }

  async function applyPending() {
    if (!view?.pending) return;
    const unresolved = view.pending.conflicts.filter((conflict) => !resolutions[conflict.id]);
    if (unresolved.length > 0 || view.pending.questions.length > 0) {
      setFailure({ code: 'REVIEW_REQUIRED', message: '확인 질문과 필요한 선택을 먼저 처리해야 승인할 수 있습니다.' });
      return;
    }
    const { token } = nextWorkspaceRequest(view.id);
    await perform('apply', async () => {
      const pending = view.pending;
      if (!pending) return;
      const next = await api<WorkspaceView>(`/api/workspaces/${view.id}/apply`, {
        method: 'POST',
        body: JSON.stringify({
          changeSetId: pending.id,
          baseRevision: pending.baseRevision,
          baseSourceRevision: pending.baseSourceRevision,
          proposalRevision: pending.proposalRevision,
          requestId: newRequestId(),
          resolutions: Object.entries(resolutions).map(([conflictId, choice]) => ({ conflictId, choice })),
        }),
      });
      if (acceptWorkspaceView(next, { expectedWorkspaceId: view.id, token })) {
        setResolutions({});
        setActiveTab('plan');
        setNotice('확인한 변경을 저장했습니다.');
        await refreshWorkspaces();
      }
    }, token);
  }

  async function restoreRevision(revision: RevisionSummary) {
    if (!view) return;
    const { token } = nextWorkspaceRequest(view.id);
    await perform('restore', async () => {
      const next = await api<WorkspaceView>(`/api/workspaces/${view.id}/restore`, {
        method: 'POST',
        body: JSON.stringify({ revision: revision.revision, baseRevision: view.revision, requestId: newRequestId() }),
      });
      if (acceptWorkspaceView(next, { expectedWorkspaceId: view.id, token })) {
        setActiveTab('plan');
        setNotice(`${revision.revision}번 저장된 계획을 새 버전으로 복원했습니다.`);
        await refreshWorkspaces();
      }
    }, token);
  }

  async function runSampleUpdate(step: SampleStep) {
    if (!view) return;
    const { token } = nextWorkspaceRequest(view.id);
    await perform('sample-update', async () => {
      const next = await api<WorkspaceView>(`/api/workspaces/${view.id}/sample-update`, {
        method: 'POST',
        body: JSON.stringify({ step, requestId: newRequestId() }),
      });
      if (acceptWorkspaceView(next, { expectedWorkspaceId: view.id, token })) {
        await refreshWorkspaces();
        if (!isCurrentToken(token)) return;
        setNotice(step === 'update' ? '체험용 변경 자료로 검토 화면을 만들었습니다.' : '고정한 결정과 확인이 필요한 체험용 변경을 만들었습니다.');
      }
    }, token);
  }

  async function retryRun(run: RunSummary) {
    if (!view || !config?.liveAvailable) return;
    const { token } = nextWorkspaceRequest(view.id);
    await perform('retry', async () => {
      const next = await api<WorkspaceView>(`/api/workspaces/${view.id}/retry`, {
        method: 'POST',
        body: JSON.stringify({ runId: run.id, requestId: newRequestId() }),
      });
      if (acceptWorkspaceView(next, { expectedWorkspaceId: view.id, token })) {
        setNotice('처리 실패 건을 다시 요청했습니다.');
      }
    }, token);
  }

  async function deleteWorkspace() {
    if (!view) return;
    const { token } = nextWorkspaceRequest(view.id);
    await perform('delete', async () => {
      await api<null>(`/api/workspaces/${view.id}`, { method: 'DELETE' });
      await refreshWorkspaces();
      if (!isCurrentToken(token)) return;
      localStorage.removeItem(workspaceStorageKey);
      activeWorkspaceIdRef.current = null;
      latestViewRef.current = null;
      setView(null);
      setConfirmDelete(false);
      navigate('/app', { replace: true });
      setActiveTab('plan');
      setNotice('작업 공간과 저장된 자료를 삭제했습니다.');
    }, token);
  }

  function beginEdit(item: BlockItem) {
    if (!view) return;
    setDraftValues((current) => ({ ...current, [draftKey(view.id, item.id)]: { label: item.label, value: item.value } }));
  }

  function cancelEdit(itemId: string) {
    if (!view) return;
    setDraftValues((current) => {
      const next = { ...current };
      delete next[draftKey(view.id, itemId)];
      return next;
    });
  }

  function saveDraft(item: BlockItem) {
    if (!view) return;
    const key = draftKey(view.id, item.id);
    const draft = draftValues[key];
    if (!draft) return;
    const signature = manualEditSignature(view.id, view.revision, item.id, draft);
    const requestId = draft.request?.signature === signature ? draft.request.requestId : newRequestId();
    setDraftValues((current) => {
      const currentDraft = current[key];
      if (!currentDraft || currentDraft.label !== draft.label || currentDraft.value !== draft.value) return current;
      return { ...current, [key]: { ...currentDraft, request: { signature, requestId } } };
    });
    void editItem(item, { label: draft.label, value: draft.value }, requestId).then((saved) => {
      if (saved) {
        setDraftValues((current) => {
          const currentDraft = current[key];
          if (!currentDraft || currentDraft.label !== draft.label || currentDraft.value !== draft.value || currentDraft.request?.requestId !== requestId) return current;
          const next = { ...current };
          delete next[key];
          return next;
        });
      } else if (activeWorkspaceIdRef.current === view.id) {
        focusDraftValue(key);
      }
    });
  }

  function beginAnswer(pending: WorkspaceView['pending']) {
    if (!view || !pending || pending.questions.length === 0) return;
    const context = answerContextFromPending(pending);
    setAnswerContext(context);
    setSourceTitle('확인 질문에 대한 답변');
    setSourceRelation('addition');
    setTargetSourceId(null);
    setActiveTab('source');
    window.setTimeout(() => document.querySelector<HTMLTextAreaElement>('.source-input')?.focus());
  }

  function cancelAnswer() {
    setAnswerContext(null);
  }

  const sourceLimit = config?.maxSourceChars ?? 6000;
  const selectedSource = view?.sources.find((source) => source.id === targetSourceId);
  const sampleScenario = getSampleScenario(view);
  const sampleLabels = getSampleActionLabels(sampleScenario);
  const visibleFailure = failure ? displayError(failure) : null;

  const openWorkspace = useCallback((workspaceId: string) => {
    if (activeWorkspaceIdRef.current === workspaceId) {
      void loadWorkspace(workspaceId);
      return;
    }
    navigate(`/app/workspaces/${workspaceId}`);
  }, [loadWorkspace, navigate]);

  if (isWorkspaceHome) {
    return (
      <main className="workspace-app workspace-app-home" data-testid="workspace-home" aria-busy={busy !== null}>
        <WorkspaceTopbar config={config} notice={notice} />
        {visibleFailure ? <FailureBanner failure={visibleFailure} /> : null}
        <p className="sr-only" role="status">{notice}</p>
        <WorkspaceStart
          template={createTemplate}
          title={createTitle}
          purpose={createPurpose}
          busy={busy !== null}
          exampleFirst={queryState.example !== null}
          departureFirst={queryState.example === 'departure'}
          coordinationFirst={queryState.example === 'coordination'}
          syllabusFirst={queryState.example === 'syllabus'}
          travelFirst={queryState.example === 'travel'}
          onTemplate={setCreateTemplate}
          onTitle={(title) => setCreateDrafts((drafts) => ({ ...drafts, [createTemplate]: { ...drafts[createTemplate], title } }))}
          onPurpose={(purpose) => setCreateDrafts((drafts) => ({ ...drafts, [createTemplate]: { ...drafts[createTemplate], purpose } }))}
          onCreate={() => void createWorkspace()}
          onSample={(scenario) => void startSample(scenario)}
        />
        <section className="recent-section" aria-labelledby="recent-workspaces-title">
          <div className="section-head">
            <div>
              <p className="eyebrow">최근 작업</p>
              <h2 id="recent-workspaces-title">최근 작업 공간</h2>
            </div>
            <span className="status-pill">{workspaces.length}개 저장됨</span>
          </div>
          <WorkspaceList workspaces={workspaces} activeWorkspaceId={view?.id ?? null} onOpen={openWorkspace} />
        </section>
      </main>
    );
  }

  return (
    <main className="workspace-app workspace-app-work" data-testid="workspace-app" aria-busy={busy !== null}>
      <WorkspaceTopbar config={config} notice={notice} compact />
      {visibleFailure ? <FailureBanner failure={visibleFailure} /> : null}
      <p className="sr-only" role="status">{notice}</p>

      <section className="workspace-shell">
        <aside className="workspace-sidebar" aria-label="작업 공간 탐색">
          <a className="brand-link" href="/">이어짐</a>
          <button type="button" className="sidebar-home" onClick={() => navigate('/app')} disabled={busy !== null}>
            최근 작업 보기
          </button>
          <button type="button" className="sidebar-start" onClick={() => navigate('/app')} disabled={busy !== null}>
            <Plus size={17} />
            새 작업 시작
          </button>
          <div className="workspace-list-block">
            <h2>작업 공간</h2>
            <WorkspaceList workspaces={workspaces} activeWorkspaceId={view?.id ?? routeWorkspaceId} onOpen={openWorkspace} />
          </div>
          <div className="sample-stack" aria-label="체험용 예시">
            <button type="button" className="sample-button" onClick={() => void startSample('departure')} disabled={busy !== null}>
              <span>출발 전날 복합 예시</span>
              <small>약속 변경·완료 기록 삭제를 직접 결정</small>
            </button>
            <button type="button" className="sample-button" onClick={() => void startSample('coordination')} disabled={busy !== null}>
              <span>고객 미팅 변경 예시</span>
              <small>자료 마감·준비 업무·고정 보고 검토</small>
            </button>
            <button type="button" className="sample-button" onClick={() => void startSample('travel')} disabled={busy !== null}>
              <span>여행 예시</span>
              <small>변경 자료와 고정한 결정 확인</small>
            </button>
            <button type="button" className="sample-button" onClick={() => void startSample('syllabus')} disabled={busy !== null}>
              <span>과제 예시</span>
              <small>과제 마감이 바뀌었을 때</small>
            </button>
          </div>
        </aside>

        <section className="workspace-stage">
          <nav className="workspace-tabs" aria-label="작업 화면">
            <button type="button" className={activeTab === 'plan' ? 'active' : ''} aria-pressed={activeTab === 'plan'} onClick={() => setActiveTab('plan')}>계획</button>
            <button type="button" className={activeTab === 'source' ? 'active' : ''} aria-pressed={activeTab === 'source'} onClick={() => setActiveTab('source')}>원문</button>
            <button type="button" className={activeTab === 'review' ? 'active' : ''} aria-pressed={activeTab === 'review'} onClick={() => setActiveTab('review')}>변경 검토</button>
            <button type="button" className={activeTab === 'history' ? 'active' : ''} aria-pressed={activeTab === 'history'} onClick={() => setActiveTab('history')}>변경 이력</button>
          </nav>

          {view ? (
            <>
              <WorkspaceRunStatus view={view} config={config} busy={busy} onRetry={retryRun} />
              <div className="workspace-content" data-active-tab={activeTab} data-has-proposal={Boolean(view.pending)}>
                <section className="plan-surface" data-testid="workspace-plan" aria-label="계획">
                  <WorkspaceHeader view={view} sampleScenario={sampleScenario} sampleLabels={sampleLabels} busy={busy} onSampleUpdate={runSampleUpdate} />
                  <div className="blocks">
                    {view.snapshot.blocks.length === 0 ? (
                      <EmptyWorkspace />
                    ) : view.snapshot.blocks.map((block) => (
                      <WorkspaceBlock
                        key={block.id}
                        workspaceId={view.id}
                        block={block}
                        facts={view.snapshot.facts}
                        sources={view.sources}
                        draftValues={draftValues}
                        disabled={busy !== null}
                        onBeginEdit={beginEdit}
                        onCancelEdit={cancelEdit}
                        onSaveDraft={saveDraft}
                        onDraftChange={(itemId, field, value) => setDraftValues((current) => ({
                          ...current,
                          [draftKey(view.id, itemId)]: { ...(current[draftKey(view.id, itemId)] ?? { label: '', value: '' }), [field]: value },
                        }))}
                        onPatch={editItem}
                      />
                    ))}
                  </div>
                  <PreparationBoard
                    key={`${view.id}:preparation`}
                    workspaceId={view.id}
                    revision={view.revision}
                    blocks={view.snapshot.blocks}
                    disabled={busy !== null}
                    defaultOpen={view.sampleScenario === 'coordination'}
                    onSave={(item, preparation, requestId) => editItem(item, { preparation }, requestId)}
                    onReopen={(item, requestId) => editItem(item, { completed: false, acknowledgeReview: true }, requestId)}
                    onAcknowledgeReview={(item, requestId) => editItem(item, { acknowledgeReview: true }, requestId)}
                  />
                  {view.snapshot.blocks.length > 0 ? (
                    <CurrentPlanBrief key={`${view.id}:${view.revision}`} workspaceId={view.id} currentRevision={view.revision} disabled={busy !== null} shareAudience={view.sampleScenario === 'coordination' || view.sampleScenario === null ? 'general' : 'companions'} />
                  ) : null}
                </section>

                <aside className="source-surface" data-testid="workspace-source" aria-label="원문">
                  <SourceComposer
                    view={view}
                    sourceTitle={sourceTitle}
                    sourceText={sourceText}
                    sourceRelation={sourceRelation}
                    targetSourceId={targetSourceId}
                    answerContext={answerContext}
                    sourceLimit={sourceLimit}
                    selectedSource={selectedSource}
                    disabled={busy !== null}
                    onTitle={setSourceTitle}
                    onText={setSourceText}
                    onRelation={setSourceRelation}
                    onTarget={setTargetSourceId}
                    onCancelAnswer={cancelAnswer}
                    onSubmit={() => void addSource()}
                  />
                  <SourceCatalog sources={view.sources} />
                </aside>

                <aside className="review-surface" data-testid="workspace-review" aria-label="변경 검토" tabIndex={0}>
                  <ProposalReview
                    pending={view.pending}
                    snapshot={view.snapshot}
                    sources={view.sources}
                    resolutions={resolutions}
                    disabled={busy !== null}
                    onResolution={(conflictId, choice) => setResolutions((current) => ({ ...current, [conflictId]: choice }))}
                    onAnswer={beginAnswer}
                    onApply={() => void applyPending()}
                  />
                  {view.history.some((revision) => revision.revision === view.revision && revision.reason === 'apply_changeset') ? (
                    <ApprovedChangeCopy key={`${view.id}:${view.revision}`} workspaceId={view.id} currentRevision={view.revision} disabled={busy !== null} />
                  ) : null}
                </aside>

                <aside className="history-surface" data-testid="workspace-history" aria-label="변경 이력과 삭제">
                  <HistoryPanel history={view.history} currentRevision={view.revision} disabled={busy !== null} onRestore={restoreRevision} />
                  <WorkspaceExportButton key={view.id} workspaceId={view.id} />
                  <DeletePanel confirmDelete={confirmDelete} disabled={busy !== null} expiresAt={view.expiresAt} onToggle={setConfirmDelete} onDelete={() => void deleteWorkspace()} />
                </aside>
              </div>
            </>
          ) : (
            <section className="route-empty" aria-label="작업 공간 상태">
              <EmptyWorkspace />
              <button type="button" className="ghost-button" onClick={() => navigate('/app')}>최근 작업으로 돌아가기</button>
            </section>
          )}
        </section>
      </section>
    </main>
  );
}

function WorkspaceTopbar({ config, notice, compact = false }: { config: AppConfig | null; notice: string; compact?: boolean }) {
  return (
    <header className={compact ? 'workspace-topbar compact' : 'workspace-topbar'}>
      <div>
        <a className="workspace-brand" href="/">이어짐</a>
      </div>
      <div className="status-cluster" aria-live="polite">
        <span className={config?.liveAvailable ? 'status-pill live' : 'status-pill'}>
          <Sparkles size={16} />
          {config?.liveAvailable ? '실제 AI 처리 가능' : '게스트 체험 가능'}
        </span>
        <span className="status-pill">
          <Clock size={16} />
          7일 미사용 보관
        </span>
        <span className="status-pill status-notice">{notice}</span>
        <AccountLink />
      </div>
    </header>
  );
}

function FailureBanner({ failure }: { failure: DisplayFailure }) {
  return (
    <section className="alert" role="alert">
      <AlertTriangle size={18} />
      <div>
        <strong>{failure.title}</strong>
        <p>{failure.message}</p>
      </div>
    </section>
  );
}

function WorkspaceList({ workspaces, activeWorkspaceId, onOpen }: { workspaces: WorkspaceSummary[]; activeWorkspaceId: string | null; onOpen: (workspaceId: string) => void }) {
  if (workspaces.length === 0) {
    return (
      <div className="empty-list">
        <FileText size={18} />
        <p>아직 저장된 작업 공간이 없습니다.</p>
      </div>
    );
  }
  return (
    <div className="workspace-list" aria-label="작업 공간 목록">
      {workspaces.map((workspace) => (
        <button
          key={workspace.id}
          type="button"
          className={workspace.id === activeWorkspaceId ? 'workspace-link active' : 'workspace-link'}
          onClick={() => onOpen(workspace.id)}
        >
          <strong>{workspace.title}</strong>
        <small>저장된 계획 {workspace.revision} · {formatDate(workspace.updatedAt)}</small>
        </button>
      ))}
    </div>
  );
}

function WorkspaceHeader(props: {
  view: WorkspaceView;
  sampleScenario: SampleScenario | null;
  sampleLabels: { update: string; conflict: string };
  busy: BusyAction | null;
  onSampleUpdate: (step: SampleStep) => Promise<void>;
}) {
  return (
    <header className="workspace-header">
      <div>
        <p className="eyebrow">내 계획</p>
        <h2>{props.view.title}</h2>
        <p>{props.view.purpose}</p>
      </div>
      <div className="workspace-meta">
        <span className="status-pill">저장된 계획 {props.view.revision}</span>
        <span className="status-pill">원문 {props.view.sourceRevision}</span>
      </div>
      {props.view.history.some((entry) => ['notice_recovery_initial', 'recovery_approved'].includes(entry.reason)) ? (
        <div className="workspace-recovery-entry"><Link className="ghost-button" to={`/recovery/${encodeURIComponent(props.view.id)}`}><CalendarClock size={16} aria-hidden="true" /> 연결된 일정 조정안 보기</Link></div>
      ) : props.view.sources.length > 0 && props.view.snapshot.blocks.some((block) => block.type === 'schedule' && block.items.length > 0) ? (
        <div className="workspace-recovery-entry">
          {props.view.pending || props.busy ? <p>변경 검토를 마치면 사용자가 확인한 준비·이동 시간으로 일정 조정안을 만들 수 있습니다.</p> : (
            <Link className="ghost-button" to={`/app/workspaces/${encodeURIComponent(props.view.id)}/recovery/setup`}>
              <CalendarClock size={16} aria-hidden="true" /> 이 안내로 일정 조정하기
            </Link>
          )}
        </div>
      ) : null}
      {props.sampleScenario ? (
        <div className="sample-actions">
          <button type="button" onClick={() => void props.onSampleUpdate('update')} disabled={props.busy !== null || ((props.sampleScenario === 'departure' || props.sampleScenario === 'coordination') && props.view.sources.length > 1)}>
            <RefreshCw size={16} />
            {props.sampleLabels.update}
          </button>
          {props.sampleScenario !== 'departure' ? <button type="button" onClick={() => void props.onSampleUpdate('conflict')} disabled={props.busy !== null}>
            <AlertTriangle size={16} />
            {props.sampleLabels.conflict}
          </button> : null}
          {props.sampleScenario === 'departure' ? <p className="muted">고정·완료·직접 수정 상태를 준비한 체험용 예시입니다. 정정 안내 한 건을 검토하고, 변경 이력에서 저장된 계획을 복원할 수 있습니다.</p> : null}
          {props.sampleScenario === 'coordination' ? <p className="muted">비서·경영지원 담당자의 준비 마감과 예상 시간이 저장된 체험용 예시입니다. 정정 안내를 불러와 변경 영향을 검토하세요.</p> : null}
        </div>
      ) : null}
    </header>
  );
}

function WorkspaceRunStatus({ view, config, busy, onRetry }: { view: WorkspaceView; config: AppConfig | null; busy: BusyAction | null; onRetry: (run: RunSummary) => Promise<void> }) {
  return (
    <section className="workspace-run-status" aria-label="실행 상태">
      <div className="run-strip">
        {view.runs.length === 0 ? <span className="run-pill">AI 처리 기록 없음</span> : view.runs.slice(0, 3).map((run) => (
          <span key={run.id} className={`run-pill ${run.status}`}>
            {run.mode === 'fixture' ? '체험용' : '실제 AI'} · {runStatusLabels[run.status]}
            {(run.status === 'failed' || run.status === 'uncertain') ? (
              <button
                type="button"
                title={!config?.liveAvailable ? '실제 AI 처리가 연결되면 다시 요청할 수 있습니다.' : run.error ? userFacingMessage(run.error) : undefined}
                onClick={() => void onRetry(run)}
                disabled={busy !== null || !config?.liveAvailable}
              >재시도</button>
            ) : null}
          </span>
        ))}
      </div>
    </section>
  );
}

function SourceCatalog({ sources }: { sources: Source[] }) {
  return (
    <section className="source-catalog">
      <PanelTitle icon={<FileText size={18} />} title="저장된 원문" detail={`${sources.length}개 자료가 이 작업 공간에 연결되어 있습니다.`} />
      {sources.length === 0 ? (
        <p className="muted">첫 원문을 저장하면 근거와 변경 검토가 함께 생성됩니다.</p>
      ) : (
        <div className="source-list">
          {sources.map((source) => (
            <details key={source.id} className="source-card">
              <summary>
                <strong>{source.title}</strong>
                <span>{relationLabels[source.relation]} · {formatDate(source.createdAt)}</span>
              </summary>
              <p>{source.text}</p>
            </details>
          ))}
        </div>
      )}
    </section>
  );
}

function PanelTitle({ icon, title, detail }: { icon: ReactNode; title: string; detail: string }) {
  return (
    <div className="panel-title">
      <div className="panel-icon">{icon}</div>
      <div>
        <h2>{title}</h2>
        <p>{detail}</p>
      </div>
    </div>
  );
}

function SourceComposer(props: {
  view: WorkspaceView;
  sourceTitle: string;
  sourceText: string;
  sourceRelation: SourceRelation;
  targetSourceId: string | null;
  answerContext: AnswerContext | null;
  sourceLimit: number;
  selectedSource: Source | undefined;
  disabled: boolean;
  onTitle: (value: string) => void;
  onText: (value: string) => void;
  onRelation: (value: SourceRelation) => void;
  onTarget: (value: string | null) => void;
  onCancelAnswer: () => void;
  onSubmit: () => void;
}) {
  const relation = props.answerContext ? 'addition' : props.view.sources.length === 0 ? 'initial' : props.sourceRelation;
  const targetRequired = relation === 'correction' || relation === 'replacement';
  return (
    <form className="source-composer" onSubmit={(event) => { event.preventDefault(); props.onSubmit(); }}>
      <h3>원문 붙여넣기</h3>
      {props.answerContext ? (
        <div className="question-box" aria-label="답변 중인 확인 질문">
          <strong>확인 질문에 답변 중</strong>
          {props.answerContext.questions.map((question) => <p key={question}>{question}</p>)}
          <button type="button" className="ghost-button" onClick={props.onCancelAnswer} disabled={props.disabled}>답변 취소</button>
        </div>
      ) : null}
      <label>
        원문 제목
        <input value={props.sourceTitle} onChange={(event) => props.onTitle(event.target.value)} maxLength={100} />
      </label>
      <div className="split-controls">
        <label>
          관계
          <select
            value={relation}
            disabled={props.answerContext !== null || props.view.sources.length === 0}
            onChange={(event) => props.onRelation(event.target.value as SourceRelation)}
            aria-describedby="source-relation-help"
          >
            {Object.entries(relationLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label>
          바꿀 원문{targetRequired ? ' 필수' : ''}
          <select
            value={props.answerContext ? '' : props.targetSourceId ?? ''}
            onChange={(event) => props.onTarget(event.target.value || null)}
            disabled={props.answerContext !== null || props.view.sources.length === 0 || relation === 'initial'}
            aria-describedby="source-relation-help"
          >
            <option value="">선택 없음</option>
            {props.view.sources.map((source) => <option key={source.id} value={source.id}>{source.title}</option>)}
          </select>
        </label>
      </div>
      <p id="source-relation-help" className="source-authority-help">
        {relationHelp[relation]} {targetRequired ? '어느 원문을 정정하거나 대체하는지 고르면 검토 화면에서 근거가 더 분명해집니다.' : null}
      </p>
      <label>
        원문 내용
        <textarea
          className="source-input"
          value={props.sourceText}
          onChange={(event) => props.onText(event.target.value)}
          maxLength={props.sourceLimit}
          rows={8}
          placeholder="예: 참석자는 3명으로 변경됐고 첫날 도착은 오후 4시입니다."
        />
      </label>
      <div className="source-footer">
        <small>{props.sourceText.length}/{props.sourceLimit}자 · 저장 한도입니다. 전체 자료가 길면 AI가 한 번에 읽지 못할 수 있어요.</small>
        <button type="submit" className="primary-action" disabled={props.disabled || props.sourceText.trim().length === 0 || props.sourceTitle.trim().length === 0}>
          <Sparkles size={16} />
          원문 저장하고 AI 검토
        </button>
      </div>
      {props.selectedSource ? (
        <details className="source-detail">
          <summary>바꿀 원문 미리보기</summary>
          <p>{props.selectedSource.text}</p>
        </details>
      ) : null}
    </form>
  );
}

function WorkspaceBlock(props: {
  workspaceId: string;
  block: Block;
  facts: Fact[];
  sources: Source[];
  draftValues: Record<string, { label: string; value: string }>;
  disabled: boolean;
  onBeginEdit: (item: BlockItem) => void;
  onCancelEdit: (itemId: string) => void;
  onSaveDraft: (item: BlockItem) => void;
  onDraftChange: (itemId: string, field: 'label' | 'value', value: string) => void;
  onPatch: (item: BlockItem, updates: ItemPatch) => Promise<boolean>;
}) {
  return (
    <section className={`block block-${props.block.type}`}>
      <header>
        <span>{blockLabels[props.block.type]}</span>
        <h3>{props.block.title}</h3>
      </header>
      <div className="item-list">
        {props.block.items.map((item) => {
          const draft = props.draftValues[draftKey(props.workspaceId, item.id)];
          const evidence = collectItemEvidence(item, props.facts);
          return (
            <article key={item.id} className={item.stale ? 'item stale' : 'item'}>
              <div className="item-main">
                {draft ? (
                  <div className="edit-fields">
                    <input aria-label="항목 이름" value={draft.label} onChange={(event) => props.onDraftChange(item.id, 'label', event.target.value)} />
                    <textarea aria-label="항목 값" data-draft-value-for={draftKey(props.workspaceId, item.id)} rows={3} value={draft.value} onChange={(event) => props.onDraftChange(item.id, 'value', event.target.value)} />
                  </div>
                ) : (
                  <>
                    <div className="item-label-row">
                      {props.block.type === 'checklist' ? (
                        <button
                          type="button"
                          className={item.completed ? `check-button done${item.stale ? ' needs-review' : ''}` : 'check-button'}
                          aria-label={item.completed ? '완료 취소' : '완료 처리'}
                          onClick={() => void props.onPatch(item, { completed: !item.completed })}
                          disabled={props.disabled}
                        >
                          <Check size={16} />
                        </button>
                      ) : null}
                      <strong>{item.label}</strong>
                    </div>
                    <p className="item-value">{formatItemValue(props.block.type, item.value)}</p>
                  </>
                )}
                <div className="item-badges">
                  {item.edited ? <span><Pencil size={13} /> 직접 수정</span> : null}
                  {item.locked ? <span><Lock size={13} /> 고정</span> : null}
                  {item.completed ? <span><CheckCircle2 size={13} /> {item.stale ? '이전 완료' : '완료'}</span> : null}
                  {item.stale ? <span><AlertTriangle size={13} /> 확인 필요</span> : null}
                  {item.preparation?.dueDate ? <span><Clock size={13} /> {item.preparation.dueDate}</span> : null}
                  {item.preparation?.durationMinutes ? <span><Clock size={13} /> {item.preparation.durationMinutes}분</span> : null}
                  {item.calculation ? <span>자동 계산</span> : null}
                </div>
              </div>
              <div className="item-tools">
                {draft ? (
                  <>
                    <button type="button" onClick={() => props.onSaveDraft(item)} disabled={props.disabled}>저장</button>
                    <button type="button" onClick={() => props.onCancelEdit(item.id)} disabled={props.disabled}>취소</button>
                  </>
                ) : (
                  <>
                    <button type="button" aria-label="항목 편집" onClick={() => props.onBeginEdit(item)} disabled={props.disabled}><Pencil size={16} /></button>
                    <button type="button" aria-label={item.locked ? '고정 해제' : '고정'} onClick={() => void props.onPatch(item, { locked: !item.locked })} disabled={props.disabled}>
                      {item.locked ? <Unlock size={16} /> : <Lock size={16} />}
                    </button>
                  </>
                )}
              </div>
              {evidence.length > 0 ? <EvidenceDetails evidence={evidence} sources={props.sources} /> : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}

function collectItemEvidence(item: BlockItem, facts: Fact[]): Evidence[] {
  const factByKey = new Map(facts.map((fact) => [fact.key, fact.evidence]));
  return item.factKeys.flatMap((factKey) => {
    const evidence = factByKey.get(factKey);
    return evidence ? [evidence] : [];
  });
}

function derivePendingImpactReview(
  pending: NonNullable<WorkspaceView['pending']>,
  snapshot: WorkspaceView['snapshot'],
  resolutions: Record<string, ConflictChoice>,
): PendingImpactReview {
  const counts: PendingImpactReview['counts'] = { changed: 0, preserved: 0, needs_review: 0 };
  const itemsById = new Map<string, ImpactItem>();
  const factKeyByFactId = new Map(snapshot.facts.map((fact) => [fact.id, fact.key]));
  const itemsByFactKey = new Map<string, ImpactItem[]>();
  const resolutionList = Object.entries(resolutions).map(([conflictId, choice]) => ({ conflictId, choice }) satisfies Resolution);
  const previewReady = pending.questions.length === 0 && pending.conflicts.every((conflict) => resolutions[conflict.id]);
  const resolvedSnapshot = previewReady ? resolvePendingPreview(pending, snapshot, resolutionList) : null;
  const finalItemsById = resolvedSnapshot ? indexImpactItems(resolvedSnapshot).itemsById : null;

  for (const block of snapshot.blocks) {
    for (const item of block.items) {
      const impactItem: ImpactItem = {
        ...item,
        blockTitle: block.title,
        blockType: block.type,
        status: 'changed',
        outcome: 'candidate',
        finalValue: null,
      };
      itemsById.set(item.id, impactItem);
      for (const factKey of item.factKeys) {
        const related = itemsByFactKey.get(factKey) ?? [];
        related.push(impactItem);
        itemsByFactKey.set(factKey, related);
      }
    }
  }

  const itemImpacts = new Map<string, ImpactItem>();
  const changeImpacts = pending.changes.map((change) => {
    counts[change.status] += 1;
    const related = relatedItemsForChange(change, itemsById, factKeyByFactId, itemsByFactKey);
    const relatedItems = related.kind === 'item'
      ? related.items.map((item) => mergeItemImpact(itemImpacts, item, change.status))
      : [];
    const fanoutSummary = related.kind === 'fact' ? summarizeRelatedItems(related.items) : [];
    if (related.kind === 'fact') {
      for (const item of related.items) mergeItemImpact(itemImpacts, item, change.status);
    }
    return { change, relatedItems, fanoutSummary };
  });

  for (const conflict of pending.conflicts) {
    const relatedItems = conflict.itemId
      ? [itemsById.get(conflict.itemId)].filter((item): item is ImpactItem => Boolean(item))
      : conflict.factKey
        ? itemsByFactKey.get(conflict.factKey) ?? []
        : [];
    for (const item of relatedItems) mergeItemImpact(itemImpacts, item, 'needs_review');
  }

  if (finalItemsById) {
    for (const item of itemImpacts.values()) applyResolvedPreview(itemImpacts, item, finalItemsById.get(item.id));
    for (const impact of changeImpacts) {
      impact.relatedItems = impact.relatedItems.map((item) => itemImpacts.get(item.id) ?? item);
    }
  }

  const protectedItems = Array.from(itemImpacts.values()).filter((item) => item.edited || item.locked || item.completed || item.stale || item.outcome === 'deleted');
  const finalCounts = countFinalOutcomes(Array.from(itemImpacts.values()));
  return { counts, changeImpacts, protectedItems, finalCounts, previewReady: Boolean(finalItemsById), previewError: previewReady && !finalItemsById };
}

function resolvePendingPreview(
  pending: NonNullable<WorkspaceView['pending']>,
  snapshot: WorkspaceView['snapshot'],
  resolutions: Resolution[],
) {
  try {
    return resolveChangeSet(pending, snapshot, resolutions);
  } catch {
    return null;
  }
}

function indexImpactItems(snapshot: WorkspaceView['snapshot']) {
  const itemsById = new Map<string, ImpactItem>();
  for (const block of snapshot.blocks) {
    for (const item of block.items) {
      itemsById.set(item.id, {
        ...item,
        blockTitle: block.title,
        blockType: block.type,
        status: 'changed',
        outcome: 'candidate',
        finalValue: null,
      });
    }
  }
  return { itemsById };
}

function applyResolvedPreview(itemImpacts: Map<string, ImpactItem>, item: ImpactItem, finalItem: ImpactItem | undefined) {
  const outcome = finalOutcomeForItem(item, finalItem);
  itemImpacts.set(item.id, {
    ...item,
    outcome,
    finalValue: finalItem?.value ?? null,
    status: outcome === 'deleted' || outcome === 'changed' ? 'changed' : outcome === 'stale' ? 'needs_review' : 'preserved',
    stale: finalItem?.stale ?? item.stale,
    edited: finalItem?.edited ?? item.edited,
    locked: finalItem?.locked ?? item.locked,
    completed: finalItem?.completed ?? item.completed,
  });
}

function finalOutcomeForItem(current: ImpactItem, finalItem: ImpactItem | undefined): ImpactOutcome {
  if (!finalItem) return 'deleted';
  if (current.label !== finalItem.label || current.value !== finalItem.value) return 'changed';
  if (!current.stale && finalItem.stale) return 'stale';
  return 'preserved';
}

function countFinalOutcomes(items: ImpactItem[]): PendingImpactReview['finalCounts'] {
  const counts: PendingImpactReview['finalCounts'] = { changed: 0, preserved: 0, deleted: 0, stale: 0 };
  for (const item of items) {
    if (item.outcome === 'candidate') continue;
    counts[item.outcome] += 1;
  }
  return counts;
}

function relatedItemsForChange(
  change: Change,
  itemsById: Map<string, ImpactItem>,
  factKeyByFactId: Map<string, string>,
  itemsByFactKey: Map<string, ImpactItem[]>,
) {
  const directItem = itemsById.get(change.targetId);
  if (directItem) return { kind: 'item' as const, items: [directItem] };
  const factKey = factKeyByFactId.get(change.targetId);
  if (factKey) return { kind: 'fact' as const, items: itemsByFactKey.get(factKey) ?? [] };
  return { kind: 'none' as const, items: [] };
}

function summarizeRelatedItems(items: ImpactItem[]) {
  const counts = new Map<Block['type'], number>();
  for (const item of items) counts.set(item.blockType, (counts.get(item.blockType) ?? 0) + 1);
  return Array.from(counts.entries()).map(([type, count]) => `${blockLabels[type]} ${count}개`);
}

function mergeItemImpact(itemImpacts: Map<string, ImpactItem>, item: ImpactItem, status: Change['status']) {
  const current = itemImpacts.get(item.id);
  const nextStatus = strongestImpactStatus(current?.status ?? status, status);
  const next = { ...item, status: nextStatus };
  itemImpacts.set(item.id, next);
  return next;
}

function strongestImpactStatus(left: Change['status'], right: Change['status']): Change['status'] {
  const rank: Record<Change['status'], number> = { changed: 1, preserved: 2, needs_review: 3 };
  return rank[right] > rank[left] ? right : left;
}

function getSampleScenario(view: WorkspaceView | null): SampleScenario | null {
  const scenario = (view as WorkspaceWithSampleScenario | null)?.sampleScenario;
  return scenario === 'travel' || scenario === 'syllabus' || scenario === 'departure' || scenario === 'coordination' ? scenario : null;
}

function getSampleActionLabels(scenario: SampleScenario | null): { update: string; conflict: string } {
  if (scenario === 'coordination') {
    return { update: '고객 미팅 정정 안내 불러오기', conflict: '완료한 준비 삭제 보기' };
  }
  if (scenario === 'departure') {
    return { update: '출발 전날 정정 안내 불러오기', conflict: '고정한 약속 변경 보기' };
  }
  if (scenario === 'syllabus') {
    return { update: '과제 마감 변경 체험', conflict: '과제 변경 확인하기' };
  }
  if (scenario === 'travel') {
    return { update: '여행 변경 자료 체험', conflict: '고정한 약속 변경 보기' };
  }
  return { update: '변경 자료 체험', conflict: '선택이 필요한 변경 보기' };
}

function displayError(failure: ApiFailure): DisplayFailure {
  return {
    title: errorLabels[failure.code] ?? '요청을 처리하지 못했습니다.',
    message: userFacingMessage(failure.message),
  };
}

function userFacingMessage(message: string): string {
  if (message.includes('OPENAI_API_KEY') || message.includes('MODEL_UNAVAILABLE')) return '실제 AI 처리가 아직 연결되지 않았습니다. 체험용 예시나 저장된 계획은 계속 볼 수 있어요.';
  if (message.includes('INTERNAL') || message.includes('internal')) return '처리 중 오류가 발생했습니다. 저장된 계획은 그대로 유지됐습니다.';
  if (message.includes('timeout') || message.includes('TIMEOUT')) return '처리 시간이 초과됐습니다. 저장된 계획은 그대로 유지됐습니다.';
  if (message.includes('Failed to fetch') || message.includes('NetworkError')) return '네트워크 요청을 완료하지 못했습니다. 다시 시도할 수 있습니다.';
  return message;
}

function ProposalReview(props: {
  pending: WorkspaceView['pending'];
  snapshot: WorkspaceView['snapshot'];
  sources: Source[];
  resolutions: Record<string, ConflictChoice>;
  disabled: boolean;
  onResolution: (conflictId: string, choice: ConflictChoice) => void;
  onAnswer: (pending: WorkspaceView['pending']) => void;
  onApply: () => void;
}) {
  if (!props.pending) {
    return (
      <section className="review-card">
        <PanelTitle icon={<RefreshCw size={18} />} title="변경 검토" detail="새 원문을 넣으면 AI가 찾은 변경 후보와 원문 근거가 여기에 표시됩니다." />
      </section>
    );
  }

  const unresolved = props.pending.conflicts.some((conflict) => !props.resolutions[conflict.id]);
  const unresolvedCount = props.pending.conflicts.filter((conflict) => !props.resolutions[conflict.id]).length;
  const review = derivePendingImpactReview(props.pending, props.snapshot, props.resolutions);
  const applyCopy = props.pending.questions.length > 0
    ? `${props.pending.questions.length}개 확인 질문에 답해야 반영할 수 있습니다.`
    : unresolvedCount > 0
      ? `${unresolvedCount}개 확인이 필요한 선택이 남아 있습니다.`
      : review.previewError
        ? '선택 결과 미리보기를 계산하지 못했습니다. 새로고침 후 다시 검토하세요.'
        : finalOutcomeSentence(review.finalCounts);
  const firstDecision = firstRequiredDecision(props.pending, props.resolutions);
  const leadingImpact = review.changeImpacts.find((impact) => impact.change.status === 'needs_review')
    ?? review.changeImpacts.find((impact) => impact.change.status === 'changed')
    ?? review.changeImpacts[0]
    ?? null;
  return (
    <section className="review-card">
        <PanelTitle icon={<RefreshCw size={18} />} title="변경 검토" detail={props.pending.summary} />
      <ReviewDecisionBanner decision={firstDecision} impact={leadingImpact} sourceCount={props.pending.changes.reduce((count, change) => count + change.evidence.length, 0)} />
      {props.pending.questions.length > 0 ? (
        <div className="question-box">
          <strong>확인 질문</strong>
          {props.pending.questions.map((question) => <p key={question}>{question}</p>)}
          <button type="button" className="ghost-button" disabled={props.disabled} onClick={() => props.onAnswer(props.pending)}>
            추가 정보로 답변
          </button>
        </div>
      ) : null}
      {props.pending.conflicts.length > 0 ? (
        <div className="conflicts">
        <h3>확인이 필요한 변경</h3>
          {props.pending.conflicts.map((conflict) => (
            <ConflictResolver key={conflict.id} conflict={conflict} change={props.pending?.changes.find((change) => change.targetId === (conflict.itemId ?? props.snapshot.facts.find((fact) => fact.key === conflict.factKey)?.id))} choice={props.resolutions[conflict.id]} disabled={props.disabled} onResolution={props.onResolution} />
          ))}
        </div>
      ) : null}
      <ImpactSummary review={review} questionCount={props.pending.questions.length} unresolvedCount={unresolvedCount} />
      <ProtectedStateLedger items={review.protectedItems} previewReady={review.previewReady} />
      <div className="change-list">
        {review.changeImpacts.map((impact) => <ChangeRow key={impact.change.id} impact={impact} sources={props.sources} />)}
      </div>
      <p className={unresolved || props.pending.questions.length > 0 ? 'apply-readiness blocked' : 'apply-readiness'}>
        {applyCopy}
      </p>
      <button type="button" className="primary-action apply-action" disabled={props.disabled || unresolved || props.pending.questions.length > 0 || review.previewError} onClick={props.onApply}>
        <CheckCircle2 size={17} />
        확인한 변경 저장
      </button>
    </section>
  );
}

function firstRequiredDecision(pending: NonNullable<WorkspaceView['pending']>, resolutions: Record<string, ConflictChoice>) {
  if (pending.questions[0]) return { kind: 'question' as const, label: '추가 정보 필요', detail: `아래 확인 질문 ${pending.questions.length}개에 답하면 다시 검토할 수 있습니다.` };
  const conflict = pending.conflicts.find((candidate) => !resolutions[candidate.id]);
  if (conflict) return { kind: 'conflict' as const, label: conflictKindLabel(conflict.kind), detail: conflictGuidance(conflict) };
  return { kind: 'ready' as const, label: '바로 저장 가능', detail: '남은 질문이나 선택이 없습니다. 아래 전후 값과 근거를 확인한 뒤 저장할 수 있습니다.' };
}

function ReviewDecisionBanner({
  decision,
  impact,
  sourceCount,
}: {
  decision: ReturnType<typeof firstRequiredDecision>;
  impact: ChangeImpact | null;
  sourceCount: number;
}) {
  return (
    <section className={`review-decision ${decision.kind}`} aria-label="검토 우선순위">
      <div>
        <span>필수 판단</span>
        <strong>{decision.label}</strong>
        <p>{decision.detail}</p>
      </div>
      <div>
        <span>대표 변경</span>
        {impact ? (
          <>
            <strong>{impact.change.label}</strong>
            <p>{impact.change.before || '없음'} → {impact.change.after || '없음'}</p>
          </>
        ) : (
          <>
            <strong>변경 없음</strong>
            <p>검토할 전후 값이 없습니다.</p>
          </>
        )}
      </div>
      <div>
        <span>근거</span>
        <strong>{sourceCount}개 인용</strong>
        <p>각 변경에서 인용한 원문을 펼쳐 확인할 수 있습니다.</p>
      </div>
    </section>
  );
}

function finalOutcomeSentence(counts: PendingImpactReview['finalCounts']) {
  const parts = [
    counts.changed > 0 ? `항목 변경 ${counts.changed}개` : null,
    counts.deleted > 0 ? `삭제 ${counts.deleted}개` : null,
    counts.stale > 0 ? `확인 필요 유지 ${counts.stale}개` : null,
    counts.preserved > 0 ? `값 보존 ${counts.preserved}개` : null,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? `저장하면 ${parts.join(' · ')}입니다.` : '저장해도 현재 항목 값은 바뀌지 않습니다.';
}

function ImpactSummary({ review, questionCount, unresolvedCount }: { review: PendingImpactReview; questionCount: number; unresolvedCount: number }) {
  return (
    <section className="impact-summary" aria-label="변경 영향 요약">
      <div className="impact-meter changed">
        <strong>{review.counts.changed}</strong>
        <span>{reviewMetricLabels.changed}</span>
      </div>
      <div className="impact-meter preserved">
        <strong>{review.counts.preserved}</strong>
        <span>{reviewMetricLabels.preserved}</span>
      </div>
      <div className="impact-meter needs_review">
        <strong>{review.counts.needs_review}</strong>
        <span>{reviewMetricLabels.needs_review}</span>
      </div>
      <div className={questionCount + unresolvedCount > 0 ? 'impact-meter blocked' : 'impact-meter ready'}>
        <strong>{questionCount + unresolvedCount}</strong>
        <span>저장 전 선택</span>
      </div>
    </section>
  );
}

function ProtectedStateLedger({ items, previewReady }: { items: ImpactItem[]; previewReady: boolean }) {
  if (items.length === 0) {
    return (
      <section className="protected-ledger" aria-label="보호 상태">
        <div className="ledger-empty">
          <ShieldCheck size={16} />
          <span>이번 변경에서 확인할 고정·완료·직접 수정 상태가 없습니다.</span>
        </div>
      </section>
    );
  }

  return (
    <section className="protected-ledger" aria-label="보호 상태">
      <h3>내가 정한 상태 영향</h3>
      <div className="ledger-list">
        {items.map((item) => {
          const StatusIcon = statusCopy[item.status].icon;
          return (
            <article key={item.id} className={`ledger-item ${item.status}`}>
              <div>
                <strong>{item.label}</strong>
                <span>{blockLabels[item.blockType]} · {item.blockTitle}</span>
              </div>
              <p className="outcome-line">{previewReady ? outcomeLine(item) : '선택 후 저장 결과가 확정됩니다.'}</p>
              <div className="ledger-badges">
                <span><StatusIcon size={13} /> {ledgerStatusLabels[item.status]}</span>
                {item.edited ? <span><Pencil size={13} /> 직접 수정</span> : null}
                {item.locked ? <span><Lock size={13} /> 고정</span> : null}
                {item.completed ? <span><CheckCircle2 size={13} /> {item.stale ? '이전 완료' : '완료'}</span> : null}
                {item.stale ? <span><AlertTriangle size={13} /> 확인 필요</span> : null}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function outcomeLine(item: ImpactItem) {
  if (item.outcome === 'deleted') return '저장 후 이 항목은 삭제됩니다.';
  if (item.outcome === 'changed' && item.finalValue !== null) return `저장 후 값: ${formatItemValue(item.blockType, item.finalValue)}`;
  if (item.outcome === 'stale') return '기존 값은 유지되고 확인 대상으로 남습니다.';
  if (item.outcome === 'preserved') return '현재 값과 사용자 상태가 유지됩니다.';
  return '선택 후 저장 결과가 확정됩니다.';
}

function ChangeRow({ impact, sources }: { impact: ChangeImpact; sources: Source[] }) {
  const { change } = impact;
  const StatusIcon = statusCopy[change.status].icon;
  return (
    <article className={`change-row ${change.status}`}>
      <div className="change-head">
        <span className="change-state"><StatusIcon size={14} /> {statusCopy[change.status].label}</span>
        <strong>{change.label}</strong>
      </div>
      <div className="before-after">
        <p><span>이전</span>{change.before || '없음'}</p>
        <p><span>AI 제안</span>{change.after || '없음'}</p>
      </div>
      {impact.relatedItems.length > 0 || impact.fanoutSummary.length > 0 ? (
        <div className="related-items" aria-label={`${change.label} 관련 항목`}>
          <span>영향 항목</span>
          {impact.fanoutSummary.length > 0 ? (
            <div className="related-item scope">
              <strong>{impact.fanoutSummary.join(' · ')}</strong>
              <small>현재 작업 공간에서 이 원문 사실을 참조하는 범위</small>
            </div>
          ) : null}
          {impact.relatedItems.map((item) => (
            <div key={item.id} className="related-item">
              <strong>{item.label}</strong>
              <small>{blockLabels[item.blockType]} · {item.blockTitle}</small>
              <small>{outcomeLine(item)}</small>
              <ItemProtectionBadges item={item} />
            </div>
          ))}
        </div>
      ) : null}
      <p className="reason">{changeReasonLine(impact)}</p>
      <EvidenceDetails evidence={change.evidence} sources={sources} />
    </article>
  );
}

function changeReasonLine(impact: ChangeImpact) {
  const relatedCount = impact.relatedItems.length + impact.fanoutSummary.length;
  const scope = relatedCount > 0 ? ` 관련 항목 ${relatedCount}개와 연결됩니다.` : '';
  const evidence = impact.change.evidence.length > 0 ? ' 저장된 원문 인용을 근거로 표시합니다.' : ' 원문 인용이 없는 변경은 저장 전에 더 확인해야 합니다.';
  return `${changeStatusReasons[impact.change.status]}${scope}${evidence}`;
}

function ItemProtectionBadges({ item }: { item: ImpactItem }) {
  if (!item.edited && !item.locked && !item.completed && !item.stale && !item.calculation && !item.preparation) return null;
  return (
    <span className="mini-badges">
      {item.edited ? <span><Pencil size={12} /> 직접 수정</span> : null}
      {item.locked ? <span><Lock size={12} /> 고정</span> : null}
      {item.completed ? <span><CheckCircle2 size={12} /> 완료</span> : null}
      {item.stale ? <span><AlertTriangle size={12} /> 확인 필요</span> : null}
      {item.preparation?.dueDate ? <span><Clock size={12} /> {item.preparation.dueDate}</span> : null}
      {item.preparation?.durationMinutes ? <span><Clock size={12} /> {item.preparation.durationMinutes}분</span> : null}
      {item.calculation ? <span>자동 계산</span> : null}
    </span>
  );
}

function ConflictResolver(props: {
  conflict: Conflict;
  change: Change | undefined;
  choice: ConflictChoice | undefined;
  disabled: boolean;
  onResolution: (conflictId: string, choice: ConflictChoice) => void;
}) {
  return (
    <article className="conflict-row">
      <AlertTriangle size={16} />
      <div>
        {props.change ? <p><strong>{props.change.label}</strong> · {props.change.before || '없음'} → {props.change.after || (props.conflict.kind === 'deletion' ? '삭제 요청' : '없음')}</p> : null}
        <strong>{conflictKindLabel(props.conflict.kind)}</strong>
        <p>{conflictGuidance(props.conflict)}</p>
        <div className="resolution-tabs" role="group" aria-label={props.change ? `${props.change.label} 확인 선택` : '확인 선택'}>
          <button type="button" className={props.choice === 'keep_user' ? 'selected' : ''} aria-pressed={props.choice === 'keep_user'} disabled={props.disabled} onClick={() => props.onResolution(props.conflict.id, 'keep_user')}>
            내 결정 유지
          </button>
          <button type="button" className={props.choice === 'use_source' ? 'selected' : ''} aria-pressed={props.choice === 'use_source'} disabled={props.disabled} onClick={() => props.onResolution(props.conflict.id, 'use_source')}>
            새 원문 값 사용
          </button>
        </div>
      </div>
    </article>
  );
}

function conflictKindLabel(kind: Conflict['kind']) {
  if (kind === 'locked') return '고정한 결정과 새 원문이 다릅니다.';
  if (kind === 'deletion') return '보호된 항목을 삭제할지 선택해야 합니다.';
  return '같은 사실에 서로 다른 원문 근거가 있어 확인이 필요합니다.';
}

function conflictGuidance(conflict: Conflict) {
  if (conflict.kind === 'locked') return '내 결정 유지는 현재 값을 보존하고, 새 원문 값 사용은 새 안내 값을 저장합니다.';
  if (conflict.kind === 'deletion') return '완료·고정·직접 수정한 항목은 사용자가 선택해야 삭제할 수 있습니다.';
  return conflict.factKey
    ? `사실 키 ${conflict.factKey}에 대해 기존 근거와 새 근거 중 어느 쪽을 믿을지 선택합니다.`
    : '기존 근거와 새 근거 중 어느 쪽을 믿을지 선택합니다.';
}

function EvidenceDetails({ evidence, sources }: { evidence: Evidence[]; sources: Source[] }) {
  if (evidence.length === 0) return null;
  return (
    <details className="evidence">
      <summary>근거 보기</summary>
      {evidence.map((entry, index) => {
        const source = sources.find((candidate) => candidate.id === entry.sourceId);
        return (
          <blockquote key={`${entry.sourceId}-${entry.start}-${entry.end}-${index}`}>
            <strong>{source?.title ?? '저장된 원문'}</strong>
            <mark>{entry.quote}</mark>
          </blockquote>
        );
      })}
    </details>
  );
}

function HistoryPanel({ history, currentRevision, disabled, onRestore }: { history: RevisionSummary[]; currentRevision: number; disabled: boolean; onRestore: (revision: RevisionSummary) => void }) {
  return (
    <section className="review-card">
      <PanelTitle icon={<History size={18} />} title="변경 이력" detail="복원하면 이전 저장된 계획을 새 버전으로 다시 저장합니다." />
      <div className="history-list">
        {history.length === 0 ? <p className="muted">아직 복원할 이력이 없습니다.</p> : history.map((revision) => (
          <article key={`${revision.revision}-${revision.createdAt}`} className={revision.revision === currentRevision ? 'history-row current' : 'history-row'}>
            <div>
              <strong>저장된 계획 {revision.revision}</strong>
              <small>{formatDate(revision.createdAt)} · {formatRevisionReason(revision.reason)}</small>
            </div>
            <button type="button" aria-label={`${revision.revision}번 저장된 계획 복원`} disabled={disabled || revision.revision === currentRevision} onClick={() => onRestore(revision)}>
              <RotateCcw size={15} />
            </button>
          </article>
        ))}
      </div>
    </section>
  );
}

function DeletePanel(props: { confirmDelete: boolean; disabled: boolean; expiresAt: string; onToggle: (value: boolean) => void; onDelete: () => void }) {
  return (
    <section className="review-card danger-zone">
      <PanelTitle icon={<Trash2 size={18} />} title="데이터 관리" detail={`예상 만료: ${formatDate(props.expiresAt)}`} />
      {props.confirmDelete ? (
        <div className="delete-confirm">
          <p>이 브라우저 소유의 작업 공간과 저장 원문을 삭제합니다.</p>
          <button type="button" className="danger-button" disabled={props.disabled} onClick={props.onDelete}>영구 삭제</button>
          <button type="button" disabled={props.disabled} onClick={() => props.onToggle(false)}>취소</button>
        </div>
      ) : (
        <button type="button" className="ghost-button" disabled={props.disabled} onClick={() => props.onToggle(true)}>
          <Trash2 size={16} />
          작업 공간 삭제
        </button>
      )}
    </section>
  );
}

function EmptyWorkspace() {
  return (
    <div className="empty-workspace">
      <FileText size={26} />
      <h2>작업 공간이 비어 있습니다.</h2>
      <p>체험용 예시를 열거나 원문을 붙여넣으면 일정, 비용, 체크리스트, 안내 블록이 생성됩니다.</p>
    </div>
  );
}

export { WorkspaceApp };
export default WorkspaceApp;
