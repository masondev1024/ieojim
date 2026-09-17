# 변경 복구 운영 런북 - 2026-09-15

이 문서는 `/recovery` 변경 복구 경험의 2026-09-15 공개 릴리스 운영 기준이다. 현재 공개 주소는 `https://ieojim.jungseongheon.org`, Cloudflare Worker 버전은 `57b36613-b7fd-4069-864d-f62444ed0232`다. 이 문서는 Gmail 발송 완료, Google 기본 Calendar 변경, 실제 사용자 3명 이상 검증 완료를 주장하지 않는다.

## 현재 상태

| 영역 | 현재 근거 | 운영 해석 |
| --- | --- | --- |
| 공개 배포 | `calendar-scope-deploy.log`, Worker version `57b36613-b7fd-4069-864d-f62444ed0232` | custom domain에 Calendar scope 수정 포함 최신 릴리스가 올라가 있다. 직전 제출용 화면 캡처 버전은 `db8aea67-3e79-48c6-9d3f-7bb6017f837c`, 그 이전 버전은 `a5e60901-2312-427a-961f-7d34784643bb`다. |
| DB migration | `migrations.log`, `postmigration-aggregates.json` | 원격 D1에 `0010_schedule_recovery.sql`, `0011_calendar_connections.sql`이 적용됐고 총 migration count는 11이다. |
| 기존 데이터 보존 | `postmigration-aggregates.json` | 기존 workspace 3개와 storage 25,014 bytes가 유지됐다. |
| 자동 검증 | `loop-verify-final.log`, `calendar-scope-verify.log` | 최초 제출 릴리스 `npm run verify` 93.354초 PASS, Calendar scope 수정 loop `npm run verify` 89.020초 PASS다. |
| Calendar scope 통합 테스트 | `calendar-scope-after.log` | Google identity scope alias 보정 통합 테스트 4/4 PASS다. |
| 독립 리뷰 | root handoff | Calendar scope 수정은 독립 리뷰 APPROVE로 전달됐다. |
| 브라우저 검증 | `local-browser.log`, `calendar-scope-domain.log` | 로컬 Chromium 97/97 PASS, Calendar scope 수정 후 공개 도메인 Chromium 27/27 PASS다. |
| 공개 recovery smoke | `public-recovery-smoke.json` | future date, 저장, 재계산, 승인, reload, cleanup, 외부 부작용 없음이 PASS다. |
| 실제 Gemini smoke | `live-ai.log` | 공개 staging에서 실제 Gemini 1회 호출이 성공했고 테스트 workspace cleanup이 기록됐다. |
| 실제 Calendar smoke | `calendar-live-verified.json`, `google-setup.json` | Chrome Google 동의, `/recovery?calendar=connected`, 전용 Ieojim Calendar bootstrap, Calendar action `verified`, event mappings 4개를 확인했다. |
| 제출 이미지 | `docs/submission/assets/2026-09-15/manifest.json` | `db8aea67-3e79-48c6-9d3f-7bb6017f837c` 공개 배포에서 1600×900 PNG 5장을 촬영했고 root 및 독립 UI 리뷰가 blocker 없음으로 확인했다. 현재 runtime은 `57b36613-b7fd-4069-864d-f62444ed0232`지만 이미지 provenance는 db8 캡처로 유지한다. |

## 제품 경계

`/recovery`는 발표 시간이 바뀌었을 때 준비, 이동, 경비 정리, 보호 일정이 어디까지 영향을 받는지 계산하는 합성 일정 체험이다. 최신 공개 버전은 `다음 목·금으로 새 체험` 버튼으로 심사 시점 이후의 미래 날짜 예시를 생성한다. 이전 2026-09-17/18 고정 예시는 남아 있을 수 있지만, 제출 시연의 기본 경로는 미래 날짜 체험이다.

이 체험은 새 원문을 Gemini가 다시 파싱하는 경로가 아니다. Gemini는 서비스의 실제 원문 변경 구조화 경로에서 사용하고, `/recovery`는 결정론적 TypeScript repair와 승인/저장/외부 실행 경계를 보여주는 대표 시연이다. 합성 체험과 실제 AI 호출을 문구에서 구분한다.

복구안은 workspace revision, source revision, condition revision, proposal ID에 묶여 승인된다. stale 승인, 시작 시간이 이미 지난 변경 구간, 불가능한 조건은 적용하지 않는다. 모델 실패나 합성 계산 실패는 기존 저장 상태를 덮어쓰지 않는다.

## Calendar/Gmail 경계

