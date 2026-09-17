import { ArrowRight, CheckCircle2, LogOut, RefreshCw, ShieldCheck, Smartphone, UserRound } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AccountState, AccountUsage, GuestClaimPreview } from '../../core/account-contracts';
import {
  accountFailureMessage,
  accountIdentityKey,
  broadcastIdentityChange,
  claimGuestWorkspaces,
  isAccountFailure,
  isExternalIdentityMessage,
  logout,
  newAccountRequestId,
  readAccountState,
  readAccountUsage,
  revokeOtherSessions,
} from './account-api';
import './account.css';

type PageStatus = 'loading' | 'ready' | 'claiming' | 'revoking' | 'logging-out' | 'error';
type UsageStatus = 'idle' | 'loading' | 'ready' | 'error';

export default function AccountPage() {
  const [account, setAccount] = useState<AccountState | null>(null);
  const [status, setStatus] = useState<PageStatus>('loading');
  const [message, setMessage] = useState<string | null>(null);
  const [claimConsent, setClaimConsent] = useState(false);
  const [claimRequest, setClaimRequest] = useState<{ requestId: string; previewHash: string } | null>(null);
  const [claimResult, setClaimResult] = useState<string | null>(null);
  const [usage, setUsage] = useState<AccountUsage | null>(null);
  const [usageStatus, setUsageStatus] = useState<UsageStatus>('idle');
  const [usageMessage, setUsageMessage] = useState<string | null>(null);
  const requestEpoch = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const previousIdentity = useRef<string | null>(null);
  const initialized = useRef(false);

  const clearPrivateState = useCallback(() => {
    setAccount(null);
    setUsage(null);
    setUsageStatus('idle');
    setUsageMessage(null);
    setClaimConsent(false);
    setClaimRequest(null);
    setClaimResult(null);
  }, []);

  const refresh = useCallback(async (options: { resetConsent?: boolean; message?: string } = {}) => {
    const epoch = requestEpoch.current + 1;
    requestEpoch.current = epoch;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setStatus('loading');
    setMessage(options.message ?? null);
    setUsageMessage(null);
    try {
      const next = await readAccountState(controller.signal);
      if (requestEpoch.current !== epoch || controller.signal.aborted) return;
      const nextIdentity = accountIdentityKey(next);
      if (initialized.current && previousIdentity.current !== nextIdentity) {
        clearPrivateState();
        window.location.replace('/app');
        return;
      }
      initialized.current = true;
      previousIdentity.current = nextIdentity;
      setAccount(next);
      setStatus('ready');
      if (options.resetConsent) {
        setClaimConsent(false);
        setClaimRequest(null);
      }
      if (!next.user) {
        setUsage(null);
        setUsageStatus('idle');
        return;
      }
      setUsageStatus('loading');
      try {
        const nextUsage = await readAccountUsage(controller.signal);
        if (requestEpoch.current !== epoch || controller.signal.aborted) return;
        setUsage(nextUsage);
        setUsageStatus('ready');
      } catch (error) {
        if (requestEpoch.current !== epoch || controller.signal.aborted) return;
        setUsage(null);
        if (isAccountFailure(error) && error.status === 401) {
          clearPrivateState();
          if (initialized.current && previousIdentity.current !== 'guest') {
            previousIdentity.current = 'guest';
            window.location.replace('/app');
            return;
          }
          initialized.current = true;
          previousIdentity.current = 'guest';
        }
        setUsageMessage(isAccountFailure(error) ? accountFailureMessage(error) : '사용량을 불러오지 못했습니다.');
        setUsageStatus('error');
      }
    } catch (error) {
      if (requestEpoch.current !== epoch || controller.signal.aborted) return;
      setUsage(null);
      setUsageStatus('idle');
      setUsageMessage(null);
      if (isAccountFailure(error) && error.status === 401) {
        clearPrivateState();
        if (initialized.current && previousIdentity.current !== 'guest') {
          previousIdentity.current = 'guest';
          window.location.replace('/app');
          return;
        }
        initialized.current = true;
        previousIdentity.current = 'guest';
      }
      setMessage(isAccountFailure(error) ? accountFailureMessage(error) : '계정 상태를 확인하지 못했습니다.');
      setStatus('error');
    }
  }, [clearPrivateState]);

  useEffect(() => {
    void refresh();
    const onFocus = () => void refresh();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    const clearAndLeaveAccount = () => {
      clearPrivateState();
      window.location.replace('/app');
    };
    const onLocalIdentityChange = (event: Event) => {
      if (event instanceof CustomEvent && !isExternalIdentityMessage(event.detail)) return;
      clearAndLeaveAccount();
    };
    window.addEventListener('ieojim-identity-change', onLocalIdentityChange);
    const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('ieojim-identity') : null;
    const onBroadcastIdentityChange = (event: MessageEvent<unknown>) => {
      if (!isExternalIdentityMessage(event.data)) return;
      clearAndLeaveAccount();
    };
    channel?.addEventListener('message', onBroadcastIdentityChange);
    return () => {
      controllerRef.current?.abort();
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('ieojim-identity-change', onLocalIdentityChange);
      channel?.removeEventListener('message', onBroadcastIdentityChange);
      channel?.close();
    };
  }, [clearPrivateState, refresh]);

  useEffect(() => {
    setClaimConsent(false);
    setClaimRequest(null);
  }, [account?.guestPreview?.previewHash, account?.user?.id]);

  async function submitClaim(preview: GuestClaimPreview) {
    if (!account?.user || !claimConsent) return;
    const input = claimRequest?.previewHash === preview.previewHash ? claimRequest : {
      requestId: newAccountRequestId(),
      previewHash: preview.previewHash,
    };
    setClaimRequest(input);
    const epoch = requestEpoch.current + 1;
    requestEpoch.current = epoch;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setStatus('claiming');
    setMessage(null);
    setClaimResult(null);
    try {
      const result = await claimGuestWorkspaces(input, controller.signal);
      if (requestEpoch.current !== epoch || controller.signal.aborted) return;
      setClaimResult(`${result.claimedCount}개 작업 공간을 계정으로 옮겼습니다.`);
      setClaimConsent(false);
      setClaimRequest(null);
      await refresh({ resetConsent: true });
    } catch (error) {
      if (requestEpoch.current !== epoch || controller.signal.aborted) return;
      if (isAccountFailure(error) && error.status === 409) {
        setClaimConsent(false);
        setClaimRequest(null);
        await refresh({ resetConsent: true, message: accountFailureMessage({ ...error, code: 'CLAIM_PREVIEW_STALE' }) });
        return;
      }
      setMessage(isAccountFailure(error) ? accountFailureMessage(error) : '작업 공간을 옮기지 못했습니다.');
      setStatus('error');
    }
  }

  async function submitRevoke() {
    const epoch = requestEpoch.current + 1;
    requestEpoch.current = epoch;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setStatus('revoking');
    setMessage(null);
    try {
      await revokeOtherSessions(controller.signal);
      if (requestEpoch.current !== epoch || controller.signal.aborted) return;
      broadcastIdentityChange('revoke-other-sessions');
      await refresh({ message: '다른 기기에서 로그아웃했어요.' });
    } catch (error) {
      if (requestEpoch.current !== epoch || controller.signal.aborted) return;
      setMessage(isAccountFailure(error) ? accountFailureMessage(error) : '다른 기기에서 로그아웃하지 못했어요. 잠시 뒤 다시 시도해 주세요.');
      setStatus('error');
    }
  }

  async function submitLogout() {
    const epoch = requestEpoch.current + 1;
    requestEpoch.current = epoch;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setStatus('logging-out');
    setMessage(null);
    try {
      await logout(controller.signal);
      if (requestEpoch.current !== epoch || controller.signal.aborted) return;
      clearPrivateState();
      broadcastIdentityChange('logout');
      window.location.replace('/app');
    } catch (error) {
      if (requestEpoch.current !== epoch || controller.signal.aborted) return;
      setMessage(isAccountFailure(error) ? accountFailureMessage(error) : '로그아웃하지 못했습니다.');
      setStatus('error');
    }
  }

  const user = account?.user ?? null;
  const preview = account?.guestPreview ?? null;
  const expiresAt = useMemo(() => formatDateTime(account?.sessionExpiresAt), [account?.sessionExpiresAt]);
  const retentionDays = account?.retentionDays ?? 7;

  return (
    <main className="account-page" aria-busy={status === 'loading' || status === 'claiming' || status === 'revoking' || status === 'logging-out'}>
      <section className="account-hero" aria-labelledby="account-title">
        <Link className="account-brand" to="/">이어짐</Link>
        <p className="account-kicker">설정</p>
        <h1 id="account-title">계정과 게스트 작업 공간</h1>
        <p className="account-lede">
          로그인한 기기와 작업 공간을 관리해요. 작업 공간은 마지막으로 열거나 수정한 날부터{' '}
          {retentionDays}일 동안 보관돼요.
        </p>
        {message ? <p className="account-alert" role="alert">{message}</p> : null}
        {claimResult ? <p className="account-success" role="status">{claimResult}</p> : null}
      </section>

      <section className="account-grid">
        <AccountIdentityPanel account={account} status={status} expiresAt={expiresAt} onRefresh={() => void refresh({ resetConsent: true })} />
        <AccountUsagePanel signedIn={Boolean(user)} usage={usage} status={usageStatus} message={usageMessage} onRefresh={() => void refresh({ resetConsent: true })} />
        <GuestClaimPanel
          userName={user?.name ?? null}
          preview={preview}
          authAvailable={account?.authAvailable ?? false}
          signedIn={Boolean(user)}
          consent={claimConsent}
          busy={status === 'claiming' || status === 'loading'}
          onConsent={setClaimConsent}
          onClaim={() => preview ? void submitClaim(preview) : undefined}
        />
        <section className="account-panel account-panel--actions" aria-labelledby="session-title">
          <div className="account-panel-head">
            <span className="account-panel-icon"><Smartphone aria-hidden="true" size={20} /></span>
            <div>
              <h2 id="session-title">로그인한 기기</h2>
              <p>다른 기기에서 내 계정을 사용하지 못하도록 로그아웃할 수 있어요.</p>
            </div>
          </div>
          {user ? (
            <div className="account-action-row">
              <button type="button" className="account-secondary" onClick={() => void submitRevoke()} disabled={status === 'revoking' || status === 'loading'}>
                다른 기기에서 로그아웃
                <RefreshCw aria-hidden="true" size={17} />
              </button>
              <button type="button" className="account-danger" onClick={() => void submitLogout()} disabled={status === 'logging-out' || status === 'loading'}>
                로그아웃
                <LogOut aria-hidden="true" size={17} />
              </button>
            </div>
          ) : (
            <div className="account-empty">
              <p>현재는 로그인 없이 사용 중이에요. 로그인하면 다른 기기의 접속을 관리할 수 있어요.</p>
              <Link className="account-secondary" to="/login">로그인 화면으로 이동</Link>
            </div>
          )}
        </section>
      </section>
    </main>
  );
}

