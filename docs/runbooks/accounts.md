# 계정 운영 가이드

2026-09-10 A1/A2 계정 운영 기록. 최종 실행 결과와 배포 여부는 `PLANS.md`를 기준으로 확인한다. 공개 본주소 `https://ieojim.jungseongheon.org`의 Google 로그인은 운영자 본인의 프로젝트 비소유 Google 계정으로 실제 왕복 검증을 통과했다. 한 Chrome 브라우저에서 세 번의 실제 OAuth 로그인을 수행했고, 로그아웃은 계정 세션을 지우고 게스트 UI로 돌아가는 것을 확인했다. 게스트 작업은 로그인만으로 자동 연결되지 않았고, `/settings`에서 명시 체크 후 1개 게스트 작업을 계정으로 옮겼으며, 로그아웃/재로그인 뒤에도 옮긴 작업이 계정에 남는 것을 확인했다. 검증용 작업 삭제 후 최종 집계는 인증 사용자 1명, 검증 사용자 1명, 활성 세션 0개, 남은 검증 fixture 0개다. 다른 브라우저의 실제 세션/해제 관리와 계정 전체 삭제/erasure는 아직 완료 증거가 없다.

## 동작과 경계

Google OAuth authorization code callback → Better Auth 1.7.3의 상태/PKCE 처리와 Google HTTPS token endpoint 응답 → D1 세션 → 검증된 사용자 ID → 앱 계정에 연결된 소유자 → 작업 공간 순서다. 브라우저가 보낸 이메일을 신원으로 사용하지 않는다. 자동 이메일 계정 연결, 비밀번호 로그인, 임의 callback URL은 제공하지 않는다. 합성 테스트의 unsigned ID token 경로는 제품 제어 흐름 검증이며 Google JWT 서명 검증 증거로 쓰지 않는다.

게스트 자료는 로그인만으로 옮겨지지 않는다. `/settings`에서 현재 계정과 목록을 확인하고 동의하면, 정확한 목록/내용·원문 버전을 D1 트랜잭션에서 다시 확인한다. 기존 owner를 계정에 연결하므로 원문·항목·이력·실행·비용 장부의 ID와 연결 관계가 유지된다. 성공 시 게스트 토큰을 교체하고 권한 버전을 올린다. 이전 게스트 요청이 이미 준비됐어도 실제 읽기/쓰기를 실행하는 DB 트랜잭션에서 거절된다. 같은 확인 요청의 재전송은 저장된 결과를 돌려준다. 목록이 바뀌면 다시 확인해야 한다.

요청 세션은 D1에서 매번 확인한다. 쿠키에 세션 내용을 캐시하지 않는다. 세션은 발급 후 7일로 고정하며 자동 연장하지 않는다. 로그아웃은 DB 세션 삭제를 확인한 후 성공 처리한다. 다른 기기 세션 정리는 현재 세션만 남긴다. 만료/취소된 계정 쿠키로 게스트 쓰기에 자동 전환하지 않는다. 계정 변경을 감지한 화면은 개인 데이터를 비우고 홈으로 이동한다.

계정 사용량 API가 실패하거나 응답 계약을 위반하면 프런트엔드는 이전 개인 사용량을 즉시 비우고 재시도 가능한 오류를 표시한다. 게스트 설정 화면은 `/api/account/usage`를 호출하지 않는다. 이 동작은 개인 데이터가 다른 신원 상태에 남는 것을 막기 위한 제품 경계다.

작업 공간 보관은 계정도 현재 **7일 미사용** 기준이다. 계정은 영구 보관 상품이 아니다. `/settings`는 인증된 사용자에게 실제 서버 사용량을 표시한다. 활성 작업 공간 10개와 일일 AI 실행 제한은 계정에 연결된 모든 기존 owner를 합산한다. 수동 삭제된 작업 공간의 당일 AI 실행 예약/사용량도 집계에 남아 삭제 후 재생성으로 한도를 우회하지 못하게 한다. 로그인/연결/로그아웃으로 비용 한도가 초기화되지 않는다. 이미 허용된 Queue 실행은 기존 소유 연결과 장부로 계속 완료할 수 있다. 사용량 리셋 시각은 UTC 기준으로 표시한다.