Calendar 설정과 실제 전용 Calendar write/readback은 현재 성공으로 기록한다. `google-setup.json` 기준 Google Cloud OAuth client에는 아래 redirect가 등록됐다.

```text
https://ieojim.jungseongheon.org/api/auth/callback/google
https://ieojim.jungseongheon.org/api/calendar/callback
```

Calendar API는 사용 설정됐고, 선언된 Calendar scope는 아래 두 개다.

```text
https://www.googleapis.com/auth/calendar.app.created
https://www.googleapis.com/auth/calendar.freebusy
```

`calendarConsentVerified=true`, `calendarWriteReadbackVerified=true`, `gmailScopeAdded=false`, `gmailSendAttempted=false`가 현재 증거다. 초기에는 `/recovery?calendar=error` 실패가 있었다. `email/profile` 대신 긴 `userinfo.email/profile` URL을 반환받을 때 거부하는 문제를 재현한 뒤 두 동등한 표기를 정규화했고, 실제 OAuth 왕복이 성공했다. 현재 성공 경로는 Chrome Google 동의 후 `/recovery?calendar=connected`로 돌아온 뒤 전용 Ieojim 보조 Calendar bootstrap, 서버 승인, Calendar 등록, provider 재조회까지 완료한 상태다.

검증 fixture는 workspace `ws_abca3006940c453fa9bbbb3f18a863b8`, action `rec_act_eec51a41ddb94a40935afbb65098ba04`다. Calendar 등록은 1회 실행됐고 action attempts는 1, 상태는 `verified`, verified event mappings는 4개다. 재조회한 payload hash와 etag가 로컬 mapping과 일치한다. 이 fixture와 전용 Ieojim 보조 Calendar의 합성 개인 사본 4개는 사용자 확인용으로 운영자 계정에 남겼다. 자동 cleanup했다고 쓰지 않는다.

Calendar 쓰기는 앱이 만든 보조 Calendar의 개인 이벤트 사본에만 반영한다. 주최자 이벤트, 타인의 일정, 참석자, organizer, 기본 Calendar 이벤트를 직접 수정하지 않는다. 이번 실증에서도 Google 기본 Calendar 변경은 하지 않았다. 기본 Calendar는 `freebusy`로 점유 여부만 확인하고, 앱 전용 Calendar는 저장된 mapping, etag, payload hash, provider readback이 모두 맞아야 `verified`로 처리한다.

이메일은 사용자가 수신자, 제목, 본문을 그대로 승인한 경우에만 action을 만들 수 있다. Gmail API가 발송 요청을 접수해도 상대방의 수신, 열람, 업무 완료를 증명하지 않는다.

## 실제 Calendar 증명 절차

전용 Calendar 외부 반영 완료를 말하려면 아래 증거가 모두 필요하다. 2026-09-15 실증에서는 이 조건을 충족했다.

1. 공개 origin과 Google OAuth callback이 `https://ieojim.jungseongheon.org` 기준으로 일치한다.
2. 공개 본주소에서 Google 로그인 세션이 살아 있다.
3. Calendar 연결이 `calendar.app.created`, `calendar.freebusy` scope로 완료된다.
4. 이어짐 전용 Calendar가 생성되거나, `bootstrap_uncertain` 상태에서는 marker가 일치하는 Calendar ID를 수동 확인해 adopt한다.
5. 미래 날짜 recovery workspace에서 서버 복구안을 승인한다.
6. Calendar action을 등록하고 Queue/cron 처리를 기다린다.
7. 기본 Calendar freebusy, 전용 Calendar 점유 목록, 기존 mapping의 etag/payload가 모두 확인된다.
8. provider readback이 승인 payload와 일치하고 로컬 `recovery_calendar_events` mapping이 같은 operation ID/payload hash를 가진다.
9. action 상태가 `verified`가 된다.

이 중 하나라도 빠지면 "외부 반영 완료" 대신 "연결 준비 중", "합성 일정 체험", "서버 승인까지 검증"으로 표현한다. 현재 완료 표현은 전용 Ieojim 보조 Calendar의 합성 개인 사본 4건에만 적용한다.

## 장애 대응 기준

