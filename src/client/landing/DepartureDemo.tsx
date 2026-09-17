import { AlertTriangle, ArrowRight, CheckCircle2, RotateCcw } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { DepartureChoice, DepartureDemoModel, DepartureResultRow } from './departure-demo-types';
import './departure-demo.css';

type LoadState = 'idle' | 'loading' | 'ready' | 'error';

type DepartureDemoProps = {
  onActiveChange?: (active: boolean) => void;
};

const choiceLabels: Record<DepartureChoice, string> = {
  keep_user: '내 결정 유지',
  use_source: '새 안내 반영',
};

export function DepartureDemo({ onActiveChange }: DepartureDemoProps) {
  const [loadState, setLoadState] = useState<LoadState>('idle');
  const [model, setModel] = useState<DepartureDemoModel | null>(null);
  const [choices, setChoices] = useState<Record<string, DepartureChoice>>({});
  const [resultRows, setResultRows] = useState<DepartureResultRow[] | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const requestTokenRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
      requestTokenRef.current += 1;
    };
  }, []);

  useEffect(() => {
    onActiveChange?.(Boolean(model));
  }, [model, onActiveChange]);

  useEffect(() => {
    return () => {
      onActiveChange?.(false);
    };
  }, [onActiveChange]);

  const selectedCount = useMemo(() => {
    if (!model) {
      return 0;
    }
    return model.decisions.filter((decision) => choices[decision.id]).length;
  }, [choices, model]);

  const allDecisionsSelected = Boolean(model && selectedCount === model.decisions.length);
  const activeStep = resultRows ? 'result' : model ? 'review' : 'baseline';

  async function loadDemo() {
    const requestToken = requestTokenRef.current + 1;
    requestTokenRef.current = requestToken;
    setLoadState('loading');
    setErrorMessage(null);
    setResolveError(null);
    setResultRows(null);

    try {
      const { createDepartureDemo } = await import('./departure-demo-model');
      const nextModel = await createDepartureDemo();

      if (!mountedRef.current || requestToken !== requestTokenRef.current) {
        return;
      }

      setModel(nextModel);
      setChoices({});
      setLoadState('ready');
    } catch {
      if (!mountedRef.current || requestToken !== requestTokenRef.current) {
        return;
      }

      setLoadState('error');
      setErrorMessage('체험 예시를 불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요.');
    }
  }

  function selectChoice(decisionId: string, choice: DepartureChoice) {
    setChoices((currentChoices) => ({ ...currentChoices, [decisionId]: choice }));
    setResolveError(null);
    setResultRows(null);
  }

  function resetDemo() {
    setChoices({});
    setResolveError(null);
    setResultRows(null);
  }

  function resolveChoices() {
    if (!model || !allDecisionsSelected) {
      return;
    }

    try {
      setResolveError(null);
      setResultRows(model.resolve(choices));
    } catch {
      setResolveError('선택 결과를 계산하지 못했습니다. 확인이 필요한 변경을 다시 골라 주세요.');
      setResultRows(null);
    }
  }

  return (
    <section className="departure-demo" aria-labelledby="departure-demo-title">
      <div className="departure-demo__steps" aria-label="체험 단계">
        <span data-active={activeStep === 'baseline'}>기준</span>
        <span data-active={activeStep === 'review'}>검토</span>
        <span data-active={activeStep === 'result'}>결과</span>
      </div>

      <div className="departure-demo__intro">
        <div>
          <p className="departure-demo__eyebrow">생활 체험 · AI 호출 없음</p>
          <h3 id="departure-demo-title">준비된 출발 전 안내에서 두 변경을 직접 골라 보세요.</h3>
        </div>
        <button className="departure-demo__load" type="button" onClick={loadDemo} disabled={loadState === 'loading'}>
          {loadState === 'loading' ? '체험 예시 불러오는 중' : model ? '출발 전 변경 다시 보기' : '출발 전 변경 확인하기'}
        </button>
      </div>

      {!model ? (
        <div className="departure-demo__baseline" aria-live="polite">
          <div>
            <span>기준 계획</span>
            <strong>도착 10:00 · 4명 · 19:00 저녁 · 종이 확인서 출력 완료</strong>
          </div>
          <ArrowRight aria-hidden="true" size={20} />
          <div>
            <span>새 안내</span>
            <strong>도착 16:00 · 3명 · 저녁 20:00 제안 · 종이 확인서 출력 삭제 요청</strong>
          </div>
        </div>
      ) : null}

      {loadState === 'error' ? (
        <div className="departure-demo__error" role="alert">
          <AlertTriangle aria-hidden="true" size={18} />
          <div>
            <strong>체험 예시를 불러오지 못했습니다.</strong>
            {errorMessage ? <p>{errorMessage}</p> : null}
            <button type="button" onClick={loadDemo}>
              다시 시도
            </button>
          </div>
        </div>
      ) : null}

      {model ? (
        <div className="departure-demo__review" aria-live="polite">
          <details className="departure-demo__source">
            <summary>{model.source.title}</summary>
            <p>{model.source.text}</p>
          </details>

          <div className="departure-demo__changes" aria-label="원문에서 찾은 변경">
            {model.changes.map((change) => (
              <article key={change.id}>
                <span>확인된 변경</span>
                <strong>{change.label}</strong>
                <p>
                  {change.before} <ArrowRight aria-hidden="true" size={14} /> {change.after}
                </p>
                <EvidenceList evidence={change.evidence} />
              </article>
            ))}
          </div>

          <div className="departure-demo__decisions" aria-label="사용자 선택이 필요한 변경">
            {model.decisions.map((decision) => (
              <article className="departure-demo__decision" key={decision.id}>
                <div>
                  <span>{decision.kind === 'locked' ? '고정한 결정 확인 필요' : '완료 항목 확인 필요'}</span>
                  <strong>{decision.label}</strong>
                  <p>
                    {decision.before} <ArrowRight aria-hidden="true" size={14} /> {decision.after}
                  </p>
                </div>
                <div className="departure-demo__choice-group" role="group" aria-label={`${decision.label} 선택`}>
                  <button
                    type="button"
                    aria-pressed={choices[decision.id] === 'keep_user'}
                    onClick={() => selectChoice(decision.id, 'keep_user')}
                  >
                    {decision.keepLabel || choiceLabels.keep_user}
                  </button>
                  <button
                    type="button"
                    aria-pressed={choices[decision.id] === 'use_source'}
                    onClick={() => selectChoice(decision.id, 'use_source')}
                  >
                    {decision.sourceLabel || choiceLabels.use_source}
                  </button>
                </div>
                <EvidenceList evidence={decision.evidence} />
              </article>
            ))}
          </div>

          <article className="departure-demo__note" data-review={model.preservedNote.needsReview}>
            <span>{model.preservedNote.needsReview ? '보존됨 · 재검토 필요' : '보존됨'}</span>
            <strong>{model.preservedNote.label}</strong>
            <p>{model.preservedNote.value}</p>
          </article>

          <div className="departure-demo__actions">
            <button
              className="departure-demo__compare"
              type="button"
              onClick={resolveChoices}
              disabled={!allDecisionsSelected}
            >
              선택한 결과 비교
            </button>
            <button className="departure-demo__reset" type="button" onClick={resetDemo}>
              <RotateCcw aria-hidden="true" size={16} />
              다시 선택
            </button>
            <span role="status">
              {allDecisionsSelected
                ? '선택을 바꾸면 결과를 다시 확인해야 해요.'
                : `확인할 변경 ${model.decisions.length}개 중 ${selectedCount}개 선택`}
            </span>
          </div>

          {resolveError ? (
            <div className="departure-demo__error" role="alert">
              <AlertTriangle aria-hidden="true" size={18} />
              <div>
                <strong>결과 미리보기를 만들 수 없습니다.</strong>
                <p>{resolveError}</p>
              </div>
            </div>
          ) : null}

          {resultRows ? (
            <section className="departure-demo__results" aria-labelledby="departure-result-title">
              <div>
                <p className="departure-demo__eyebrow">저장되지 않음</p>
                <h4 id="departure-result-title">선택 결과 미리보기</h4>
              </div>
              <div className="departure-demo__result-list">
                {resultRows.map((row) => (
                  <article key={row.id}>
                    <strong>{row.label}</strong>
                    <p>
                      {row.before === row.after ? row.after : <>{row.before} <ArrowRight aria-hidden="true" size={14} /> {row.after}</>}
                    </p>
                    <div aria-label={`${row.label} 상태`}>
                      {(row.state.length > 0 ? row.state : [row.before === row.after ? '변경 없음' : '변경 반영']).map((state) => (
                        <span key={state}>{state}</span>
                      ))}
                    </div>
                  </article>
                ))}
              </div>
              <a className="departure-demo__workspace-link" href="/app?example=departure">
                같은 체험 예시를 작업 공간에서 열기
                <CheckCircle2 aria-hidden="true" size={16} />
              </a>
            </section>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function EvidenceList({ evidence }: { evidence: { title: string; quote: string }[] }) {
  return (
    <details className="departure-demo__evidence">
      <summary>원문 근거 보기</summary>
      <div>
        {evidence.map((item) => (
          <blockquote key={`${item.title}:${item.quote}`}>
            <strong>{item.title}</strong>
            <p>{item.quote}</p>
          </blockquote>
        ))}
      </div>
    </details>
  );
}

export default DepartureDemo;
