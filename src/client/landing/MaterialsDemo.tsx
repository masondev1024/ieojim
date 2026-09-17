import { useState } from 'react';
import { ArrowRight, RotateCcw } from 'lucide-react';
import type { MaterialsChoice, MaterialsDemo as DemoModel } from './materials-demo-model';
import './materials-demo.css';

export default function MaterialsDemo() {
  const [model, setModel] = useState<DemoModel | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [choice, setChoice] = useState<MaterialsChoice | null>(null);
  async function open() {
    setLoading(true); setError(false);
    try { setModel(await (await import('./materials-demo-model')).createMaterialsDemo()); }
    catch { setError(true); }
    finally { setLoading(false); }
  }
  const result = model && choice ? model.review(choice) : null;
  return <div className="materials-demo">
    {!model ? <button type="button" className="materials-demo__start" disabled={loading} onClick={() => void open()}>
      {loading ? '예시 여는 중' : '바뀐 준비 확인하기'} <ArrowRight size={17} aria-hidden="true" />
    </button> : <>
      <div className="materials-demo__changes" role="region" aria-label="자료 변경 영향">
        <article><span>발표 시간</span><p><s>{model.meeting.before}</s><strong>{model.meeting.after}</strong></p></article>
        <article><span>끝냈던 준비</span><p><s>{model.before.value}</s><strong>{model.after.value}</strong><em>{model.after.completed && model.after.stale ? '이전 완료 · 다시 확인 필요' : '확인 필요'}</em></p></article>
        <article><span>그대로 유지</span><p><strong>{model.protectedAppointment.label} · {model.protectedAppointment.value}</strong><small>{model.note.value}</small></p></article>
      </div>
      <p className="materials-demo__explanation">초안 검토를 끝냈어도 수정본까지 확인한 건 아니니까요. 기존 완료 기록과 준비 시간 {model.after.preparation?.durationMinutes}분은 남기고, 바뀐 자료를 다시 확인할지 골라요.</p>
      <details><summary>변경 근거와 내 설정 보기</summary><blockquote>{model.source}</blockquote><p>내가 정한 준비 마감 {model.after.preparation?.dueDate}은 유지돼요. 앞당겨진 원문 마감과 맞는지 확인해야 해요. 직접 쓴 메모도 남고 확인 필요로 표시돼요.</p></details>
      <div className="materials-demo__choices" role="group" aria-label="바뀐 준비 처리">
        <button type="button" aria-pressed={choice === 'reopen'} onClick={() => setChoice('reopen')}>다시 할 일로 표시</button>
        <button type="button" aria-pressed={choice === 'keep_completed'} onClick={() => setChoice('keep_completed')}>수정본도 확인했어요</button>
      </div>
      {result ? <div className="materials-demo__result" role="status"><strong>{result.completed ? '확인 후 완료 유지' : '수정본 검토가 다시 할 일로 바뀌었어요'}</strong><p>이 화면의 미리보기예요. 실제 작업 공간에서는 승인한 변경과 확인 기록이 저장돼요.</p><button type="button" onClick={() => setChoice(null)}><RotateCcw size={14} aria-hidden="true" /> 선택 다시 하기</button></div> : null}
    </>}
    {error ? <p role="alert">예시를 열지 못했어요. 다시 시도하거나 ‘내 안내로 시작하기’를 이용해 주세요.</p> : null}
  </div>;
}