function AccountIdentityPanel(props: { account: AccountState | null; status: PageStatus; expiresAt: string | null; onRefresh: () => void }) {
  const user = props.account?.user ?? null;
  return (
    <section className="account-panel" aria-labelledby="identity-title">
      <div className="account-panel-head">
        <span className="account-panel-icon"><UserRound aria-hidden="true" size={20} /></span>
        <div>
          <h2 id="identity-title">현재 계정</h2>
          <p>{user ? '지금 로그인한 계정이에요.' : '지금은 로그인 없이 사용 중이에요.'}</p>
        </div>
      </div>
      {props.status === 'loading' ? <p className="account-muted" role="status">계정 정보를 불러오고 있어요.</p> : null}
      {user ? (
        <div className="account-profile">
          <span className="account-avatar" aria-hidden="true">{initialOf(user.name)}</span>
          <div>
            <strong>{user.name}</strong>
            <span>{user.email}</span>
            {props.expiresAt ? <small>다시 로그인할 날짜: {props.expiresAt}</small> : null}
          </div>
        </div>
      ) : (
        <div className="account-empty">
          <p>로그인하지 않아도 이 브라우저에서는 작업 공간을 계속 사용할 수 있어요.</p>
          <Link className="account-primary" to="/login">
            로그인 안내 보기
            <ArrowRight aria-hidden="true" size={18} />
          </Link>
        </div>
      )}
      <button type="button" className="account-secondary account-refresh" onClick={props.onRefresh} disabled={props.status === 'loading'}>
        새로고침
        <RefreshCw aria-hidden="true" size={17} />
      </button>
    </section>
  );
}

