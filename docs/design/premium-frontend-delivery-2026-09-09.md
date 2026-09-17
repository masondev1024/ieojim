# 이어짐 프런트엔드 구현 기록

Motion+ 등 유료 디자인 도구 없이 D1–D3 화면을 구현했다. 범위는 제품 소개, 게스트 작업 홈, 작업별 주소와 원문·계획·검토·이력 화면, 선택적으로 재생하는 3D 예시다. 계정과 상업 결제는 별도 후속 단계다.

## 실제 동작

| 주소 | 사용자가 할 수 있는 일 |
| --- | --- |
| `/` | 제품 설명과 인원 변경 예시를 보고 게스트 작업으로 진입 |
| `/app` | 최근 작업 선택, 이름·목적 입력으로 생성, 여행·과제 예시 시작 |
| `/app/workspaces/:id` | 원문 저장, 항목 편집·완료·고정, 영향·근거 검토, 승인, 내용 복원·삭제 |

첫 화면은 API를 호출하거나 익명 소유자를 만들지 않는다. 예시는 합성 자료라는 표시를 유지한다. 3D 소개 장면은 총액 900,000원, 인원 4→3명, 인당 비용 225,000→300,000원, 변경과 무관한 둘째 날 19:00 약속 보존을 설명한다. 소개 장면이 실제 AI 생성 결과인 것처럼 표시하지 않는다.

밝은 작업 화면에서는 검토가 없을 때 계획이 전체 폭을 사용하고, 필요할 때 원문·검토·이력을 연다. 모바일은 선택한 화면 하나를 보여 준다. 원문과 항목 편집 초안은 작업 A/B 전환, 같은 작업 다시 읽기, 앱 내부 홈 왕복 동안 보존한다. 초안은 메모리 안에만 있으며 전체 새로고침·탭 닫기 이후의 복구는 제공하지 않는다. 저장된 작업은 기존 D1에 남는다.

## 안정성 결정

- 주소가 작업 선택의 기준이다. 다른 작업 주소를 읽는 동안 이전 작업을 비우고, 실패한 주소에 이전 내용이 남지 않게 했다. 소유권 검사는 계속 서버가 담당한다.
- 기존 selection epoch, 요청 순서, AbortController, 수정 의도별 request ID, 근거·잠금·내용 버전 검사를 보존했다.
- 원문 초안은 작업 ID별로 보관한다. 확인 질문 답변은 복원할 때 현재 제안의 계보를 다시 검사한다.
- 서버가 변경을 승인하면 내용과 화면 선택을 함께 갱신한다. 보조 목록 조회의 늦은 응답은 사용자가 선택한 화면을 바꾸지 않는다.
- 3D 코드는 재생 클릭 뒤에만 불러온다. WebGL2 탐지용 context를 반환하고, 실제 context 손실 이벤트도 해제한다. 화면 밖·숨긴 탭에서는 RAF와 완료 타이머를 멈추며, 정지 상태는 demand 렌더링을 사용한다. DPR은 최대 1.5다.
- 동작 줄이기, WebGL 부재, 3D 모듈 로딩 실패, context 손실에서도 DOM 설명·값·진입 버튼은 사용할 수 있다. CSP의 script/style 정책을 완화하지 않았다.

## 무료 구성과 라이선스

