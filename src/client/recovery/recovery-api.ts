import type { CalendarBootstrapResponse, CalendarConnectResponse, CalendarConnectionSummary, CalendarDisconnectResponse } from '../../core/calendar-contracts';
import type { RecoveryView } from '../../core/recovery-api-contracts';
import type { RecoveryInput } from '../../core/scheduling-contracts';
import type { RecoveryApiFailure } from './recovery-types';

export type RecoveryApi = {
  loadWorkspaceRecovery: (workspaceId: string, signal?: AbortSignal) => Promise<RecoveryView>;
  createWorkspace: (input: { requestId: string; recoveryInput: RecoveryInput }, signal?: AbortSignal) => Promise<RecoveryView>;
  previewPlan: (input: { workspaceId: string; requestId: string; recoveryInput: RecoveryInput; baseRevision: number; conditionRevision: number }, signal?: AbortSignal) => Promise<RecoveryView>;
  applyPlan: (input: { workspaceId: string; proposalId: string; baseRevision: number; conditionRevision: number; requestId: string }, signal?: AbortSignal) => Promise<RecoveryView>;
  enqueueCalendar: (input: { workspaceId: string; baseRevision: number; conditionRevision: number; requestId: string }, signal?: AbortSignal) => Promise<RecoveryView>;
  enqueueEmail: (input: { workspaceId: string; baseRevision: number; conditionRevision: number; requestId: string; recipient: string; subject: string; body: string }, signal?: AbortSignal) => Promise<RecoveryView>;
  calendarStatus: (signal?: AbortSignal) => Promise<CalendarConnectionSummary>;
  connectCalendar: (input: { includeEmail?: boolean }, signal?: AbortSignal) => Promise<CalendarConnectResponse>;
  connectEmail: (signal?: AbortSignal) => Promise<CalendarConnectResponse>;
  bootstrapCalendar: (signal?: AbortSignal) => Promise<CalendarBootstrapResponse>;
  adoptCalendar: (input: { calendarId: string }, signal?: AbortSignal) => Promise<CalendarConnectionSummary>;
  disconnectCalendar: (signal?: AbortSignal) => Promise<CalendarDisconnectResponse>;
};

