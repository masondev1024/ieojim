# 이어짐 — AI Championship 제출 가이드

갱신일: 2026-09-20. 이 문서는 Wanted AI Championship 2026 제출 화면과 공개 서비스의 현재 사실을 기록한다. 공개 서비스 주소는 `https://ieojim.jungseongheon.org`이고, 현재 공개 Worker 버전은 `938a8b1a-0dac-4eef-a8f9-ce0a2e4d17a4`다.

Wanted `내 과제`의 미리보기와 편집 화면을 2026-09-20에 다시 확인했다. 기존 프로젝트는 이미 제출되어 편집 화면의 최종 동작이 `제출하기`가 아닌 `수정하기`로 표시된다. 저장된 서비스 URL은 canonical domain이며, 대표 이미지 1장과 보조 스크린샷 4장이 렌더링된다. 따라서 중복 제출이나 제출 내용 변경은 하지 않았다.

## 1. 대표 이미지

대표 이미지는 아래 파일을 사용한다.

```text
docs/submission/assets/2026-09-15/01-hero.png
```

이 이미지는 `https://ieojim.jungseongheon.org/`의 실제 공개 화면 캡처다. 생성형 이미지나 디자인 목업이 아니다.

## 2. 제목

> 이어짐 — 일정 하나 바뀌었다고, 처음부터 다시 짜지 마세요

## 3. 해결하고자 한 문제

> 미팅·과제·여행 안내가 바뀔 때마다 일정·비용·준비 목록을 다시 맞추다가, 이미 정한 약속과 끝낸 준비를 놓치는 문제

## 4. AI 활용 방식 및 결과

저장된 본문은 편집 화면 기준 **446자**이며 폼의 500자 제한 이내다.

> 발표 시간이 당겨지면 이동과 준비 업무도 함께 바뀝니다. 이어짐은 이런 변경을 반영하면서 이미 정한 약속과 끝낸 준비를 지키는 데 집중했습니다. Gemini가 새 안내문에서 변경 내용과 근거 문장을 찾고, TypeScript 코드가 근거·계산·계획 버전을 검증합니다. 고정한 일정이나 완료한 할 일과 충돌하면 사용자에게 확인하고, 직접 쓴 메모와 준비 설정은 유지합니다. 승인한 변경만 저장하며 이전 내용으로 복원할 수도 있습니다. 별도의 체험용 예시에서는 발표 시간 변경에 맞춰 준비·이동·다른 업무를 조정하고, 불가능한 조건은 적용을 막습니다. 체험과 실제 AI 분석은 구분해 표시했습니다. 승인한 예시 일정 4건은 이어짐 전용 Google Calendar에 실제 등록하고 다시 조회해 일치를 확인했습니다. 개발에는 Codex를 활용해 설계·구현·별도 에이전트 리뷰·회귀 테스트를 반복했습니다.

과장해서 쓰지 말아야 할 내용:

- 실제 사용자 3명 이상 테스트는 완료 사실로 쓰지 않는다.
- Google 기본 Calendar 변경, Gmail 권한 추가, Gmail 발송, 이메일 수신·열람 확인은 완료 사실로 쓰지 않는다.
- 합성 일정 체험은 실제 Gemini 호출과 구분해서 설명한다.
- 실제 Gemini smoke는 1회 성공했지만, 경쟁 서비스 대비 일반 정확도나 사용자 성과로 확장하지 않는다.
- Calendar 실증은 전용 Ieojim 보조 Calendar의 합성 개인 사본 4건에 한정한다.

## 5. 사용 AI 툴 및 기술 스택

현재 제출 화면의 체크박스에는 아래 세 항목이 선택돼 있다.

```text
React
ChatGPT
Gemini
```

Codex는 개발 과정에서 사용했으므로 AI 활용 본문에 명시했다. 그 외 선택되지 않은 도구는 실제 사용 근거 없이 추가하지 않는다.

추가 자유 입력이 가능하면 아래처럼 적는다.

> TypeScript, React/Vite, Hono, Cloudflare Workers, D1, Queues, Gemini API, React Three Fiber/Three.js, Better Auth, Zod, Playwright, Vitest. 개발 AI: Codex.

## 6. 서비스 링크

> https://ieojim.jungseongheon.org

이 주소는 공개 custom domain이다. 현재 배포는 Cloudflare `ieojim-staging` Worker와 `ieojim-staging` D1을 사용한다. 이름은 staging이지만 제출용 공개 주소와 연결된 현재 운영 대상이다.

심사 기간에는 이 주소의 DNS, 인증서, Worker, D1, Queue, Google/OAuth secret, Gemini secret을 유지한다. 기존 `workers.dev` 주소는 게스트 연속성 검증용으로 남아 있지만 제출 폼에는 custom domain을 사용한다.

## 7. 스크린샷 등록

ZIP 파일:

```text
docs/submission/ieojim-submission-images.zip
```

개별 파일은 `docs/submission/assets/2026-09-15/` 아래에 있다. 모두 공개 배포 `db8aea67-3e79-48c6-9d3f-7bb6017f837c`에서 촬영한 1600×900 PNG다. 제출 화면에는 1번을 대표 이미지로, 2–5번을 보조 스크린샷으로 저장했다. 현재 런타임은 `938a8b1a-0dac-4eef-a8f9-ce0a2e4d17a4`지만, 제출 이미지는 기존 공개 화면의 실제 캡처라는 provenance를 유지한다.

