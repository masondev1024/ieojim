import { accountUsageSchema, type AccountState, type AccountUsage, type ClaimGuestInput, type GuestClaimResult } from '../../core/account-contracts';

export type AccountFailure = { code: string; message: string; status?: number };
export type AccountIdentityMessage = { type: 'identity-change'; reason: string; sourceId: string };

const accountTimeoutMs = 15_000;
const accountIdentitySourceId = crypto.randomUUID();

export async function readAccountState(signal?: AbortSignal): Promise<AccountState> {
  return accountRequest<AccountState>('/api/account', { signal });
}

export async function readAccountUsage(signal?: AbortSignal): Promise<AccountUsage> {
  const payload = await accountRequest<unknown>('/api/account/usage', { signal });
  const result = accountUsageSchema.safeParse(payload);
  if (!result.success) {
    throw { code: 'INVALID_RESPONSE', message: '사용량 정보를 확인하지 못했어요. 다시 불러와 주세요.' } satisfies AccountFailure;
  }
  return result.data;
}

export async function startLogin(signal?: AbortSignal): Promise<{ url: string }> {
  return accountRequest<{ url: string }>('/api/account/login', { method: 'POST', body: JSON.stringify({}), signal });
}

export async function logout(signal?: AbortSignal): Promise<void> {
  await accountRequest<void>('/api/account/logout', { method: 'POST', body: JSON.stringify({}), signal });
}

export async function revokeOtherSessions(signal?: AbortSignal): Promise<{ revoked: true }> {
  return accountRequest<{ revoked: true }>('/api/account/revoke-other-sessions', { method: 'POST', body: JSON.stringify({}), signal });
}

export async function claimGuestWorkspaces(input: ClaimGuestInput, signal?: AbortSignal): Promise<GuestClaimResult> {
  return accountRequest<GuestClaimResult>('/api/account/claim', { method: 'POST', body: JSON.stringify(input), signal });
}

export function newAccountRequestId(): string {
  return crypto.randomUUID();
}

export function accountIdentityKey(state: AccountState | null): string {
  return state?.user?.id ? `user:${state.user.id}` : 'guest';
}

export function broadcastIdentityChange(reason: string): void {
  const message = { type: 'identity-change', reason, sourceId: accountIdentitySourceId } satisfies AccountIdentityMessage;
  try {
    const channel = new BroadcastChannel('ieojim-identity');
    channel.postMessage(message);
    channel.close();
  } catch {
    window.dispatchEvent(new CustomEvent('ieojim-identity-change', { detail: message }));
  }
}

export function isExternalIdentityMessage(value: unknown): value is AccountIdentityMessage {
  return typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    'reason' in value &&
    'sourceId' in value &&
    (value as { type?: unknown }).type === 'identity-change' &&
    typeof (value as { reason?: unknown }).reason === 'string' &&
    typeof (value as { sourceId?: unknown }).sourceId === 'string' &&
    (value as { sourceId?: unknown }).sourceId !== accountIdentitySourceId;
}

export function readGenericOauthError(search: string): string | null {
  return new URLSearchParams(search).has('error') ? 'Google 로그인을 마치지 못했어요. 다시 시도하거나 로그인 없이 계속 사용할 수 있어요.' : null;
}

export function isAccountFailure(value: unknown): value is AccountFailure {
  return typeof value === 'object' && value !== null && 'code' in value && 'message' in value;
}

export function accountFailureMessage(error: AccountFailure): string {
  const known: Record<string, string> = {
    AUTH_UNAVAILABLE: '지금은 계정 연결을 사용할 수 없어요. 로그인 없이 작업은 계속할 수 있어요.',
    LOGIN_UNAVAILABLE: 'Google 로그인을 시작할 수 없습니다. 잠시 뒤 다시 시도해 주세요.',
    CLAIM_PREVIEW_STALE: '옮길 작업 목록이 바뀌었습니다. 새 목록을 불러온 뒤 다시 확인해 주세요.',
    LOGIN_REQUIRED: '로그인 상태를 확인할 수 없습니다. 다시 로그인해 주세요.',
    UNAUTHORIZED: '로그인 상태를 확인할 수 없습니다. 다시 로그인해 주세요.',
    REQUEST_TIMEOUT: '응답이 오래 걸리고 있어요. 잠시 뒤 같은 작업을 다시 시도해 주세요.',
    INVALID_RESPONSE: '계정 정보를 확인하지 못했어요. 다시 불러와 주세요.',
  };
  return known[error.code] ?? error.message;
}

async function accountRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), accountTimeoutMs);
  const abortFromParent = () => controller.abort();
  if (init.signal?.aborted) controller.abort();
  else init.signal?.addEventListener('abort', abortFromParent, { once: true });
  try {
    const response = await fetch(path, {
      ...init,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
    if (response.status === 204) return undefined as T;
    const payload = await readPayload(response);
    if (!response.ok) throw readFailure(payload, response.status);
    return payload as T;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw { code: 'REQUEST_TIMEOUT', message: '요청 시간이 초과됐습니다.', status: 408 } satisfies AccountFailure;
    }
    if (isAccountFailure(error)) throw error;
    throw readFailure(error, undefined);
  } finally {
    init.signal?.removeEventListener('abort', abortFromParent);
    window.clearTimeout(timeout);
  }
}

async function readPayload(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw { code: 'INVALID_RESPONSE', message: '계정 정보를 확인하지 못했어요. 다시 불러와 주세요.', status: response.status } satisfies AccountFailure;
  }
}

function readFailure(payload: unknown, status: number | undefined): AccountFailure {
  if (isAccountFailure(payload)) return { ...payload, status };
  if (typeof payload === 'object' && payload !== null && 'error' in payload) {
    const error = (payload as { error?: { code?: unknown; message?: unknown } }).error;
    if (error && typeof error.code === 'string' && typeof error.message === 'string') {
      return { code: error.code, message: error.message, status };
    }
  }
  if (payload instanceof Error) return { code: payload.name || 'REQUEST_FAILED', message: '계정 요청을 처리하지 못했습니다.', status };
  return { code: status === 401 ? 'UNAUTHORIZED' : 'REQUEST_FAILED', message: '계정 요청을 처리하지 못했습니다.', status };
}
