import { ArrowRight, Home, LogIn } from 'lucide-react';
import { Link } from 'react-router-dom';
import './legal.css';

type LegalPageProps = {
  kind: 'privacy' | 'terms';
};

const contactEmail = 'masondev1024@gmail.com';

const privacySections = [
  {
    id: 'collection',
    title: '수집하는 정보',
    body: [
      '로그인 없이 만든 작업을 같은 브라우저에서 다시 찾을 수 있도록 쿠키를 사용해요. 쿠키에는 작업 공간의 주인을 구분하는 임의의 값이 들어 있어요.',
      'Google 로그인에는 계정 ID, 이메일, 이름, 프로필 이미지를 사용해요. 로그인할 때는 기본 프로필 권한만 요청해요. 캘린더와 이메일 전송 권한은 해당 기능을 연결할 때 따로 동의를 받아요. Google Drive 권한은 요청하지 않아요.',
      '로그인을 유지하고 접속을 보호하기 위해 로그인 쿠키, 로그인한 시간과 만료 시간, IP 주소와 브라우저 정보가 저장될 수 있어요.',
      '붙여넣은 안내문, AI가 정리한 내용, 직접 수정한 값, 변경 이력, 처리 상태와 사용량을 저장해요.',
    ],
  },
  {
    id: 'use',
    title: '정보를 사용하는 곳',
    body: [
      '저장한 자료는 이전 작업을 다시 보여 주고, 새 안내에 따라 일정·비용·할 일·메모에서 무엇을 고쳐야 하는지 찾는 데 사용해요.',
      'AI로 정리하기를 요청하면 작업 목적, 현재 계획과 관련 안내문을 Google Gemini에 보내요. 로그인으로 받은 프로필은 AI에 보내지 않아요. 다만 안내문에 직접 적은 개인정보는 안내문과 함께 전달될 수 있어요.',
      '서비스 운영과 자료 보관에는 Cloudflare를 사용해요. Gemini 요청은 대화 저장을 사용하지 않도록 설정해요. 다만 Google이 보안·운영을 위해 별도로 정보를 보관할 수는 있어요.',
      '장애 확인용 로그에는 안내문 원문, 외부 서비스 연결에 쓰는 인증 정보, AI 응답 본문을 남기지 않도록 설계했어요.',
    ],
  },
  {
    id: 'retention',
    title: '보관과 삭제',
    body: [
      '작업 공간을 열거나 수정하면 보관 기한이 다시 계산돼요. 7일 동안 활동이 없으면 안내문, 저장된 계획과 변경 이력, AI 제안과 관련 처리 기록이 삭제될 수 있어요.',
      '로그인 상태는 7일 뒤 만료되고 자동으로 연장되지 않아요. 만료된 로그인 기록과 본인 확인용 임시 정보는 정리해요.',
      'Google로 연결한 계정 정보는 7일 동안 사용하지 않았다는 이유로 자동 삭제하지 않아요. 현재는 계정 전체를 직접 삭제하는 기능이 없어요. 계정이나 데이터 삭제를 원하면 아래 이메일로 문의해 주세요.',
    ],
  },
  {
    id: 'access',
    title: '접근과 보호',
    body: [
      '작업 공간을 읽거나 바꿀 때마다 쿠키 또는 로그인 정보로 소유자를 확인해요. 다른 사람의 작업 공간에는 접근할 수 없도록 제한해요.',
      'Google 연결에 필요한 인증 정보는 암호화해 보관하도록 설정했어요. 비밀번호로 로그인하기, 로그인 이메일 바꾸기, 서로 다른 Google 계정 합치기는 제공하지 않아요.',
      '운영자는 장애 대응, 부정 사용 방지, 서비스 유지와 삭제 요청 처리에 필요한 범위에서 저장된 자료를 확인할 수 있어요.',
    ],
  },
];

