import { ArrowRight, BriefcaseBusiness, Check, FileText, Lock, Sparkles } from 'lucide-react';
import type { WorkspaceView } from '../../core/contracts';
import type { StartTemplate } from './workspace-start-context';
import './workspace-start.css';

type WorkspaceStartProps = {
  template: StartTemplate;
  title: string;
  purpose: string;
  busy: boolean;
  exampleFirst: boolean;
  departureFirst: boolean;
  coordinationFirst: boolean;
  syllabusFirst: boolean;
  travelFirst: boolean;
  onTemplate: (template: StartTemplate) => void;
  onTitle: (value: string) => void;
  onPurpose: (value: string) => void;
  onCreate: () => void;
  onSample: (scenario: NonNullable<WorkspaceView['sampleScenario']>) => void;
};

const introductions = {
  custom: { title: '내 계획', kicker: '업무·학업·생활, 바뀌는 안내를 한곳에', description: '안내문에서 일정과 준비할 일을 정리해요. 나중에 안내가 바뀌어도 직접 고친 메모와 확정한 결정을 남겨 둘 수 있어요.', help: '용도에 맞게 이름과 정리 기준을 적어 주세요.' },
  travel: { title: '여행 준비', kicker: '다시 정리하는 수고를 덜어주는 여행 준비', description: '단톡방의 안내부터 예약 메모까지. 한곳에 정리하고, 바뀐 내용만 검토하세요.', help: '여행에 맞는 정리 기준을 준비했어요.' },
  coordination: { title: '미팅 준비', kicker: '발표와 미팅, 변경된 안내부터 준비할 일까지', description: '자료 마감과 장소가 함께 바뀌어도 고정한 약속과 완료한 준비를 지키며 검토하세요.', help: '미팅 준비에 맞는 정리 기준을 준비했어요.' },
  syllabus: { title: '과제 준비', kicker: '강의 공지와 과제 안내를 준비 목록으로', description: '마감일과 제출 안내가 달라지면 영향받는 일정과 준비할 일을 확인하고 이어가세요.', help: '직접 작성할 때는 과제 이름과 정리 기준을 적어 주세요.' },
} as const;

