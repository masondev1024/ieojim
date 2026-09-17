import { AlertTriangle, ArrowRight, RotateCcw } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CoordinationChoice, CoordinationDemoModel, CoordinationEvidence, CoordinationResultRow } from './coordination-demo-model';
import './coordination-demo.css';

type LoadState = 'idle' | 'loading' | 'ready' | 'error';

type CoordinationDemoProps = {
  onActiveChange?: (active: boolean) => void;
};

const choiceLabels: Record<CoordinationChoice, string> = {
  keep_user: '내 결정 유지',
  use_source: '새 안내 반영',
};

export default function CoordinationDemo({ onActiveChange }: CoordinationDemoProps) {
  const [loadState, setLoadState] = useState<LoadState>('idle');
  const [model, setModel] = useState<CoordinationDemoModel | null>(null);
  const [choices, setChoices] = useState<Record<string, CoordinationChoice>>({});
  const [resultRows, setResultRows] = useState<CoordinationResultRow[] | null>(null);
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

  useEffect(() => () => {
    onActiveChange?.(false);
  }, [onActiveChange]);

  const selectedCount = useMemo(() => model ? model.decisions.filter((decision) => choices[decision.id]).length : 0, [choices, model]);
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
      const { createCoordinationDemo } = await import('./coordination-demo-model');
      const nextModel = await createCoordinationDemo();
      if (!mountedRef.current || requestToken !== requestTokenRef.current) return;
      setModel(nextModel);
      setChoices({});
      setLoadState('ready');
    } catch {
      if (!mountedRef.current || requestToken !== requestTokenRef.current) return;
      setLoadState('error');
      setErrorMessage('미팅 체험 예시를 불러오지 못했습니다. 다시 시도해 주세요.');
    }
  }

  function selectChoice(decisionId: string, choice: CoordinationChoice) {
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
    if (!model || !allDecisionsSelected) return;
    try {
      setResolveError(null);
      setResultRows(model.resolve(choices));
    } catch {
      setResolveError('선택 결과를 계산하지 못했습니다. 확인이 필요한 두 변경을 다시 골라 주세요.');
      setResultRows(null);
    }
  }

  return (
    <section className="coordination-demo" aria-labelledby="coordination-demo-title">
      <div className="coordination-demo__steps" aria-label="미팅 체험 단계">
        <span data-active={activeStep === 'baseline'}>기준</span>
        <span data-active={activeStep === 'review'}>검토</span>
        <span data-active={activeStep === 'result'}>결과</span>
      </div>

      <div className="coordination-demo__intro">
        <div>
          <p className="coordination-demo__eyebrow">업무 체험 · AI 호출 없음</p>
          <h3 id="coordination-demo-title">준비된 미팅 안내에서 확인할 결정을 골라 보세요.</h3>
        </div>
        <button className="coordination-demo__load" type="button" onClick={loadDemo} disabled={loadState === 'loading'}>
          {loadState === 'loading' ? '체험 예시 불러오는 중' : model ? '다시 보기' : '미팅 변경 보기'}
        </button>
      </div>

      {!model ? (
        <div className="coordination-demo__baseline" aria-live="polite">
          <div>
            <span>기준 계획</span>
            <strong>미팅 14:00 · 사전 보고 13:00 고정 · 자료 마감 9/17 · 인쇄본 확인 완료</strong>
          </div>
          <ArrowRight aria-hidden="true" size={20} />
          <div>
            <span>새 안내</span>
            <strong>미팅 16:00 · 사전 보고 15:00 제안 · 자료 마감 9/16 · 인쇄본 삭제 요청</strong>
          </div>
        </div>
      ) : null}

      {loadState === 'error' ? (
        <div className="coordination-demo__error" role="alert">
          <AlertTriangle aria-hidden="true" size={18} />
          <div>
            <strong>미팅 체험 예시를 불러오지 못했습니다.</strong>
            {errorMessage ? <p>{errorMessage}</p> : null}
            <button type="button" onClick={loadDemo}>다시 시도</button>
          </div>
        </div>
      ) : null}

      {model ? (
        <div className="coordination-demo__review" aria-live="polite">
          <details className="coordination-demo__source">
            <summary>{model.source.title}</summary>
            <p>{model.source.text}</p>
          </details>

          <div className="coordination-demo__changes" aria-label="원문에서 찾은 미팅 변경">
            {model.changes.map((change) => (
              <article key={change.id}>
                <span>확인된 변경</span>
                <strong>{change.label}</strong>
                <p>{change.before} <ArrowRight aria-hidden="true" size={14} /> {change.after}</p>
                <EvidenceList evidence={change.evidence} />
              </article>
            ))}
          </div>

          <div className="coordination-demo__decisions" aria-label="사용자 선택이 필요한 미팅 변경">
            {model.decisions.map((decision) => (
              <article className="coordination-demo__decision" key={decision.id}>
                <div>
                  <span>{decision.kind === 'locked' ? '고정 일정 확인 필요' : '완료 항목 확인 필요'}</span>
                  <strong>{decision.label}</strong>
                  <p>{decision.before} <ArrowRight aria-hidden="true" size={14} /> {decision.after}</p>
                </div>
                <div className="coordination-demo__choice-group" role="group" aria-label={`${decision.label} 선택`}>
                  <button type="button" aria-pressed={choices[decision.id] === 'keep_user'} onClick={() => selectChoice(decision.id, 'keep_user')}>
                    {choiceLabels.keep_user}
                  </button>
                  <button type="button" aria-pressed={choices[decision.id] === 'use_source'} onClick={() => selectChoice(decision.id, 'use_source')}>
                    {choiceLabels.use_source}
                  </button>
                </div>
                <EvidenceList evidence={decision.evidence} />
              </article>
            ))}
          </div>

          <div className="coordination-demo__preserved" aria-label="보존된 준비 업무와 메모">
            {model.preservedPreparations.map((item) => (
              <article key={item.label} data-review={item.needsReview}>
                <span>{item.needsReview ? '보존됨 · 재검토 필요' : '보존됨'}</span>
                <strong>{item.label}</strong>
                <p>{item.dueDate ? `준비 마감 ${item.dueDate}` : '마감 없음'} · {item.durationMinutes ? `예상 ${item.durationMinutes}분` : '예상 시간 없음'}</p>
              </article>
            ))}
            <article data-review={model.preservedNote.needsReview}>
              <span>{model.preservedNote.needsReview ? '직접 쓴 안내 · 재검토 필요' : '직접 쓴 안내'}</span>
              <strong>{model.preservedNote.label}</strong>
              <p>{model.preservedNote.value}</p>
            </article>
          </div>

          <div className="coordination-demo__actions">
            <button className="coordination-demo__compare" type="button" onClick={resolveChoices} disabled={!allDecisionsSelected}>
              검증된 결과 보기
            </button>
            <button className="coordination-demo__reset" type="button" onClick={resetDemo}>
              <RotateCcw aria-hidden="true" size={16} />
              다시 선택
            </button>
            <span role="status">
              {allDecisionsSelected ? '선택을 바꾸면 결과를 다시 확인해야 해요.' : `확인할 변경 ${model.decisions.length}개 중 ${selectedCount}개 선택`}
            </span>
          </div>

          {resolveError ? (
            <div className="coordination-demo__error" role="alert">
              <AlertTriangle aria-hidden="true" size={18} />
              <div>
                <strong>선택 결과를 만들 수 없습니다.</strong>
                <p>{resolveError}</p>
              </div>
            </div>
          ) : null}

          {resultRows ? (
            <section className="coordination-demo__results" aria-labelledby="coordination-result-title">
              <div>
                <p className="coordination-demo__eyebrow">저장되지 않음</p>
                <h4 id="coordination-result-title">미팅 선택 결과</h4>
              </div>
              <div className="coordination-demo__result-list">
                {resultRows.map((row) => (
                  <article key={row.id}>
                    <strong>{row.label}</strong>
                    <p>{row.before === row.after ? row.after : <>{row.before} <ArrowRight aria-hidden="true" size={14} /> {row.after}</>}</p>
                    <div aria-label={`${row.label} 상태`}>
                      {(row.state.length > 0 ? row.state : [row.before === row.after ? '변경 없음' : '변경 반영']).map((state) => <span key={state}>{state}</span>)}
                    </div>
                  </article>
                ))}
              </div>
            </section>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function EvidenceList({ evidence }: { evidence: CoordinationEvidence[] }) {
  if (evidence.length === 0) return null;
  return (
    <details className="coordination-demo__evidence">
      <summary>원문 근거 보기</summary>
      <div>
        {evidence.map((entry) => (
          <blockquote key={`${entry.title}:${entry.quote}`}>
            <strong>{entry.title}</strong>
            <p>{entry.quote}</p>
          </blockquote>
        ))}
      </div>
    </details>
  );
}