const termsSections = [
  {
    id: 'service',
    title: '이어짐이 하는 일',
    body: [
      '이어짐은 AI Championship 2026 출품을 준비 중인 서비스예요. 운영 상황과 심사 기간에 따라 제공하는 기능, 접속 가능 여부와 보관 정책이 바뀔 수 있어요.',
      '안내문을 저장하고 AI가 찾은 변경 내용을 검토해 계획에 적용할 수 있어요. 직접 확인한 조건으로 일정을 조정하고, Google 로그인과 자료 내보내기도 사용할 수 있어요.',
    ],
  },
  {
    id: 'responsibility',
    title: '사용자 책임',
    body: [
      '본인이 사용할 권리가 있는 자료만 넣어 주세요. 주민등록번호, 결제 정보, API 비밀 키처럼 계획을 정리하는 데 필요하지 않은 민감 정보는 넣지 마세요.',
      'AI가 만든 변경안은 적용 전에 직접 확인해 주세요. 원문 근거, 계산과 바뀌는 항목을 살펴본 뒤 승인한 내용만 계획에 적용해요.',
      '이어짐은 예약·결제나 법률·의료·재무 판단을 대신하지 않아요. 캘린더 변경과 이메일 전송은 해당 서비스를 따로 연결하고, 적용할 내용을 직접 승인해야 해요.',
    ],
  },
  {
    id: 'account-retention',
    title: '계정과 보관',
    body: [
      '로그인하면 계정에 연결한 작업을 다른 기기에서 이어 볼 수 있어요. 로그인 전에 만든 작업은 자동으로 옮기지 않아요. 목록과 옮길 계정을 확인한 뒤 직접 옮겨 주세요.',
      '작업 공간은 7일 동안 열거나 수정하지 않으면 삭제될 수 있어요. 로그인 상태도 7일 뒤 만료돼요. 장기 보관, 결제, 계정 전체 직접 삭제는 아직 제공하지 않아요.',
      '삭제 요청이나 서비스 문의는 아래 이메일로 보내 주세요.',
    ],
  },
  {
    id: 'operations',
    title: '서비스 운영',
    body: [
      '짧은 시간에 요청이 몰리거나, 사용 한도 초과·외부 서비스 장애·보안 문제가 생기면 일부 요청과 AI 실행을 제한할 수 있어요.',
      '외부 서비스가 멈추거나 AI 응답이 늦어지면 일부 기능을 잠시 사용할 수 없어요. AI 결과에는 오류가 있을 수 있으니 직접 확인하고, 중요한 계획은 내보내기로 따로 보관해 주세요.',
      '중요한 일정을 결정할 때는 원문 자료와 공식 안내도 함께 확인해 주세요.',
    ],
  },
];

export default function LegalPage({ kind }: LegalPageProps) {
  const isPrivacy = kind === 'privacy';
  const title = isPrivacy ? '개인정보 처리 안내' : '서비스 이용 조건';
  const lede = isPrivacy
    ? '어떤 정보를 저장하고 AI에 무엇을 보내는지, 자료를 언제 삭제하는지 안내해요.'
    : 'AI 결과를 확인하는 방법과 자료 보관 등, 이어짐을 사용할 때 알아둘 내용이에요.';
  const sections = isPrivacy ? privacySections : termsSections;

  return (
    <main className="legal-page">
      <header className="legal-hero">
        <nav className="legal-nav" aria-label="공개 문서">
          <Link className="legal-brand" to="/">이어짐</Link>
          <div>
            <Link to="/privacy">개인정보</Link>
            <Link to="/terms">이용 조건</Link>
            <Link to="/login">로그인</Link>
          </div>
        </nav>
        <p className="legal-kicker">안내 업데이트 2026-09-15</p>
        <h1>{title}</h1>
        <p className="legal-lede">{lede}</p>
      </header>

      <section className="legal-summary" aria-label="운영자 정보">
        <div>
          <span>운영자</span>
          <strong>정성헌</strong>
        </div>
        <div>
          <span>공개 연락처</span>
          <a href={`mailto:${contactEmail}`}>{contactEmail}</a>
        </div>
        <div>
          <span>서버와 자료 보관</span>
          <strong>Cloudflare Workers와 D1</strong>
        </div>
      </section>

      <article className="legal-document" aria-labelledby="legal-document-title">
        <h2 id="legal-document-title">{title}</h2>
        {sections.map((section) => (
          <section key={section.id} aria-labelledby={`legal-${kind}-${section.id}`}>
            <h3 id={`legal-${kind}-${section.id}`}>{section.title}</h3>
            {section.body.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
          </section>
        ))}
      </article>

      <footer className="legal-footer">
        <Link to="/">
          <Home aria-hidden="true" size={17} />
          홈
        </Link>
        <Link to="/login">
          <LogIn aria-hidden="true" size={17} />
          Google 로그인
        </Link>
        <Link to="/app">
          작업 공간
          <ArrowRight aria-hidden="true" size={17} />
        </Link>
      </footer>
    </main>
  );
}
