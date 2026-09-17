import { Component, lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import './scene.css';

type SceneState = 'idle' | 'playing' | 'paused' | 'finished';

const totalCost = 900_000;
const beforePeople = 4;
const afterPeople = 3;
const dinnerTime = 'DAY 02 · 19:00';
const animationDurationMs = 1_600;

function formatKRW(value: number): string {
  return `${new Intl.NumberFormat('ko-KR').format(value)}원`;
}

function useReducedMotion(): boolean {
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReducedMotion(media.matches);
    const listener = () => setReducedMotion(media.matches);
    media.addEventListener('change', listener);
    return () => media.removeEventListener('change', listener);
  }, []);

  return reducedMotion;
}

function useVisible(): { ref: RefObject<HTMLDivElement | null>; visible: boolean } {
  const [visible, setVisible] = useState(true);
  const ref = useRef<HTMLDivElement | null>(null);
  const intersecting = useRef(true);

  useEffect(() => {
    const target = ref.current;
    if (!target) return undefined;

    const updateDocumentVisibility = () => {
      setVisible(document.visibilityState !== 'hidden' && intersecting.current);
    };
    const observer = new IntersectionObserver(([entry]) => {
      intersecting.current = entry.isIntersecting;
      updateDocumentVisibility();
    }, { threshold: 0.1 });
    observer.observe(target);
    document.addEventListener('visibilitychange', updateDocumentVisibility);
    return () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', updateDocumentVisibility);
    };
  }, []);

  return { ref, visible };
}

function supportsWebGL(): boolean {
  try {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('webgl2');
    context?.getExtension('WEBGL_lose_context')?.loseContext();
    return Boolean(context);
  } catch {
    return false;
  }
}

const LazyContinuityCanvas = lazy(() => import('./ContinuityCanvas'));

class SceneBoundary extends Component<{ children: ReactNode; onError: () => void }, { hasError: boolean }> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch() {
    this.props.onError();
  }

  render() {
    if (this.state.hasError) return null;
    return this.props.children;
  }
}

