import { Component, lazy, Suspense, useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { BrowserRouter, Link, Route, Routes, useLocation, useParams } from 'react-router-dom';
import ProductLanding from './landing/ProductLanding';

const WorkspaceApp = lazy(() => import('./workspace/WorkspaceApp'));
const AssistantLanding = lazy(() => import('./assistants/AssistantLanding'));
const LoginPage = lazy(() => import('./account/LoginPage'));
const AccountPage = lazy(() => import('./account/AccountPage'));
const LegalPage = lazy(() => import('./legal/LegalPage'));
const RecoveryPage = lazy(() => import('./recovery/RecoveryPage'));
const NoticeRecoverySetup = lazy(() => import('./recovery/NoticeRecoverySetup'));

function RecoveryRoute() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  return <RecoveryPage key={workspaceId ?? 'preview'} workspaceId={workspaceId} />;
}

function NoticeRecoveryRoute() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  return workspaceId ? <NoticeRecoverySetup key={workspaceId} workspaceId={workspaceId} /> : null;
}

class AppBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return (
        <main className="route-fallback" role="alert">
          <h1>화면을 불러오지 못했어요.</h1>
          <p>다시 불러오기를 눌러 주세요. 이미 저장한 작업은 그대로 남아 있어요.</p>
          <button type="button" onClick={() => window.location.reload()}>다시 불러오기</button>
        </main>
      );
    }
    return this.props.children;
  }
}

function RouteContent() {
  const { pathname } = useLocation();
  const previousPath = useRef(pathname);
  useEffect(() => {
    document.title = pathname === '/' ? '이어짐 — 일정이 바뀌면, 준비도 함께' : pathname === '/assistants' ? '업무 일정과 준비 · 이어짐' : pathname === '/login' ? '로그인 · 이어짐' : pathname === '/settings' ? '계정 설정 · 이어짐' : pathname === '/privacy' ? '개인정보 처리 안내 · 이어짐' : pathname === '/terms' ? '서비스 이용 조건 · 이어짐' : '내 작업 공간 · 이어짐';
    window.scrollTo({ top: 0, behavior: 'instant' });
    if (previousPath.current !== pathname) document.getElementById('main-content')?.focus({ preventScroll: true });
    previousPath.current = pathname;
  }, [pathname]);

  return (
    <>
      <a className="skip-link" href="#main-content">본문으로 이동</a>
      <div id="main-content" tabIndex={-1}>
        <Suspense fallback={<main className="route-fallback" role="status">화면을 불러오고 있어요.</main>}>
          <Routes>
            <Route path="/" element={<ProductLanding />} />
            <Route path="/assistants" element={<AssistantLanding />} />
            <Route path="/login" element={<LoginPage />} />
            <Route path="/privacy" element={<LegalPage kind="privacy" />} />
            <Route path="/terms" element={<LegalPage kind="terms" />} />
            <Route path="/settings" element={<AccountPage />} />
            <Route path="/recovery" element={<RecoveryRoute />} />
            <Route path="/recovery/:workspaceId" element={<RecoveryRoute />} />
            <Route path="/app" element={<WorkspaceApp />} />
            <Route path="/app/workspaces/:workspaceId/recovery/setup" element={<NoticeRecoveryRoute />} />
            <Route path="/app/workspaces/:workspaceId" element={<WorkspaceApp />} />
            <Route path="*" element={
              <main className="route-fallback">
                <h1>페이지를 찾을 수 없어요.</h1>
                <p>주소가 맞는지 확인하거나 내 작업 공간으로 이동해 주세요.</p>
                <Link to="/app">내 작업 공간으로 이동</Link>
              </main>
            } />
          </Routes>
        </Suspense>
      </div>
    </>
  );
}

export default function AppRouter() {
  return <AppBoundary><BrowserRouter><RouteContent /></BrowserRouter></AppBoundary>;
}