export default function WorkspaceStart(props: WorkspaceStartProps) {
  const context = props.coordinationFirst ? 'coordination' : props.syllabusFirst ? 'syllabus' : props.departureFirst || props.travelFirst ? 'travel' : props.template;
  const intro = introductions[context];
  const form = (
    <form className="start-form" aria-label="새 작업 만들기" onSubmit={(event) => { event.preventDefault(); if (!props.busy) props.onCreate(); }}>
      <div className="start-card-heading"><span className="eyebrow">내 자료로 시작</span><h2>어떤 계획을 정리할까요?</h2></div>
      <div className="start-template-picker" role="group" aria-label="정리 기준 선택">
        <button type="button" aria-pressed={props.template === 'custom'} disabled={props.busy} onClick={() => props.onTemplate('custom')}>직접 설정</button>
        <button type="button" aria-pressed={props.template === 'travel'} disabled={props.busy} onClick={() => props.onTemplate('travel')}>여행 계획</button>
        <button type="button" aria-pressed={props.template === 'coordination'} disabled={props.busy} onClick={() => props.onTemplate('coordination')}>미팅 준비</button>
      </div>
      <label>작업 이름<input data-create-title value={props.title} onChange={(event) => props.onTitle(event.target.value)} maxLength={100} required /></label>
      <label>목적<textarea value={props.purpose} onChange={(event) => props.onPurpose(event.target.value)} rows={3} maxLength={300} required aria-describedby="start-purpose-help" /></label>
      <p id="start-purpose-help" className="start-field-help">원하는 정리 기준으로 수정할 수 있어요. 원문은 다음 단계에서 입력합니다.</p>
      <button type="submit" className="primary-action" disabled={props.busy || !props.title.trim() || !props.purpose.trim()}>만들기 <ArrowRight size={17} aria-hidden="true" /></button>
    </form>
  );
  const departureExample = (
    <section className="start-example" aria-labelledby="start-departure-title">
      <div className="start-example-heading"><span className="eyebrow">출발 전날 · 체험용 복합 예시</span><h2 id="start-departure-title">새 공지가 이미 정한 약속까지 바꾸라고 한다면?</h2></div>
      <p className="start-incoming">도착 시간·인원이 바뀌고, 잠근 저녁 약속 변경과 이미 끝낸 준비 항목 삭제까지 요청됐어요.</p>
      <div className="start-example-outcome"><span><Lock size={14} aria-hidden="true" /> 고정한 약속 변경은 직접 선택</span><span><Check size={15} aria-hidden="true" /> 완료 기록 삭제도 직접 선택</span></div>
      <button type="button" className="start-sample-button" onClick={() => props.onSample('departure')} disabled={props.busy}><Sparkles size={16} aria-hidden="true" /> 출발 전날 복합 체험 시작 <ArrowRight size={16} aria-hidden="true" /></button>
      <p className="start-field-help">고정·완료·직접 수정한 상태가 들어 있는 준비된 예시입니다. 정정 안내를 불러온 뒤 원문 근거 확인, 선택, 저장과 이력 복원을 체험하세요. 실제 AI 호출은 하지 않습니다.</p>
      <button type="button" className="start-secondary-example" onClick={() => props.onSample('travel')} disabled={props.busy}><FileText size={14} aria-hidden="true" /> 체험용 여행 예시 시작</button>
    </section>
  );
  const basicExample = (
    <section className="start-example" aria-labelledby="start-example-title">
      <div className="start-example-heading"><span className="eyebrow">자료 없이 먼저 둘러보기 · 체험용 예시</span><h2 id="start-example-title">제주 여행에 새 안내가 왔어요</h2></div>
      <p className="start-incoming">“이번 여행은 3명이에요. 첫날 도착은 16시로 바뀌었어요.”</p>
      <div className="start-example-outcome"><span><Check size={15} aria-hidden="true" /> 1인 비용 다시 계산</span><span><Lock size={14} aria-hidden="true" /> 둘째 날 19시 약속 유지</span></div>
      <button type="button" className="start-sample-button" onClick={() => props.onSample('travel')} disabled={props.busy}><Sparkles size={16} aria-hidden="true" /> 체험용 여행 예시 시작 <ArrowRight size={16} aria-hidden="true" /></button>
      <p className="start-field-help">준비된 예시로 검토 과정을 체험합니다. 실제 AI 호출 결과와 구분됩니다.</p>
      <button type="button" className="start-secondary-example" onClick={() => props.onSample('syllabus')} disabled={props.busy}><FileText size={14} aria-hidden="true" /> 과제 예시 열기</button>
      <button type="button" className="start-secondary-example" onClick={() => props.onSample('departure')} disabled={props.busy}><Lock size={14} aria-hidden="true" /> 출발 전날 복합 체험 시작</button>
    </section>
  );
  const coordinationExample = (
    <section className="start-example" aria-labelledby="start-coordination-title">
      <div className="start-example-heading"><span className="eyebrow">기업 미팅 · 체험용 예시</span><h2 id="start-coordination-title">미팅 시간만 바뀐 줄 알았는데, 자료 마감도 바뀌었어요.</h2></div>
      <p className="start-incoming">“미팅은 16시로 변경, 자료 마감은 하루 앞당기고, 장소는 별관 2층입니다. 인쇄본 확인은 삭제해 주세요.”</p>
      <div className="start-example-outcome"><span><BriefcaseBusiness size={15} aria-hidden="true" /> 일정·장소·자료 마감 정리</span><span><Lock size={14} aria-hidden="true" /> 고정 보고와 완료 항목은 직접 선택</span></div>
      <button type="button" className="start-sample-button" onClick={() => props.onSample('coordination')} disabled={props.busy}><Sparkles size={16} aria-hidden="true" /> 고객 미팅 변경 체험 시작 <ArrowRight size={16} aria-hidden="true" /></button>
      <p className="start-field-help">준비 항목의 마감일·예상 시간을 담당자가 저장한 상태에서 시작합니다. 실제 캘린더 적용이나 외부 알림은 수행하지 않습니다.</p>
      <button type="button" className="start-secondary-example" onClick={() => props.onSample('departure')} disabled={props.busy}><FileText size={14} aria-hidden="true" /> 출발 전날 예시 열기</button>
    </section>
  );
  const syllabusExample = (
    <section className="start-example" aria-labelledby="start-syllabus-title">
      <div className="start-example-heading"><span className="eyebrow">학업·과제 · 체험용 예시</span><h2 id="start-syllabus-title">과제 공지가 바뀌어도 준비는 이어지도록</h2></div>
      <p className="start-incoming">“팀 과제 마감은 10월 3일에서 10월 10일로 연장됐습니다.”</p>
      <div className="start-example-outcome"><span><FileText size={15} aria-hidden="true" /> 마감과 제출 안내를 함께 검토</span><span><Check size={15} aria-hidden="true" /> 준비 목록을 같은 작업 공간에</span></div>
      <button type="button" className="start-sample-button" onClick={() => props.onSample('syllabus')} disabled={props.busy}><Sparkles size={16} aria-hidden="true" /> 과제 예시 열기 <ArrowRight size={16} aria-hidden="true" /></button>
      <p className="start-field-help">준비된 체험용 공지로 변경 검토와 저장을 체험합니다. 실제 AI 호출은 하지 않습니다.</p>
    </section>
  );
  const genericExamples = (
    <section className="start-example start-contexts" aria-labelledby="start-contexts-title">
      <div className="start-example-heading"><span className="eyebrow">자료 없이 먼저 둘러보기 · 체험용 예시</span><h2 id="start-contexts-title">어떤 예시로 시작할까요?</h2></div>
      <p className="start-field-help">선택한 예시로 새 작업을 만듭니다. 실제 AI 호출은 하지 않습니다.</p>
      <article>
        <h3>업무·프로젝트</h3><p>미팅 시간과 자료 마감 변경, 고정한 보고 일정과 완료 기록을 함께 검토합니다.</p>
        <button type="button" className="start-sample-button" onClick={() => props.onSample('coordination')} disabled={props.busy}>고객 미팅 변경 체험 시작 <ArrowRight size={16} aria-hidden="true" /></button>
      </article>
      <article>
        <h3>학업·과제</h3><p>마감 공지가 바뀌면 제출 준비와 안내 문장을 함께 확인합니다.</p>
        <button type="button" className="start-sample-button" onClick={() => props.onSample('syllabus')} disabled={props.busy}>과제 예시 열기 <ArrowRight size={16} aria-hidden="true" /></button>
      </article>
      <article>
        <h3>생활·약속</h3><p>여행 인원과 도착 시간이 바뀌어도 확정한 약속과 준비를 지킵니다.</p>
        <button type="button" className="start-sample-button" onClick={() => props.onSample('departure')} disabled={props.busy}>출발 전날 복합 체험 시작 <ArrowRight size={16} aria-hidden="true" /></button>
        <button type="button" className="start-secondary-example" onClick={() => props.onSample('travel')} disabled={props.busy}>체험용 여행 예시 시작</button>
      </article>
    </section>
  );
  const example = props.coordinationFirst ? coordinationExample : props.syllabusFirst ? syllabusExample : props.departureFirst ? departureExample : props.travelFirst || props.template === 'travel' ? basicExample : props.template === 'coordination' ? coordinationExample : genericExamples;
  return (
    <section className="workspace-start" aria-labelledby="workspace-home-title" data-example-first={props.exampleFirst}>
      <div className="start-intro">
        <p className="eyebrow">{intro.kicker}</p>
        <h1 id="workspace-home-title">{intro.title},<br />여기서 이어가세요.</h1>
        <p className="start-lede">{intro.description}</p>
        <ol className="start-steps" aria-label="내 계획 시작 순서">
          <li><span>01</span><div><strong>이름과 목적 정하기</strong><p>{intro.help}</p></div></li>
          <li><span>02</span><div><strong>가지고 있는 원문 붙여넣기</strong><p>다음 화면에서 원문을 넣으면 Gemini가 변경 후보와 근거를 정리해요.</p></div></li>
          <li><span>03</span><div><strong>변경 확인하고 저장하기</strong><p>변경 내용과 원문 근거를 확인하고, 바꿀 내용을 결정해요. 승인한 변경안만 저장돼요.</p></div></li>
        </ol>
        <p className="start-retention">로그인 없이 시작할 수 있어요. 저장된 작업은 7일 동안 사용하지 않으면 만료됩니다.</p>
      </div>

      <div className="start-options">
        {props.exampleFirst ? <>{example}{form}</> : <>{form}{example}</>}
      </div>
    </section>
  );
}
