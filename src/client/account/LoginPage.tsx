import { ArrowRight, Home, LogIn, ShieldCheck } from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AccountState } from '../../core/account-contracts';
import { accountFailureMessage, isAccountFailure, readAccountState, readGenericOauthError, startLogin } from './account-api';
import './account.css';

type LoginStatus = 'loading' | 'ready' | 'submitting' | 'error';

export default function LoginPage() {
  const location = useLocation();
  const [account, setAccount] = useState<AccountState | null>(null);
  const [status, setStatus] = useState<LoginStatus>('loading');
  const [message, setMessage] = useState<string | null>(() => readGenericOauthError(location.search));
  const requestEpoch = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    const epoch = requestEpoch.current + 1;
    requestEpoch.current = epoch;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setStatus('loading');
    try {
      const next = await readAccountState(controller.signal);
      if (requestEpoch.current !== epoch || controller.signal.aborted) return;
      setAccount(next);
      setStatus('ready');
    } catch (error) {
      if (requestEpoch.current !== epoch || controller.signal.aborted) return;
      setAccount(null);
      setMessage(isAccountFailure(error) ? accountFailureMessage(error) : '계정 상태를 확인하지 못했습니다.');
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    void load();
    return () => controllerRef.current?.abort();
  }, [load]);

  async function submitLogin() {
    const epoch = requestEpoch.current + 1;
    requestEpoch.current = epoch;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setStatus('submitting');
    setMessage('Google 로그인 화면으로 이동해요. 아직 저장하지 않은 내용은 사라질 수 있어요.');
    try {
      const result = await startLogin(controller.signal);
      if (requestEpoch.current !== epoch || controller.signal.aborted) return;
      window.location.assign(result.url);
    } catch (error) {
      if (requestEpoch.current !== epoch || controller.signal.aborted) return;
      setMessage(isAccountFailure(error) ? accountFailureMessage(error) : '로그인을 시작하지 못했습니다.');
      setStatus('error');
    }
  }

  const authAvailable = account?.authAvailable ?? false;
  const alreadySignedIn = Boolean(account?.user);

  return (
    <main className="account-page account-page--login" aria-busy={status === 'loading' || status === 'submitting'}>
      <section className="account-hero" aria-labelledby="login-title">
        <Link className="account-brand" to="/">이어짐</Link>
        <p className="account-kicker">계정 연결</p>
        <h1 id="login-title">내 계획, 다른 기기에서도 이어서.</h1>
        <p className="account-lede">
          Google로 로그인하면 계정에 연결한 작업 공간을 다른 기기에서도 열 수 있어요.
          입력 중인 내용이 있다면 먼저 저장해 주세요.
        </p>
        <nav className="account-legal-links" aria-label="로그인 관련 안내">
          <Link to="/privacy">개인정보 처리 안내</Link>
          <Link to="/terms">서비스 이용 조건</Link>
        </nav>
        {message ? <p className="account-alert" role="alert">{message}</p> : null}
      </section>

      <section className="account-panel" aria-label="로그인 상태">
        {status === 'loading' ? (
          <p className="account-muted" role="status">로그인할 수 있는지 확인하고 있어요.</p>
        ) : null}

        {alreadySignedIn && account?.user ? (
          <div className="account-stack">
            <span className="account-state-badge">
              <ShieldCheck aria-hidden="true" size={18} />
              로그인됨
            </span>
            <h2>{account.user.name}</h2>
            <p>{account.user.email}</p>
            <Link className="account-primary" to="/settings">
              계정 설정 열기
              <ArrowRight aria-hidden="true" size={18} />
            </Link>
          </div>
        ) : null}

        {!alreadySignedIn && authAvailable ? (
          <div className="account-stack">
            <span className="account-state-badge">
              <LogIn aria-hidden="true" size={18} />
              Google
            </span>
            <h2>Google 계정으로 계속</h2>
            <p>로그인 전에 만든 작업은 설정에서 목록을 확인한 뒤 내 계정으로 옮길 수 있어요.</p>
            <button type="button" className="account-primary" onClick={() => void submitLogin()} disabled={status === 'submitting'}>
              Google 로그인으로 이동
              <ArrowRight aria-hidden="true" size={18} />
            </button>
            <Link className="account-secondary" to="/app">
              게스트 작업 공간으로 이동
              <Home aria-hidden="true" size={18} />
            </Link>
          </div>
        ) : null}

        {!alreadySignedIn && !authAvailable ? (
          <div className="account-stack">
            <span className="account-state-badge account-state-badge--muted">게스트</span>
            <h2>지금은 Google 로그인을 사용할 수 없어요.</h2>
            <p>로그인 없이도 이 브라우저에서 작업할 수 있어요. 작업 공간을 7일 동안 열거나 수정하지 않으면 삭제될 수 있어요.</p>
            <Link className="account-primary" to="/app">
              게스트 작업 공간으로 이동
              <Home aria-hidden="true" size={18} />
            </Link>
          </div>
        ) : null}
      </section>
    </main>
  );
}