export const defaultRecoveryApi: RecoveryApi = {
  async loadWorkspaceRecovery(workspaceId, signal) {
    return readJson<RecoveryView>(`/api/workspaces/${encodeURIComponent(workspaceId)}/recovery`, { signal });
  },
  async createWorkspace(input, signal) {
    return readJson<RecoveryView>('/api/recovery/workspaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: input.recoveryInput, requestId: input.requestId }),
      signal,
    });
  },
  async previewPlan(input, signal) {
    return readJson<RecoveryView>(`/api/workspaces/${encodeURIComponent(input.workspaceId)}/recovery/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: input.recoveryInput, baseRevision: input.baseRevision, conditionRevision: input.conditionRevision, requestId: input.requestId }),
      signal,
    });
  },
  async applyPlan(input, signal) {
    return readJson<RecoveryView>(`/api/workspaces/${encodeURIComponent(input.workspaceId)}/recovery/apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ proposalId: input.proposalId, baseRevision: input.baseRevision, conditionRevision: input.conditionRevision, requestId: input.requestId }),
      signal,
    });
  },
  async enqueueCalendar(input, signal) {
    return readJson<RecoveryView>(`/api/workspaces/${encodeURIComponent(input.workspaceId)}/recovery/calendar`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ baseRevision: input.baseRevision, conditionRevision: input.conditionRevision, requestId: input.requestId, approved: true }),
      signal,
    });
  },
  async enqueueEmail(input, signal) {
    return readJson<RecoveryView>(`/api/workspaces/${encodeURIComponent(input.workspaceId)}/recovery/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ baseRevision: input.baseRevision, conditionRevision: input.conditionRevision, requestId: input.requestId, recipient: input.recipient, subject: input.subject, body: input.body, approved: true }),
      signal,
    });
  },
  async calendarStatus(signal) {
    return readJson<CalendarConnectionSummary>('/api/calendar/status', { signal });
  },
  async connectCalendar(input, signal) {
    return readJson<CalendarConnectResponse>('/api/calendar/connect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ includeEmail: Boolean(input.includeEmail) }),
      signal,
    });
  },
  async connectEmail(signal) {
    return readJson<CalendarConnectResponse>('/api/calendar/connect-email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
      signal,
    });
  },
  async bootstrapCalendar(signal) {
    return readJson<CalendarBootstrapResponse>('/api/calendar/bootstrap', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
      signal,
    });
  },
  async adoptCalendar(input, signal) {
    return readJson<CalendarConnectionSummary>('/api/calendar/adopt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ calendarId: input.calendarId }),
      signal,
    });
  },
  async disconnectCalendar(signal) {
    return readJson<CalendarDisconnectResponse>('/api/calendar/disconnect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
      signal,
    });
  },
};

export function recoveryFailureMessage(error: unknown, fallback: string): string {
  if (isRecoveryApiFailure(error)) return friendlyRecoveryMessage(error, error.message);
  if (error instanceof DOMException && error.name === 'AbortError') return '요청이 취소되었습니다. 화면의 최신 값을 기준으로 다시 시도해 주세요.';
  return fallback;
}

function friendlyRecoveryMessage(error: RecoveryApiFailure, fallback: string): string {
  const messages: Record<string, string> = {
    UNAUTHORIZED: '로그인 또는 게스트 권한이 만료되었습니다. 같은 작업 공간 권한으로 다시 열어 주세요.',
    WORKSPACE_NOT_FOUND: '작업 공간을 찾을 수 없습니다. 삭제됐거나 현재 계정의 작업 공간이 아닙니다.',
    RECOVERY_NOT_FOUND: '저장된 일정 조정안을 찾을 수 없습니다. 원래 작업 공간에서 다시 만들어 주세요.',
    STALE_RECOVERY_APPROVAL: '원래 계획이나 조건이 먼저 바뀌었습니다. 최신 상태로 다시 계산해 주세요.',
    STALE_REVISION: '원래 계획이나 원문이 먼저 바뀌었습니다. 최신 상태에서 다시 확인해 주세요.',
    RECOVERY_NOT_READY: '아직 적용할 수 있는 일정 조정안이 없습니다. 확인이 필요한 조건을 먼저 해결해 주세요.',
    RECOVERY_INVALID_RESULT: '현재 조건을 만족하지 않는 결과입니다. 시간을 다시 확인해 주세요.',
    RECOVERY_TIME_PASSED: '이미 시작한 일정이 있어 Calendar에 반영할 수 없습니다. 미래 일정으로 다시 확인해 주세요.',
    RECOVERY_ACCOUNT_REQUIRED: 'Calendar나 이메일 반영은 Google 계정 연결 후 사용할 수 있습니다.',
    RECOVERY_ACTION_ACTIVE: '이미 처리 중인 외부 작업이 있습니다. 처리 기록을 확인한 뒤 다시 시도해 주세요.',
    RECOVERY_ACTION_LIMIT: '이 작업 공간의 외부 처리 기록 한도에 도달했습니다.',
    RECOVERY_ACTION_CONFLICT: '작업 상태가 바뀌어 외부 반영을 예약하지 못했습니다. 최신 상태를 다시 확인해 주세요.',
  };
  return messages[error.code] ?? fallback;
}

async function readJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, { credentials: 'same-origin', ...init });
  const payload = await readPayload(response);
  if (!response.ok) throw readFailure(payload, response.status);
  return payload as T;
}

async function readPayload(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

function readFailure(payload: unknown, status: number): RecoveryApiFailure {
  if (isRecoveryApiFailure(payload)) return { ...payload, status };
  if (typeof payload === 'object' && payload && 'error' in payload && isRecoveryApiFailure((payload as { error?: unknown }).error)) return { ...(payload as { error: RecoveryApiFailure }).error, status };
  return { code: status === 401 ? 'UNAUTHORIZED' : 'REQUEST_FAILED', message: '요청을 처리하지 못했습니다. 최신 상태를 확인한 뒤 다시 시도해 주세요.', status };
}

function isRecoveryApiFailure(value: unknown): value is RecoveryApiFailure {
  return typeof value === 'object' && value !== null &&
    typeof (value as { code?: unknown }).code === 'string' &&
    typeof (value as { message?: unknown }).message === 'string';
}