| 상태 | 의미 | 운영 대응 |
| --- | --- | --- |
| `not_configured` | OAuth 환경값이 없다. | secret 이름 존재와 `BETTER_AUTH_URL`을 확인한다. 값을 출력하지 않는다. |
| `not_connected` | Calendar 권한이 연결되지 않았다. | 같은 Google 로그인 계정으로 연결을 다시 시작한다. |
| `calendar_missing` | 권한은 있지만 앱 전용 Calendar ID가 없다. | bootstrap을 실행한다. |
| `bootstrap_uncertain` | Calendar 생성 결과를 확정하지 못했다. | Google Calendar에서 marker가 있는 Calendar를 찾아 adopt하거나 연결을 해제한다. |
| `needs_reauth` | token이 없거나 refresh가 실패했다. | Calendar 권한을 다시 연결한다. |
| `queued`/`executing` | outbox 처리 중이다. | 중복 실행을 만들지 않고 상태를 polling한다. |
| `verified` | provider readback과 승인 payload가 일치한다. | Calendar 외부 반영 완료로 말할 수 있는 유일한 성공 상태다. |
| `accepted` | Gmail이 발송 요청을 접수했다. | 수신·열람 성공으로 말하지 않는다. |
| `uncertain` | provider 결과를 모른다. | 자동 재시도하지 않고 provider 상태와 payload hash를 수동 대조한다. |
| `conflict` | 시간 점유, etag/readback/revision 충돌, 시작 시각 경과 등으로 적용할 수 없다. | 최신 상태를 다시 불러와 새 승인부터 진행한다. |
| `cancelled` | 연결 해제, 재인증 필요, 실행 상태 변경으로 중단됐다. | 현재 연결과 action 상태를 확인한다. |

Calendar update에서 provider가 stale/412 계열을 반환하면 충돌로 처리한다. 기존 event를 blind overwrite하지 않는다. 뒤쪽 쓰기가 실패해도 앞서 readback된 mapping은 보존하고, 최종 상태는 failed, cancelled, conflict, uncertain 중 실제 원인에 맞춘다.

## 제출 운영 기준

Wanted 제출 상태는 현재 임시저장이다. 제목, 문제, React/Gemini 선택은 저장됐고 서비스 URL도 저장 후 다시 열어 확인했다. 실제 Calendar 검증 결과를 포함한 392자 AI 설명을 Wanted에 저장했고, 수정 화면을 다시 열어 저장값을 확인했다. 이미지는 0개이며 대표 이미지 업로드는 Chrome file URL 접근 권한 문제로 `Not allowed`가 발생했다. 최종 제출 완료 상태가 될 때까지 심사 대상이라고 말하지 않는다.

제출 이미지와 ZIP은 아래 경로가 기준이다.

```text
docs/submission/assets/2026-09-15/
docs/submission/ieojim-submission-images.zip
```

이미지 순서는 `01-hero.png`, `02-recovery-chain.png`, `03-recovery-blocked.png`, `04-coordination-review.png`, `05-coordination-approved-plan.png`다.

## 중단 조건

다음 중 하나라도 해당하면 완료 표현을 낮춘다.

- Wanted 폼이 임시저장 상태이고 제출 완료 화면이 없다.
- 대표 이미지 또는 스크린샷 5장이 업로드되지 않았다.
- Calendar 완료 범위를 Google 기본 Calendar 변경이나 타인 일정 수정까지 확장해 표현하려 한다.
- Calendar action이 `verified`가 아닌 새 계정·새 workspace 결과를 완료라고 말하려 한다.
- Gmail scope를 추가하지 않았거나 Gmail send를 시도하지 않았다.
- Gmail action이 `accepted`여도 수신·열람을 증명하려 한다.
- provider 결과가 unknown, invalid response, timeout, stale, conflict다.
- 실제 Google Calendar 화면만 보고 DB readback/mapping 없이 성공이라고 말하려 한다.

## 검증 근거

- `artifacts/submission-release-2026-09-15/calendar-scope-deploy.log`
- `artifacts/submission-release-2026-09-15/migrations.log`
- `artifacts/submission-release-2026-09-15/postmigration-aggregates.json`
- `artifacts/submission-release-2026-09-15/loop-verify-final.log`
- `artifacts/submission-release-2026-09-15/calendar-scope-verify.log`
- `artifacts/submission-release-2026-09-15/calendar-scope-after.log`
- `artifacts/submission-release-2026-09-15/local-browser.log`
- `artifacts/submission-release-2026-09-15/calendar-scope-domain.log`
- `artifacts/submission-release-2026-09-15/public-recovery-smoke.json`
- `artifacts/submission-release-2026-09-15/live-ai.log`
- `artifacts/submission-release-2026-09-15/calendar-live-verified.json`
- `artifacts/submission-release-2026-09-15/google-setup.json`
- `docs/submission/assets/2026-09-15/manifest.json`
