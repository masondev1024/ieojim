import { ArrowRight, BriefcaseBusiness, CheckCircle2, ClipboardCheck, Clock3, FileText, GraduationCap, HeartHandshake, LockKeyhole, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import ContinuityScene from '../scene/ContinuityScene.tsx';
import CoordinationDemo from './CoordinationDemo.tsx';
import MaterialsDemo from './MaterialsDemo.tsx';
import DepartureDemo from './DepartureDemo.tsx';
import './landing.css';

const workflowSteps = [
  '새 안내를 원문으로 남기고, Gemini가 바뀐 내용과 근거 문장을 찾아요.',
  'TypeScript 코드가 원문 근거와 계산이 맞는지, 고정한 항목에 영향이 있는지 확인해요. 저장된 계획의 버전도 비교해요.',
  '고정한 약속이나 완료한 준비는 어떻게 처리할지 직접 선택해요. 검토한 변경안을 승인하면 계획에 저장돼요.',
] as const;

const contextCards = [
  {
    icon: BriefcaseBusiness,
    label: '업무·프로젝트',
    title: '고객 미팅과 준비 업무',
    body: '미팅 시간과 자료 마감이 바뀌어도 고정한 보고 일정과 준비 업무를 따로 확인해요.',
    to: '/app?example=coordination',
  },
  {
    icon: GraduationCap,
    label: '학업·과제',
    title: '마감과 제출 조건 정리',
    body: '과제 안내가 바뀌면 제출 조건, 직접 고친 메모, 완료한 체크리스트를 함께 살펴봐요.',
    to: '/app?example=syllabus',
  },
  {
    icon: HeartHandshake,
    label: '생활·약속',
    title: '여행과 개인 일정 변경',
    body: '도착 시간이나 인원이 바뀔 때 약속, 비용, 이미 끝낸 준비를 잃지 않고 정리해요.',
    to: '/app?example=departure',
  },
] as const;

export function ProductLanding() {
  const [departureDemoActive, setDepartureDemoActive] = useState(false);

  return (
    <main className="product-landing">
      <section className="landing-hero" aria-labelledby="landing-title">
        <nav className="landing-nav" aria-label="제품">
          <Link className="landing-brand" to="/" aria-label="이어짐 홈">
            <span className="landing-brand-korean">이어짐</span>
            <span className="landing-brand-latin" lang="en">IEOJIM</span>
          </Link>
          <div className="landing-nav-actions">
            <a href="#outcome-preview">예시 결과</a>
            <a href="#contexts">활용 분야</a>
            <a href="#how-it-works">작동 방식</a>
            <Link to="/login">로그인</Link>
          </div>
        </nav>

        <div className="landing-hero-grid">
          <div className="landing-hero-copy">
            <p className="landing-kicker">바뀐 안내를 붙여넣고, 근거를 확인하고, 내가 승인해요.</p>
            <h1 id="landing-title">
              일정 하나 바뀌었다고,
              <span>처음부터 다시 짜지 마세요.</span>
            </h1>
            <p className="landing-lede">
              바뀐 안내문을 붙여넣으면 AI가 변경 내용과 원문 근거를 찾아줘요.
              고정해 둔 약속과 완료한 준비는 바꾸기 전에 물어보고, 내가 확인한 내용만 계획에 반영해요.
            </p>
            <div className="landing-actions" aria-label="시작 동작">
              <Link className="landing-primary-action" to="/app?template=custom">
                내 안내로 시작하기
                <ArrowRight aria-hidden="true" size={18} />
              </Link>
              <a className="landing-secondary-action" href="#contexts">체험 예시 보기</a>
              <Link className="landing-secondary-action" to="/recovery">일정 조정안 보기</Link>
            </div>
            <dl className="landing-outcome-strip" aria-label="대표 예시 요약">
              <div>
                <dt>새 안내</dt>
                <dd>발표 14→11시 · 자료 수정본 도착</dd>
              </div>
              <div>
                <dt>확인 필요</dt>
                <dd>끝낸 초안 검토, 수정본도 확인한 걸까요?</dd>
              </div>
              <div>
                <dt>다시 안 해도 되는 일</dt>
                <dd>내가 적어 둔 준비 시간과 메모를 다시 입력할 필요 없이</dd>
              </div>
            </dl>
          </div>

          <section
            className="landing-story-board"
            id="outcome-preview"
            aria-labelledby="preview-title"
          >
            <div className="landing-story-header">
              <p className="landing-synthetic-label">체험용 예시 · AI 호출 없음</p>
              <h2 id="preview-title">끝낸 준비도, 자료가 바뀌면 다시 봐야 하니까.</h2>
              <p>
                준비된 데이터로 무엇을 바꾸고 지킬지 골라 보세요. 결과는 이 화면에서만 미리 확인하며 저장되지 않아요.
              </p>
            </div>

            <article className="landing-crisis-card" aria-label="발표 자료 변경과 기존 준비">
              <div>
                <span>새 안내</span>
                <strong>“발표가 오전으로 당겨졌어요. 자료는 수정본으로 확인해 주세요.”</strong>
              </div>
              <div>
                <span>이미 내린 결정</span>
                <strong>초안 검토 완료 · 다른 고객 약속은 고정 · 전달 메모도 작성해 둠</strong>
              </div>
            </article>

            <div className="landing-preservation-stack" aria-label="보호되는 사용자 작업">
              <article>
                <LockKeyhole aria-hidden="true" size={18} />
                <div>
                  <strong>기존 약속과 메모는 그대로</strong>
                  <p>새 자료를 반영해도 고정한 고객 약속과 내가 쓴 전달 메모는 남겨 둬요.</p>
                </div>
              </article>
              <article>
                <ClipboardCheck aria-hidden="true" size={18} />
                <div>
                  <strong>다시 봐야 할 준비를 찾아서</strong>
                  <p>초안을 검토한 기록은 지우지 않고, 수정본 때문에 다시 확인할 일을 표시해요.</p>
                </div>
              </article>
            </div>

            <MaterialsDemo />
          </section>
        </div>
      </section>

      <section className="landing-context-section" id="contexts" aria-labelledby="contexts-title">
        <div className="landing-context-copy">
          <p className="landing-section-kicker">업무부터 일상까지</p>
          <h2 id="contexts-title">미팅이든 과제든, 바뀐 안내 때문에 다시 챙겨야 할 때.</h2>
          <p>내 상황에 가까운 예시를 골라 보세요. 다음 화면에서 체험용 예시를 열거나 내 안내로 시작할 수 있어요.</p>
        </div>
        <div className="landing-context-grid">
          {contextCards.map((card) => {
            const Icon = card.icon;
            return (
              <Link key={card.to} className="landing-context-card" to={card.to}>
                <Icon aria-hidden="true" size={22} />
                <span>{card.label}</span>
                <strong>{card.title}</strong>
                <p>{card.body}</p>
              </Link>
            );
          })}
        </div>
      </section>

      <details className="landing-protection-demo">
        <summary>고정한 일정과 완료 기록을 바꾸려 할 때</summary>
        <p>이전 예시에서는 고정한 보고 시간 변경과 완료 항목 삭제를 직접 결정해 볼 수 있어요. 체험용 예시이며 AI 호출이나 저장은 하지 않아요.</p>
        <CoordinationDemo />
      </details>

      <section className={`landing-life-demo${departureDemoActive ? ' landing-life-demo--active' : ''}`} aria-labelledby="life-demo-title">
        <div className="landing-life-copy">
          <p className="landing-section-kicker">생활 예시</p>
          <h2 id="life-demo-title">출발 전날 새 안내가 와도, 정해 둔 약속은 지켜야 하니까.</h2>
          <p>
            도착 시간과 인원이 바뀌면 저녁 약속과 준비한 물품은 어떻게 할까요? 바꿀 것과 그대로 둘 것을 골라 보세요.
          </p>
          <div className="landing-life-actions">
            <Link className="landing-inline-link" to="/app?example=departure">
              체험용 예시 열기
              <ArrowRight aria-hidden="true" size={16} />
            </Link>
            <Link className="landing-inline-link" to="/app?template=travel">내 여행 정리하기</Link>
          </div>
        </div>
        <div className="landing-life-panel">
          <DepartureDemo onActiveChange={setDepartureDemoActive} />
        </div>
      </section>

      <section className="landing-light-band" id="how-it-works" aria-labelledby="process-title">
        <div className="landing-process-copy">
          <p className="landing-section-kicker">작동 방식</p>
          <h2 id="process-title">AI가 찾고, 코드가 확인하고, 내가 결정해요.</h2>
          <p>
            이어짐은 새 문장을 계획에 바로 덮어쓰지 않아요. Gemini가 원문에서 바뀐 사실과 근거 문장을 제안하고,
            TypeScript 코드가 원문 근거와 계산, 고정한 항목, 저장된 계획 버전을 확인해요.
            확인이 필요한 항목을 결정한 뒤, 검토한 변경안을 한 번에 저장할 수 있어요.
          </p>
        </div>

        <ol className="landing-workflow-list">
          {workflowSteps.map((step, index) => (
            <li key={step}>
              <span>{String(index + 1).padStart(2, '0')}</span>
              <p>{step}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="landing-scene-section" aria-labelledby="scene-title">
        <div className="landing-scene-copy">
          <p className="landing-section-kicker">변경이 이어지는 모습</p>
          <h2 id="scene-title">인원 하나 바뀌면, 비용은 어떻게 달라질까요?</h2>
          <p>준비된 체험용 예시예요. 실제 일정은 아니고, 사용자가 재생할 때만 움직여요.</p>
        </div>
        <div className="landing-scene" aria-label="원문 변경이 계획 항목에 전달되는 체험용 예시">
          <ContinuityScene />
        </div>
      </section>

      <section className="landing-product-notes" aria-labelledby="notes-title">
        <div>
          <p className="landing-section-kicker">제품 원칙</p>
          <h2 id="notes-title">저장된 계획이 새 안내로 바로 바뀌지 않도록</h2>
        </div>
        <div className="landing-note-list">
          <article>
            <FileText aria-hidden="true" size={20} />
            <strong>원문과 계산을 분리</strong>
            <p>안내문에 적힌 내용과 계산한 결과를 구분해서 보여줘요. 변경 이유를 원문과 함께 확인할 수 있어요.</p>
          </article>
          <article>
            <ShieldCheck aria-hidden="true" size={20} />
            <strong>고정한 결정 보호</strong>
            <p>잠근 일정과 완료한 일은 바꾸기 전에 물어봐요. 직접 고친 메모는 남겨 두고 다시 확인할 부분을 표시해요.</p>
          </article>
          <article>
            <Clock3 aria-hidden="true" size={20} />
            <strong>작업 공간에서 저장·되돌리기</strong>
            <p>작업 공간에서는 저장하고, 다시 열고, 이전 버전으로 되돌릴 수 있어요. 이 첫 화면은 미리보기예요.</p>
          </article>
        </div>
      </section>

      <footer className="landing-footer">
        <div>
          <p>AI Championship 2026 출품을 준비하고 있어요.</p>
          <p>
            게스트 작업은 같은 브라우저에서 이어서 볼 수 있어요. 7일 동안 활동이 없으면 저장된 작업이 정리될 수 있어요.
          </p>
        </div>
        <nav aria-label="공개 안내">
          <Link to="/privacy">개인정보</Link>
          <Link to="/terms">이용 조건</Link>
          <Link to="/login">로그인</Link>
          <Link to="/app?template=custom">
            내 안내로 시작하기
            <CheckCircle2 aria-hidden="true" size={16} />
          </Link>
        </nav>
      </footer>
    </main>
  );
}

export default ProductLanding;
