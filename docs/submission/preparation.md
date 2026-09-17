# 이어짐 — AI Championship 제출 가이드

갱신일: 2026-09-15. 이 문서는 Wanted AI Championship 2026 과제 제출 폼을 위에서 아래로 채우기 위한 현재 기준이다. 공개 서비스 주소는 `https://ieojim.jungseongheon.org`이고, 현재 공개 Worker 버전은 `57b36613-b7fd-4069-864d-f62444ed0232`다.

Wanted 내 과제 화면에서 "임시 저장" 상태를 확인했다. 제목, 문제, React/Gemini 선택은 저장돼 있다. 실제 Calendar 검증 결과를 포함한 392자 AI 설명을 Wanted에 저장했고, 수정 화면을 다시 열어 저장값을 확인했다. 서비스 URL도 저장 후 다시 열어 확인했다. 이미지는 0개이며, Chrome `setFiles` 대표 이미지 재시도는 file URL 접근 권한 문제로 `Not allowed`가 발생했다. 아직 최종 제출 완료 상태가 아니므로 투표·심사 대상이라고 말하지 않는다.

## 1. 대표 이미지

대표 이미지는 아래 파일을 사용한다.

```text
docs/submission/assets/2026-09-15/01-hero.png
```

이 이미지는 `https://ieojim.jungseongheon.org/`의 실제 공개 화면 캡처다. 생성형 이미지나 디자인 목업이 아니다.

## 2. 제목

> 이어짐 — 새 안내를 반영해도, 내 결정은 이어집니다

## 3. 해결하고자 한 문제

> 새 안내가 올 때마다 일정·비용·준비 목록을 다시 맞추며 확정한 결정과 완료 기록을 놓치는 문제를 해결합니다.

## 4. AI 활용 방식 및 결과

아래 본문은 artifact 기준 **392자**이며 폼의 500자 제한 이내다.

> 개발에는 Codex를 활용해 설계·구현·독립 리뷰·회귀 검증을 반복했습니다. 서비스의 Gemini는 새 안내문에서 변경 사실과 원문 근거를 구조화합니다. TypeScript 엔진은 근거·계산·기준 버전을 검증하고, 잠근 약속이나 완료한 준비 삭제처럼 보호 상태와 충돌하면 사용자 선택을 받습니다. 직접 쓴 메모와 준비 설정은 보존하고 확인이 필요한 부분을 표시합니다. 승인한 변경만 저장하며 이력 복원도 가능합니다. 별도의 합성 일정 체험에서는 발표 시간 변경이 준비·이동·다른 업무에 미치는 영향을 계산하고, 불가능한 조건은 승인을 차단합니다. 합성 체험과 실제 AI 호출을 구분해 제공합니다. 승인된 예시 일정 4건은 전용 Google Calendar에 실제 반영하고 재조회로 일치를 확인했습니다.

과장해서 쓰지 말아야 할 내용:

- 실제 사용자 3명 이상 테스트는 완료 사실로 쓰지 않는다.
- Google 기본 Calendar 변경, Gmail 권한 추가, Gmail 발송, 이메일 수신·열람 확인은 완료 사실로 쓰지 않는다.
- 합성 일정 체험은 실제 Gemini 호출과 구분해서 설명한다.
- 실제 Gemini smoke는 1회 성공했지만, 경쟁 서비스 대비 일반 정확도나 사용자 성과로 확장하지 않는다.
- Calendar 실증은 전용 Ieojim 보조 Calendar의 합성 개인 사본 4건에 한정한다.

## 5. 사용 AI 툴 및 기술 스택

체크박스 목록에서는 아래 두 개를 선택한다.

```text
React
Gemini
```

Codex는 개발 과정에서 사용했으므로 AI 활용 본문에 적는다. 제출 폼의 체크박스가 ChatGPT와 Codex를 구분하지 못하더라도, 실제 사용 근거 없이 ChatGPT, Claude, Cursor, GitHub Copilot, v0, Vercel, Supabase, OpenRouter, LangChain, Pinecone 등을 추가 선택하지 않는다.

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