작업 공간의 변경 이력 탭에는 `현재 계획·원문 내려받기`가 있다. 내보내기는 게스트와 로그인 사용자 모두 현재 접근 권한이 있는 작업 공간에서 사용할 수 있다. 파일은 `ieojim.workspace` JSON v1이며 현재 작업 공간 메타데이터, 저장된 원문, 현재 스냅샷만 포함한다. 전체 변경 이력, 검토 중인 변경안, 가져오기 지원, 인증 정보, owner/account 식별자, 장부 데이터는 포함하지 않는다. 응답은 2MiB로 제한하고 작업 공간 ID와 `JSON.stringify(content), UTF-8` 기준 SHA-256 체크섬을 검증한 뒤에만 다운로드한다. 이 체크섬은 전자서명이나 변조 방지 증명이 아니며, 같은 파일을 다시 가져오는 복구 기능도 아직 없다.

## 공개 Google 설정 상태

공개 본주소는 별도 Google Cloud 프로젝트 `ieojim-auth-2026`과 웹 클라이언트 `IEOJIM public web`을 사용한다. authorized JavaScript origin은 `https://ieojim.jungseongheon.org` 하나다. 2026-09-15 기존 로그인 callback `https://ieojim.jungseongheon.org/api/auth/callback/google`을 보존하고 별도 Calendar callback `https://ieojim.jungseongheon.org/api/calendar/callback`을 추가·저장했다. 기존 workers.dev 주소는 게스트 연속성용으로 유지하며 로그인 주소로 사용하지 않는다.

Google Auth Platform audience는 External / Production이다. 일반 로그인은 `openid`, `email`, `profile`만 요청하며 incremental authorization은 끈다. 2026-09-15 Calendar API를 활성화하고 `calendar.app.created`, `calendar.freebusy` 두 범위를 Google Auth Platform에 추가·저장했다. 콘솔에서 두 범위는 민감하지 않은 범위로 표시됐다. Calendar는 사용자가 별도 연결을 시작할 때 요청한다. Gmail API/`gmail.send` 추가와 실제 발송은 수행하지 않았다. Google 브랜드 검증은 완료된 것으로 표현하지 않는다. 실제 동의 화면은 custom app name 대신 `jungseongheon.org`를 표시한다.

설정 저장과 실제 연결 성공은 구분한다. 2026-09-15 첫 Calendar 동의는 Google 오류 화면에서 멈췄고, 다음 시도는 앱의 `calendar=error`로 돌아왔다. identity scope 별칭 처리 문제를 새 통합 테스트로 재현하고 수정한 Worker `57b36613-b7fd-4069-864d-f62444ed0232` 배포 후 실제 Google 동의가 `calendar=connected`로 완료됐다. 이어짐 전용 보조 Calendar 생성, 합성 수습안 승인, 개인 이벤트 사본4건 반영 및 provider 재조회 일치까지 확인했다. 실제D1은 연결 `connected`, 실행 `verified`, 시도1회, event mapping4개다. 새 탭에서도 적용 확인 상태가 유지됐다. 증거: `artifacts/submission-release-2026-09-15/google-setup.json`, `calendar-live-verified.json`.

이 실제 검증용 작업과 전용 Calendar의 합성 이벤트4건은 운영자가 확인할 수 있도록 남겼다. 원래 기본 Calendar의 일정과 참석자를 변경하지 않았고 Gmail 권한/발송은 추가하지 않았다. 앱 작업 공간의7일 미사용 만료가 외부 Calendar 사본 자동 삭제를 뜻하지 않는다. 이 한 계정의 성공은 다른 브라우저/계정의 전체 OAuth 수명주기 검증을 대체하지 않는다.

원격에는 Google/Auth secret 3개와 기존 Gemini secret이 설정되어 있다. secret 값은 제한 권한의 비공개 파일과 Workers secret에만 두며 문서, 로그, 스크린샷, 대화에 노출하지 않는다. 로컬 `.dev.vars`에는 Google 활성화 값을 추가하지 않았다. artifact secret scan은 실제 secret/cookie 유출 없음을 확인했다.