function AccountUsagePanel(props: { signedIn: boolean; usage: AccountUsage | null; status: UsageStatus; message: string | null; onRefresh: () => void }) {
  const usage = props.usage;
  const signedIn = props.signedIn;
  return (
    <section className="account-panel account-panel--usage" aria-labelledby="usage-title">
      <div className="account-panel-head">
        <span className="account-panel-icon"><ShieldCheck aria-hidden="true" size={20} /></span>
        <div>
          <h2 id="usage-title">사용량과 보관</h2>
          <p>{signedIn ? '저장한 작업과 오늘 AI를 사용할 수 있는 횟수예요.' : '로그인하면 내 계정의 사용량을 확인할 수 있어요.'}</p>
        </div>
      </div>

      {!signedIn ? (
        <div className="account-empty">
          <p>로그인 없이 만든 작업은 이 브라우저에서만 열 수 있어요. 7일 동안 열거나 수정하지 않으면 삭제될 수 있어요.</p>
          <Link className="account-secondary" to="/login">로그인 화면으로 이동</Link>
        </div>
      ) : null}

      {signedIn && props.status === 'loading' ? (
        <p className="account-muted" role="status">사용량을 불러오고 있어요.</p>
      ) : null}

      {signedIn && props.status === 'error' ? (
        <div className="account-empty">
          <p className="account-inline-error" role="alert">{props.message ?? '사용량을 불러오지 못했습니다.'}</p>
          <button type="button" className="account-secondary" onClick={props.onRefresh}>사용량 다시 불러오기</button>
        </div>
      ) : null}

      {signedIn && usage && props.status === 'ready' ? (
        <div className="account-usage">
          <div className="usage-metrics" aria-label="계정 사용량">
            <div>
              <span>작업 공간</span>
              <strong>{usage.activeWorkspaces.used} / {usage.activeWorkspaces.limit}</strong>
            </div>
            <div>
              <span>오늘 AI 실행</span>
              <strong>{usage.aiRunsToday.used} / {usage.aiRunsToday.limit}</strong>
            </div>
            <div>
              <span>AI 사용 횟수 초기화</span>
              <strong>{formatUtcDateTime(usage.aiRunsToday.resetAt)}</strong>
            </div>
          </div>
          <p className="account-muted">마지막 확인: {formatDateTime(usage.asOf)} · 보관 기준 {usage.retentionDays}일</p>
          <div className="usage-workspaces">
            <h3>작업별 보관 기한</h3>
            {usage.workspaces.length > 0 ? (
              <ul>
                {usage.workspaces.map((workspace) => (
                  <li key={workspace.id}>
                    <Link to={`/app/workspaces/${workspace.id}`}>
                      <strong>{workspace.title}</strong>
                      <span>계획 버전 {workspace.revision} · 원문 버전 {workspace.sourceRevision} · 만료 {formatDateTime(workspace.expiresAt)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="account-muted">이 계정에 저장된 작업 공간이 아직 없어요.</p>
            )}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function GuestClaimPanel(props: {
  userName: string | null;
  preview: GuestClaimPreview | null;
  authAvailable: boolean;
  signedIn: boolean;
  consent: boolean;
  busy: boolean;
  onConsent: (value: boolean) => void;
  onClaim: () => void;
}) {
  const canClaim = props.signedIn && props.preview && props.preview.workspaces.length > 0;
  return (
    <section className="account-panel account-panel--wide" aria-labelledby="claim-title">
      <div className="account-panel-head">
        <span className="account-panel-icon"><ShieldCheck aria-hidden="true" size={20} /></span>
        <div>
          <h2 id="claim-title">게스트 작업 공간 옮기기</h2>
          <p>로그인 전에 만든 작업을 지금 계정으로 옮길 수 있어요.</p>
        </div>
      </div>

      {!props.authAvailable ? (
        <div className="account-empty">
          <p>지금은 계정 연결을 사용할 수 없어요. 이 브라우저에서는 로그인 없이 계속 작업할 수 있어요.</p>
          <Link className="account-secondary" to="/app">게스트로 계속</Link>
        </div>
      ) : null}

      {props.authAvailable && !props.signedIn ? (
        <div className="account-empty">
          <p>내 계정으로 작업을 옮기려면 먼저 로그인해 주세요.</p>
          <Link className="account-primary" to="/login">Google 로그인으로 이동</Link>
        </div>
      ) : null}

      {canClaim && props.preview ? (
        <div className="claim-preview">
          <p className="account-muted">대상 계정: {props.userName}</p>
          <ul>
            {props.preview.workspaces.map((workspace) => (
              <li key={workspace.id}>
                <strong>{workspace.title}</strong>
                <span>계획 버전 {workspace.revision} · 원문 버전 {workspace.sourceRevision}</span>
              </li>
            ))}
          </ul>
          <label className="claim-consent">
            <input type="checkbox" checked={props.consent} onChange={(event) => props.onConsent(event.target.checked)} />
            위 작업 공간을 현재 로그인된 계정으로 옮기는 것을 확인했습니다.
          </label>
          <button type="button" className="account-primary" onClick={props.onClaim} disabled={!props.consent || props.busy}>
            위 작업 공간 옮기기
            <CheckCircle2 aria-hidden="true" size={18} />
          </button>
          <p className="account-muted">옮긴 뒤에도 {props.preview.retentionDays}일 동안 열거나 수정하지 않으면 삭제될 수 있어요.</p>
        </div>
      ) : null}

      {props.signedIn && props.authAvailable && (!props.preview || props.preview.workspaces.length === 0) ? (
        <div className="account-empty">
          <p>이 브라우저에는 계정으로 옮길 작업 공간이 없어요.</p>
          <Link className="account-secondary" to="/app">작업 공간으로 이동</Link>
        </div>
      ) : null}
    </section>
  );
}

function initialOf(name: string): string {
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 1) : '계';
}

function formatDateTime(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function formatUtcDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(date)} UTC`;
}