개별 파일은 `docs/submission/assets/2026-09-15/` 아래에 있다. 모두 공개 배포 `db8aea67-3e79-48c6-9d3f-7bb6017f837c`에서 촬영한 1600×900 PNG다. 현재 런타임은 Calendar scope 수정 후 `57b36613-b7fd-4069-864d-f62444ed0232`로 올라갔지만, 제출 이미지는 기존 db8 공개 화면의 실제 캡처라는 provenance를 유지한다.

| 순서 | 업로드 파일 | 보여주는 가치 |
| --- | --- | --- |
| 1 | `01-hero.png` | 업무·학업·생활의 변경 안내와 보호할 결정을 한 화면에서 설명 |
| 2 | `02-recovery-chain.png` | 발표 변경이 준비·이동·경비 일정으로 이어지는 네 가지 재배치 |
| 3 | `03-recovery-blocked.png` | 조건을 만족할 수 없을 때 기존 일정을 보존하고 승인을 차단 |
| 4 | `04-coordination-review.png` | 원문 변경, 잠근 보고, 완료한 인쇄 확인을 사용자가 직접 검토 |
| 5 | `05-coordination-approved-plan.png` | 승인 후 저장된 계획과 보호된 준비 설정 |

대표 이미지는 1번을 사용하고, 스크린샷 영역에는 1~5번을 순서대로 올린다. 현재 원티드 임시저장에는 이미지가 0개다. 업로드가 계속 `Not allowed`로 막히면 Chrome 확장 프로그램의 file URL 접근 권한을 허용한 뒤 같은 파일로 다시 시도한다.

## 8. 심사위원에게 보여줄 3분 체험

1. `https://ieojim.jungseongheon.org` 첫 화면에서 범용 변경 안내 서비스를 확인한다.
2. `/recovery`로 들어가 발표 시간이 바뀌었을 때 준비, 이동, 경비 정리, 보호 일정이 어떻게 재배치되는지 본다.
3. `다음 목·금으로 새 체험`을 눌러 심사일 기준 미래 날짜 예시를 만든다. 이 버튼은 저장된 기존 작업 공간을 덮어쓰지 않는다.
4. 가능한 조건에서는 서버 복구안을 저장, 재계산, 승인, 새로고침 후 유지까지 확인한다.
5. 불가능한 조건에서는 승인을 차단하고, 어떤 조건이 막혔는지 표시되는지 확인한다.
6. 실제 원문 기반 workspace에서는 변경 검토 화면에서 잠근 약속과 완료한 준비 삭제가 사용자 선택을 요구하는지 확인한다.

Calendar 실증은 전용 Ieojim 보조 Calendar에서만 완료됐다. Chrome에서 Google 동의 후 `/recovery?calendar=connected`로 돌아왔고, 전용 Calendar bootstrap, 서버 승인, Calendar 등록 1회, provider 재조회가 성공했다. 검증 workspace `ws_abca3006940c453fa9bbbb3f18a863b8`, action `rec_act_eec51a41ddb94a40935afbb65098ba04`, verified mappings 4개가 근거다. 이 fixture와 합성 개인 사본 4개는 사용자 확인용으로 운영자 계정에 남겼다. Google 기본 Calendar 변경, Gmail 권한 추가, Gmail 발송은 수행하지 않았다.

## 9. 제출 버튼 전 확인

- Wanted 임시저장 상태가 아니라 제출 완료 상태인지 확인한다.
- 대표 이미지 1장과 스크린샷 5장이 모두 업로드됐는지 확인한다.
- 서비스 URL이 `https://ieojim.jungseongheon.org`인지 확인한다.
- 업로드 후 미리보기에서 16:9 비율, 글자 가독성, 잘림을 확인한다.
- 폼 마감은 사용자가 확인한 기준으로 2026-09-20이다. 마감 후 수정할 수 없으므로 제출 완료 화면을 보관한다.
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
- Google 설정: `artifacts/submission-release-2026-09-15/google-setup.json`, Calendar callback/API/scope 설정 완료, Calendar consent/write/readback 검증 완료, Gmail 미시도
