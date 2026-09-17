import { LogIn, Settings, UserRound } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AccountState } from '../../core/account-contracts';
import { accountFailureMessage, accountIdentityKey, isAccountFailure, isExternalIdentityMessage, readAccountState } from './account-api';
import './account.css';

type AccountLinkStatus = 'idle' | 'loading' | 'ready' | 'error';

export default function AccountLink() {
  const [state, setState] = useState<AccountState | null>(null);
  const [status, setStatus] = useState<AccountLinkStatus>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const requestEpoch = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const currentIdentity = useRef<string | null>(null);
  const initialized = useRef(false);

  const refresh = useCallback(async () => {
    const epoch = requestEpoch.current + 1;
    requestEpoch.current = epoch;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setStatus((current) => current === 'ready' ? current : 'loading');
    setMessage(null);
    try {
      const next = await readAccountState(controller.signal);
      if (requestEpoch.current !== epoch || controller.signal.aborted) return;
      const nextIdentity = accountIdentityKey(next);
      if (initialized.current && currentIdentity.current !== nextIdentity) {
        setState(null);
        window.location.replace('/app');
        return;
      }
      initialized.current = true;
      currentIdentity.current = nextIdentity;
      setState(next);
      setStatus('ready');
    } catch (error) {
      if (requestEpoch.current !== epoch || controller.signal.aborted) return;
      if (isAccountFailure(error) && error.status === 401) {
        setState(null);
        if (initialized.current && currentIdentity.current !== 'guest') {
          currentIdentity.current = 'guest';
          window.location.replace('/app');
          return;
        }
        initialized.current = true;
        currentIdentity.current = 'guest';
      }
      setMessage(isAccountFailure(error) ? accountFailureMessage(error) : '계정 상태를 확인하지 못했습니다.');
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onFocus = () => void refresh();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    const onLocalIdentityChange = (event: Event) => {
      if (event instanceof CustomEvent && !isExternalIdentityMessage(event.detail)) return;
      setState(null);
      window.location.replace('/app');
    };
    window.addEventListener('ieojim-identity-change', onLocalIdentityChange);
    const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('ieojim-identity') : null;
    const onBroadcastIdentityChange = (event: MessageEvent<unknown>) => {
      if (!isExternalIdentityMessage(event.data)) return;
      setState(null);
      window.location.replace('/app');
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
  }, [refresh]);

  if (status === 'loading' && !state) {
    return (
      <span className="account-link account-link--muted" aria-live="polite">
        <UserRound aria-hidden="true" size={16} />
        계정 확인 중
      </span>
    );
  }

  if (state?.user) {
    return (
      <Link className="account-link account-link--profile" to="/settings" aria-label={`${state.user.name} 계정 설정`}>
        <span className="account-link__avatar" aria-hidden="true">{initialOf(state.user.name)}</span>
        <span>
          <strong>{state.user.name}</strong>
          <small>{state.user.email}</small>
        </span>
        <Settings aria-hidden="true" size={16} />
      </Link>
    );
  }

  if (state?.authAvailable) {
    return (
      <Link className="account-link" to="/login">
        <LogIn aria-hidden="true" size={16} />
        로그인
      </Link>
    );
  }

  return (
    <Link className="account-link account-link--muted" to="/settings" title={message ?? '로그인 없이 이 브라우저에서 사용 중이에요.'}>
      <UserRound aria-hidden="true" size={16} />
      게스트
    </Link>
  );
}

function initialOf(name: string): string {
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 1) : '계';
}