로컬이나 새 환경을 활성화할 때는 `.dev.vars.example`의 네 값을 해당 환경의 비공개 변수/secret에 추가한다. 기존 Gemini 키/설정을 덮어쓰지 않는다.

| 값 | 의미 |
| --- | --- |
| `BETTER_AUTH_URL` | 브라우저가 실제 접속하는 출처. 공개 본주소는 `https://ieojim.jungseongheon.org`; 로컬 검증이 필요할 때만 `http://127.0.0.1:5173` |
| `BETTER_AUTH_SECRET` | 암호학적으로 안전하게 생성한 32자 이상의 서버 비밀값. 환경별로 분리 |
| `GOOGLE_CLIENT_ID` | 운영자가 소유한 Google 웹 애플리케이션 OAuth 클라이언트 ID |
| `GOOGLE_CLIENT_SECRET` | 해당 클라이언트의 비밀값 |

`BETTER_AUTH_URL`은 현재 staging의 `wrangler.jsonc` 공개 환경변수로 설정한다. 나머지 세 값은 secret이다. 인증이 활성화되면 비표준 출처를 거부하므로 workers.dev의 계정/API 동작을 보장하지 않는다. 현재 workers.dev는 `/api/account`에서 `authAvailable:false`를 반환하며 게스트 전용으로 유지한다.

네 값 중 하나라도 없으면 로그인 기능은 비활성화된다. 게스트 기능은 계속 사용할 수 있다. 원격 secret 설정은 환경을 명시한 Wrangler secret 입력 경로를 사용한다. 설정 완료 후 개발 서버 재시작/해당 환경 배포가 필요하다. 환경변수 존재만으로 실제 OAuth 성공을 주장하지 않는다.

새 환경에서 Google Auth Platform 웹 클라이언트를 만들 때는 실제 redirect URI를 정확히 등록한다:

- 로컬: `http://127.0.0.1:5173/api/auth/callback/google`
- 공개 본주소: `https://ieojim.jungseongheon.org/api/auth/callback/google`

일반 로그인은 기본 신원 범위 `openid`, `email`, `profile`을 요청한다. 동의 화면의 지원 연락처·도메인과 게시 상태를 운영자가 확인해야 한다. 심사 대상 사용자의 접근 가능 여부는 프로젝트 비소유 계정의 실제 로그인으로 확인한다. 별도 Calendar 연결을 활성화하는 환경은 해당 callback과 두 최소 범위도 등록한다. 공개 도메인/동의 화면 브랜드 검증이 필요하면 별도 출시 조건으로 처리한다.

