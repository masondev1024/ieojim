import { ArrowRight, CalendarCheck2, ClipboardList, FileCheck2, LockKeyhole, ShieldCheck } from 'lucide-react';
import { Link } from 'react-router-dom';
import './assistant-landing.css';

const workflow = [
  'Gemini가 미팅 시간, 사전 보고, 장소, 자료 마감의 변경과 원문 근거를 찾습니다.',
  'TypeScript 코드가 고정한 보고 일정, 완료한 인쇄 확인, 저장된 계획 버전을 다시 확인합니다.',
  '담당자가 고른 변경만 반영하고, 체크리스트 마감일과 예상 시간은 다음 정정에도 유지합니다.',
] as const;

export default function AssistantLanding() {
  return (
    <main className="assistant-landing">
      <section className="assistant-hero" aria-labelledby="assistant-title">
        <nav className="assistant-nav" aria-label="비서 업무 제품">
          <Link className="assistant-brand" to="/">
            <span>이어짐</span>
            <small>IEOJIM</small>
          </Link>
          <div className="assistant-nav-actions">
            <a href="#assistant-flow">흐름</a>
            <Link to="/app?example=coordination">체험 예시</Link>
            <Link to="/login">로그인</Link>
          </div>
        </nav>

        <div className="assistant-hero-grid">
          <div className="assistant-copy">
            <p className="assistant-kicker">기업 비서 · 경영지원 미팅 준비</p>
            <h1 id="assistant-title">미팅 안내가 바뀌어도 준비 업무를 처음부터 다시 짜지 않아요.</h1>
            <p className="assistant-lede">
              고객 미팅 시간이 밀리고 자료 마감이 앞당겨져도, 원문 근거와 변경안을 한 화면에서 확인해요.
              고정한 보고 일정, 이미 끝낸 일, 직접 적은 안내문은 담당자가 승인하기 전까지 그대로 남습니다.
            </p>
            <div className="assistant-actions" aria-label="시작 동작">
              <Link className="assistant-primary" to="/app?template=coordination">
                실제 미팅 안내로 시작
                <ArrowRight size={18} aria-hidden="true" />
              </Link>
              <Link className="assistant-secondary" to="/app?example=coordination">
                체험용 고객 미팅 보기
              </Link>
            </div>
          </div>

          <section className="assistant-board" aria-label="고객 미팅 변경 예시">
            <div className="assistant-board-head">
              <p className="assistant-synthetic-label">체험용 예시 · AI 호출 없음</p>
              <h2>준비된 고객 미팅 정정 안내</h2>
            </div>
            <div className="assistant-change-grid">
              <article>
                <CalendarCheck2 size={20} aria-hidden="true" />
                <span>변경</span>
                <strong>미팅 14:00→16:00 · 장소 본사 3층→별관 2층</strong>
              </article>
              <article>
                <FileCheck2 size={20} aria-hidden="true" />
                <span>앞당김</span>
                <strong>발표자료 마감 9월 17일→9월 16일</strong>
              </article>
              <article>
                <LockKeyhole size={20} aria-hidden="true" />
                <span>보호</span>
                <strong>고정한 사전 보고와 완료한 인쇄 확인은 직접 선택</strong>
              </article>
              <article>
                <ClipboardList size={20} aria-hidden="true" />
                <span>준비</span>
                <strong>체크리스트별 마감일과 예상 시간을 담당자가 저장</strong>
              </article>
            </div>
          </section>
        </div>
      </section>

      <section className="assistant-flow" id="assistant-flow" aria-labelledby="assistant-flow-title">
        <div>
          <p className="assistant-section-kicker">미팅 준비의 흐름</p>
          <h2 id="assistant-flow-title">담당자가 확인할 변경만 또렷하게 모읍니다.</h2>
          <p>
            새 안내를 붙여넣으면 AI가 바뀐 내용을 제안하고, 코드는 근거와 계산을 확인합니다.
            담당자가 선택을 마친 뒤 승인한 변경 묶음만 저장되고, 마감일과 예상 시간은 다음 정정에도 따로 유지됩니다.
          </p>
        </div>
        <ol>
          {workflow.map((item, index) => (
            <li key={item}>
              <span>{String(index + 1).padStart(2, '0')}</span>
              <p>{item}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="assistant-trust" aria-labelledby="assistant-trust-title">
        <div>
          <p className="assistant-section-kicker">안심하고 이어가는 업무</p>
          <h2 id="assistant-trust-title">내가 확인한 내용만 준비 업무에 반영합니다.</h2>
        </div>
        <div className="assistant-trust-list">
          <article>
            <ShieldCheck size={20} aria-hidden="true" />
            <strong>사용자 결정 보존</strong>
            <p>저장된 마감일, 예상 시간, 완료 상태는 새 원문이 와도 승인 없이 바뀌지 않습니다.</p>
          </article>
          <article>
            <ClipboardList size={20} aria-hidden="true" />
            <strong>준비 업무 중심</strong>
            <p>일정 최적화 대신 지금 해야 할 자료와 확인 업무를 명확히 남깁니다.</p>
          </article>
          <article>
            <CalendarCheck2 size={20} aria-hidden="true" />
            <strong>실행 전 확인</strong>
            <p>Google Calendar나 이메일 실행은 따로 연결하고 승인해야 해요. 이어짐은 먼저 검토할 준비 상태를 남깁니다.</p>
          </article>
        </div>
      </section>
    </main>
  );
}