| 순서 | 업로드 파일 | 보여주는 가치 |
| --- | --- | --- |
| 1 | `01-hero.png` | 업무·학업·생활의 변경 안내와 보호할 결정을 한 화면에서 설명 |
| 2 | `02-recovery-chain.png` | 발표 변경이 준비·이동·경비 일정으로 이어지는 네 가지 재배치 |
| 3 | `03-recovery-blocked.png` | 조건을 만족할 수 없을 때 기존 일정을 보존하고 승인을 차단 |
| 4 | `04-coordination-review.png` | 원문 변경, 잠근 보고, 완료한 인쇄 확인을 사용자가 직접 검토 |
| 5 | `05-coordination-approved-plan.png` | 승인 후 저장된 계획과 보호된 준비 설정 |

대표 이미지는 1번을 사용하고, 스크린샷 영역에는 2–5번을 순서대로 저장했다. 2026-09-20 편집 화면과 미리보기에서 모두 렌더링됨을 확인했다.

## 8. 심사위원에게 보여줄 3분 체험

1. `https://ieojim.jungseongheon.org` 첫 화면에서 범용 변경 안내 서비스를 확인한다.
2. `/recovery`로 들어가 발표 시간이 바뀌었을 때 준비, 이동, 경비 정리, 보호 일정이 어떻게 재배치되는지 본다.
3. `다음 목·금으로 새 체험`을 눌러 심사일 기준 미래 날짜 예시를 만든다. 이 버튼은 저장된 기존 작업 공간을 덮어쓰지 않는다.
4. 가능한 조건에서는 서버 복구안을 저장, 재계산, 승인, 새로고침 후 유지까지 확인한다.
5. 불가능한 조건에서는 승인을 차단하고, 어떤 조건이 막혔는지 표시되는지 확인한다.
6. 실제 원문 기반 workspace에서는 변경 검토 화면에서 잠근 약속과 완료한 준비 삭제가 사용자 선택을 요구하는지 확인한다.

Calendar 실증은 전용 Ieojim 보조 Calendar에서만 완료됐다. 2026-09-20의 새 미래 날짜 체험은 Calendar에 합성 개인 사본 4건을 쓰고 처리 직후 재조회 **4/4**, 이후 사용자가 누른 별도 재조회 **4/4** 일치를 기록했다. 반복 감시는 opt-in 상태로 꺼져 있으며, Google 기본 Calendar 변경, Gmail 권한 추가, Gmail 발송은 수행하지 않았다.

## 9. 제출 완료 확인

- [x] 편집 화면이 `수정하기` 상태여서 임시저장이 아닌 제출 완료 상태임을 확인했다.
- [x] 대표 이미지 1장과 보조 스크린샷 4장이 미리보기에서 렌더링된다.
- [x] 서비스 URL은 `https://ieojim.jungseongheon.org`이다.
- [x] 제출 완료 이후에는 불필요한 공개 폼 수정이나 중복 제출을 하지 않는다.
- 폼 마감은 사용자 확인 기준으로 2026-09-20이다. 마감 후에도 Worker/D1/Queue와 custom domain을 유지한다.
- 제출 후에는 Worker/D1/Queue를 삭제하거나 custom domain을 바꾸지 않는다.

## 검증 근거

- 제출 문구: `artifacts/submission-release-2026-09-15/form-copy.json`, AI 설명 392자
- 이미지 manifest: `docs/submission/assets/2026-09-15/manifest.json`
- 공개 배포: `artifacts/submission-release-2026-09-15/deploy.log`
- loop verify: `artifacts/submission-release-2026-09-15/loop-verify-final.log`, `npm run verify` PASS
- 로컬 브라우저: `artifacts/submission-release-2026-09-15/local-browser.log`, Chromium 97/97 PASS
- 공개 도메인 브라우저: `artifacts/submission-release-2026-09-15/calendar-scope-domain.log`, 27/27 PASS
- 공개 recovery smoke: `artifacts/submission-release-2026-09-15/public-recovery-smoke.json`, future date/save/recompute/approve/reload/cleanup PASS
- 실제 Gemini smoke: `artifacts/submission-release-2026-09-15/live-ai.log`, 1회 성공 및 cleanup
- Calendar scope loop: `artifacts/submission-release-2026-09-15/calendar-scope-verify.log`, `npm run verify` PASS 89.020초
- Calendar scope 통합 테스트: `artifacts/submission-release-2026-09-15/calendar-scope-after.log`, 4/4 PASS
- 독립 리뷰: root handoff 기준 Calendar scope 수정 APPROVE
- Calendar 실연결: `artifacts/submission-release-2026-09-15/calendar-live-verified.json`, action verified, mappings 4
- 2026-09-20 release: protected PR #1 merge; migration0013 applied; Worker `938a8b1a-0dac-4eef-a8f9-ce0a2e4d17a4`; public-domain Playwright 27/27
- 2026-09-20 Calendar acceptance: future synthetic events 4/4 immediate provider readback and 4/4 explicit later recheck matched; watch off; no Gmail scope or delivery
- Google 설정: `artifacts/submission-release-2026-09-15/google-setup.json`, Calendar callback/API/scope 설정 완료, Calendar consent/write/readback 검증 완료, Gmail 미시도