export default function ContinuityScene() {
  const reducedMotion = useReducedMotion();
  const { ref: containerRef, visible: isVisible } = useVisible();
  const [state, setState] = useState<SceneState>('idle');
  const [progress, setProgress] = useState(0);
  const [webglAvailable, setWebglAvailable] = useState(false);
  const [webglFailed, setWebglFailed] = useState(false);
  const [hasActivated, setHasActivated] = useState(false);
  const animationStartedAt = useRef<number | null>(null);
  const progressRef = useRef(0);

  useEffect(() => {
    if (!hasActivated || reducedMotion || webglFailed) {
      setWebglAvailable(false);
      return;
    }
    setWebglAvailable(supportsWebGL());
  }, [hasActivated, reducedMotion, webglFailed]);

  useEffect(() => {
    progressRef.current = progress;
  }, [progress]);

  useEffect(() => {
    if (state !== 'playing' || !isVisible) return undefined;
    if (reducedMotion) {
      setProgress(1);
      setState('finished');
      return undefined;
    }
    const remainingMs = Math.max(0, animationDurationMs * (1 - progressRef.current));
    const finishTimer = window.setTimeout(() => {
      setProgress(1);
      progressRef.current = 1;
      animationStartedAt.current = null;
      setState('finished');
    }, remainingMs);
    let frame = 0;
    const tick = (now: number) => {
      if (animationStartedAt.current === null) animationStartedAt.current = now - progressRef.current * animationDurationMs;
      const nextProgress = Math.min((now - animationStartedAt.current) / animationDurationMs, 1);
      setProgress(nextProgress);
      if (nextProgress >= 1) {
        window.clearTimeout(finishTimer);
        setState('finished');
        animationStartedAt.current = null;
        return;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(finishTimer);
      animationStartedAt.current = null;
    };
  }, [isVisible, reducedMotion, state]);

  const play = useCallback(() => {
    setHasActivated(true);
    if (state === 'finished' || state === 'idle') {
      setProgress(0);
      progressRef.current = 0;
    }
    animationStartedAt.current = null;
    setState('playing');
  }, [state]);

  const pause = useCallback(() => {
    if (state !== 'playing') return;
    animationStartedAt.current = null;
    setState('paused');
  }, [state]);

  const reset = useCallback(() => {
    animationStartedAt.current = null;
    setProgress(0);
    progressRef.current = 0;
    setState('idle');
  }, []);

  const mode = reducedMotion ? 'reduced-motion' : hasActivated && webglAvailable && !webglFailed ? 'webgl' : 'static';
  const activeCanvas = mode === 'webgl' && isVisible;

  return (
    <section
      ref={containerRef}
      className="continuity-scene"
      data-testid="continuity-scene"
      data-scene-mode={mode}
      data-scene-state={state}
      aria-labelledby="continuity-scene-title"
    >
      <div className="continuity-scene__visual" aria-hidden="true">
        {mode === 'webgl' && activeCanvas ? (
          <SceneBoundary onError={() => setWebglFailed(true)}>
            <Suspense fallback={null}>
              <LazyContinuityCanvas progress={progress} active={state === 'playing' && activeCanvas} onError={() => setWebglFailed(true)} />
            </Suspense>
          </SceneBoundary>
        ) : null}
        <div className="continuity-scene__static" data-active={mode !== 'webgl' || !activeCanvas}>
          <span />
          <span />
          <span />
        </div>
      </div>

      <div className="continuity-scene__content">
        <header className="continuity-scene__header">
          <p className="continuity-scene__eyebrow">체험용 흐름</p>
          <h2 id="continuity-scene-title">인원 변경은 비용 계산에 반영되고, 고정한 약속은 그대로 둡니다.</h2>
          <p className="continuity-scene__copy">
            AI가 원문에서 인원 변경을 찾으면, 코드는 비용만 다시 계산해요. 저녁 약속은 사용자가 고정한 19:00 그대로예요.
          </p>
        </header>

        <div className="continuity-scene__board" aria-label="변경 흐름 값">
          <article className="continuity-card continuity-card--source">
            <span className="continuity-card__label">변경 원문</span>
            <strong>참여 인원</strong>
            <p>{beforePeople}명에서 {afterPeople}명으로 변경</p>
            <small>원문 근거와 계산 기준을 따로 확인합니다.</small>
          </article>

          <div className="continuity-flow" aria-hidden="true" data-active={progress > 0.08}>
            <span />
          </div>

          <article className="continuity-card continuity-card--cost" data-state={progress >= 1 ? 'changed' : 'idle'}>
            <span className="continuity-card__label">자동 계산</span>
            <strong>1인 비용</strong>
            <div className="continuity-cost">
              <span data-muted={progress >= 1}>{formatKRW(totalCost / beforePeople)}</span>
              <b aria-hidden="true">→</b>
              <span data-active={progress >= 1}>{formatKRW(totalCost / afterPeople)}</span>
            </div>
            <small>{formatKRW(totalCost)} 총액 유지</small>
          </article>

          <article className="continuity-card continuity-card--protected" data-state="preserved">
            <span className="continuity-card__label">약속 유지</span>
            <strong>{dinnerTime}</strong>
            <small>저녁 예약 유지</small>
          </article>
        </div>

        <div className="continuity-scene__controls">
          <button type="button" onClick={play} disabled={state === 'playing'} aria-label="변경 흐름 재생">
            변경 흐름 재생
          </button>
          <button type="button" onClick={pause} disabled={state !== 'playing'} aria-label="변경 흐름 일시정지">
            일시정지
          </button>
          <button type="button" onClick={reset} disabled={state === 'idle'} aria-label="변경 흐름 초기화">
            초기화
          </button>
        </div>
      </div>
    </section>
  );
}