| 구성 | 사용 목적 | 근거 |
| --- | --- | --- |
| React Router 7.18.3 | 홈과 작업 주소, 뒤로/앞으로 이동 | [공식 문서](https://reactrouter.com/start/declarative/installation) |
| Three.js 0.186.0 / React Three Fiber 9.7.0 | 선택적 3D 표현, React 19 호환 | [R3F 저장소](https://github.com/pmndrs/react-three-fiber), [Three.js 저장소](https://github.com/mrdoob/three.js) |
| CSS | 버튼·변경 강조 애니메이션 | Motion 및 Motion+ 미설치 |
| SUIT Variable | 한국어 화면 글꼴, 자체 호스팅 | [공식 SUIT](https://github.com/sun-typeface/SUIT), `public/fonts/SUIT-LICENSE.txt`의 SIL OFL |

SUIT WOFF2는 624,536 bytes다. 원본 Git blob은 `89d7e4c28fe8069a8110a79dc7ca3cd446745de9`, 저장 파일 SHA-256은 `aa894a204d5a6fbae259dac6868d350cbd373a390caee0313f92946af741df23`이다. 글꼴은 `font-display: optional`과 시스템 대체 글꼴을 사용한다.

개발 도구 Miniflare가 정확히 고정한 `sharp@0.35.2`에서 [GHSA-rgj7-g3m4-5g8c](https://github.com/advisories/GHSA-rgj7-g3m4-5g8c)가 확인돼, Miniflare 하위 의존성만 `0.35.4`로 override했다. [같은 minor의 보안 패치](https://sharp.pixelplumbing.com/changelog/v0.35.4/)이며 Wrangler/Miniflare 버전은 바꾸지 않았다. upstream이 수정 버전을 채택하면 override 제거를 검토한다. `npm audit`은 0건이다.

## 검증과 기록

최종 스테이징 버전은 `c96dcbb3-bd8d-4274-bb8c-899db7859466`이다. 타입·린트·빌드, 단위 **201개**, D1/런타임 통합 **91개**, 로컬 Chromium **39개**, 스테이징 Chromium **7개**가 통과했다. 스테이징 검사는 실제 CSP 아래의 WebGL 재생과 새 주소도 포함한다. 동작 줄이기·WebGL 부재·모듈 실패·context 손실·화면 밖 일시정지는 로컬 브라우저로 확인했다.

스테이징 첫 화면의 측정 LCP는 **1,540 / 1,232 / 1,188ms**, CLS는 세 번 모두 **0**이었다. 초기 canvas/API 호출 및 콘솔 오류는 0건이었다. Node gzip 기준 JS/CSS 전체와 WOFF2를 합한 크기는 **986,811 bytes**이며, 이 중 3D와 작업 앱 chunk는 진입/재생 전에는 전송하지 않는다. 이는 문서 아래에 명시한 단일 호스트 실험 조건의 관찰이다.

정확한 배포 버전, 최종 테스트 결과, 소스·산출물 해시는 `.omx/verification-premium-frontend.json`을 기준으로 한다. 검사 기록은 `artifacts/premium-verify.log`, `premium-e2e.log`, `premium-staging-browser.log`에 있다. 두 독립 정적 리뷰는 `.omx/reviews/premium-workspace-final.md`, `premium-scene-final.md`에 보관한다.

첫 스테이징 브라우저 실행은 6/7 통과했다. 복원 응답을 화면에 반영한 뒤 목록 조회를 기다렸다가 계획 탭으로 전환해, 사용자가 다시 연 이력이 닫히는 문제를 발견했다. 제어된 지연 응답으로 로컬 실패를 재현한 로그는 `premium-restore-regression-before.log`다. 수정 후 이 동작과 생성 중 뒤로 가기를 회귀 검사에 추가했다. 최초 실패는 `premium-staging-browser-first.log/json`에 남겼다.

구현 중 한 브라우저 실행은 병렬 테스트 실행·공유 서버 종료로 무효화됐다. 제품 실패로 합산하지 않았으며, 이후에는 한 소유자가 독립 서버와 전체 실행을 관리했다. 프로젝트 AGENTS.md에도 서버와 보고서 소유 규칙을 남겼다.

성능 관찰 스크립트는 `scripts/measure-frontend.ts`다. 390×844, CPU 4배 느리게, 지연 150ms, 다운로드 200,000 bytes/s, 매회 새 컨텍스트·캐시 비활성 조건으로 3회 측정한다. 실제 사용자 p75/INP나 모든 장치의 속도를 증명하는 수치가 아니다. 압축 크기와 측정 결과는 `artifacts/premium-frontend-performance.json`에 기록한다. 약 237KB gzip의 선택적 Three/R3F chunk에 대한 Vite 500KB raw 경고는 숨기지 않았다.

대표 화면: `artifacts/premium-landing-desktop.png`, `premium-landing-webgl.png`, `premium-home-desktop.png`, `premium-workspace-desktop.png`, `premium-landing-mobile.png`, `premium-impact-review-mobile.png`. 이전 생성 컨셉 이미지는 별도 디자인 참고 자료다.

## 다음 단계

1. **A1 계정과 게스트 작업 인계**: 로그인 방식·인증 제공자, 계정 복구, 세션 폐기, 소유권 인계의 동의 및 원자적·멱등 처리 설계.
2. **A2 보관과 사용량**: 계정 데이터의 보관 정책을 익명 7일 정책과 분리하고 사용량·삭제·내보내기 제공.
3. **B1 상업 결제**: 판매 주체·결제 제공자·가격을 정한 뒤 결제 이벤트 중복, 권한, 해지·환불·실패 흐름 구현.

실제 사용자 모집과 외부 알림 연결은 사용자의 지시에 따라 미뤘다. 이번 작업은 모델 정확도 재평가나 production 출시 승인이 아니며 새 유료 모델 호출을 수행하지 않았다. 원문·스키마·마이그레이션·예산·소유권·서버 모델 계약을 바꾸지 않았다.