근거: [Google 웹 서버 OAuth](https://developers.google.com/identity/protocols/oauth2/web-server), [Google OIDC](https://developers.google.com/identity/openid-connect/openid-connect), [Google 공개 준비](https://developers.google.com/identity/protocols/oauth2/production-readiness/overview), [Better Auth 옵션](https://better-auth.com/docs/reference/options).

## 스키마와 복구

- `0007_accounts.sql`: 앱 계정, 기본 소유자 연결, 기존 owner의 계정/권한 버전, 연결 요청 결과.
- `0008_authentication.sql`: 고정된 Better Auth 버전의 D1 테이블과 권한 확인용 CHECK 제약. 날짜는 라이브러리 어댑터와 일치하는 ISO TEXT.
- `0009_auth_admission.sql`: 인증 메타데이터 생성 한도와 일별 로그인 시작 횟수.

일반 로컬 DB는 먼저 SQLite backup API로 사본을 남기고 additive migration을 적용한다. 원격은 환경을 명시하고 적용 후 원래 작업/원문/이력/장부가 유지되는지 확인한다. 테스트는 별도 D1을 사용한다. DB 덤프에는 개인정보/인증 정보가 들어갈 수 있으므로 비공개 디렉터리와 제한된 권한으로 보관한다.

**롤백은 계정을 이해하는 Worker로만 한다.** 계정 연결 전에는 기존 데이터 모양이 유지되지만, 연결 후 구버전의 익명 전용 권한/owner 정리 코드는 새로운 FK와 정책을 이해하지 못한다. 이전 프런트엔드가 필요해도 계정 권한/정리 코드를 보존한 호환 빌드를 만든다. DB를 과거 시점으로 되돌려 취소된 세션이나 게스트 자격 증명을 복원하지 않는다. secret 교체는 암호화된 OAuth 토큰과 세션에 영향을 줄 수 있어 별도 복구 계획 없이 수행하지 않는다.

## 입장 제한과 관찰

초기 인증 정책: 사용자 200명, 전체 세션 2,000개, 사용자별 세션 20개, 진행 중 인증 상태 1,000개, 하루 로그인 시작 1,000회. 숫자는 파일 기반 초기 운영 정책이며 유료 상품 한도가 아니다. 실제 수요와 DB 지표 없이 자동으로 늘리지 않는다. 공개 쓰기와 OAuth GET callback은 IP 기반 입장 제한을 적용한다.

Google token endpoint 호출과 프로필 조회는 작업별 12초 응답 제한을 둔다. 제한 이후 도착한 결과로 계정/세션을 만들지 않는다. 라이브러리 provider API가 AbortSignal을 받지 않아 실제 상위 네트워크 요청 자체의 취소는 보장하지 않는다. `auth_provider_deadline`에는 고정 작업명과 제한 시간만 기록한다.

만료 세션/인증 상태는 주기 작업에서 삭제한다. 일별 인증 시작 집계는 31일 후 정리하며, 상태를 소비했다고 당일 횟수를 되돌리지 않는다. 인증 정리 실패는 AI 복구 작업을 중단시키지 않으며 오류는 내용 없이 기록한다. Workers observability 설정은 query string을 가려 OAuth code/state가 요청 로그에 남지 않도록 한다.

안전한 점검 예시:

```sql
SELECT COUNT(*) AS users FROM auth_user;
SELECT COUNT(*) AS sessions FROM auth_session;
SELECT COUNT(*) AS pending_states FROM auth_verification;
SELECT * FROM auth_policy;
SELECT day, login_attempts FROM auth_admission_days ORDER BY day DESC LIMIT 7;
SELECT COUNT(*) AS claims FROM account_claims;
```

이메일, 토큰, 인증 state의 value, 원문을 운영 로그에 출력하지 않는다. 자동 검사에서 보이는 합성 계정은 격리 D1에 직접 만든 시험 자격 증명이다. 제품에 시험 로그인 API는 없다.

## 실제 활성화 확인

완료된 실제 확인:

1. 운영자 본인의 프로젝트 비소유 Google 계정으로 로그인하고 `/settings`에 계정 이름/이메일, 현재 세션, 사용량 0이 표시되는 것을 확인했다.
2. 로그아웃 후 계정 세션이 0개가 되고 `/app`이 빈 게스트 UI로 돌아오는 것을 확인했다.
3. 같은 비소유 Google 계정으로 다시 로그인했을 때 게스트 작업이 자동으로 연결되지 않고, `/settings`에서 계정 작업 0개와 게스트 미리보기 1개가 분리되어 보이는 것을 확인했다.
4. 명시 체크 후 게스트 작업 1개를 계정으로 옮겼고, 계정 사용량 1개와 빈 게스트 미리보기를 확인했다.
5. 로그아웃 후 같은 Google 계정으로 새 로그인했을 때 계정 사용량 1개, 빈 게스트 미리보기, 옮긴 여행 작업의 일정·비용·체크리스트·메모가 다시 보이는 것을 확인했다.
6. 검증용 작업은 실제 UI의 변경 이력 삭제 흐름으로 삭제했고, `/app`이 0개 작업 상태로 돌아오는 것을 확인했다.

남은 확인:

1. 다른 브라우저에서 같은 Google 계정으로 로그인해 옮긴 작업을 읽고 변경한다.
2. 다른 기기 세션 정리 후 기존 기기 쓰기가 거절되는지, 현재 기기는 계속 작동하는지 확인한다.
3. 취소/만료된 OAuth 흐름이 제품 로그인 화면으로 돌아오는지 확인한다.

서버 응답 테스트와 합성 세션 브라우저 검사는 실제 Google 왕복을 대체하지 않는다. 현재 삭제 기능은 개별 작업 공간 삭제 기준이다. 장기 보관, 계정 전체 삭제/erasure, 결제와 장기 데이터 보존 정책은 별도 후속 단계다.
