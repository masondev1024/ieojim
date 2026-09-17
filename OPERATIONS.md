# 이어짐 운영 메모

이 문서는 로컬 구현과 공개 배포 준비를 잇는 실행 지침이다. 실제 Cloudflare 리소스 생성, 배포, 실제 모델 호출 결과는 별도 증거가 있어야 완료로 기록한다. 현재 확인 상태는 `PLANS.md`를 따른다.

현재 서비스 본주소는 **https://ieojim.jungseongheon.org**이며 `/ieojim` 바로가기, 기존 포트폴리오·게스트 보존과 복구 절차는 [도메인 운영 가이드](docs/runbooks/custom-domain.md)에 있다. 같은 staging Worker·D1·Queue를 사용한다. 공개 본주소에는 Google/Auth Secret과 Gemini Secret이 설정되어 있고, 기존 workers.dev 주소는 게스트 전용으로 유지한다.

## 데이터 흐름과 신뢰 경계

브라우저는 원문과 목적을 API에 보낸다. API가 원문을 보관하고 실행을 기록한 뒤 Queue에 실행 ID를 보낸다. Worker가 D1에서 `pending` 실행을 한 번만 `running`으로 선점하고 모델에 구조화된 제안을 요청한다. 모델은 데이터와 제안만 반환한다. 실행 가능한 코드·SQL·도구 명령은 제품 계약에 없다.

Core는 원문 인용 위치, 기존 ID, 참조한 사실, 계산과 사용자 상태를 검증한다. 사용자는 변경·보존·확인 필요 항목과 근거를 검토한다. 적용은 제안의 내용 버전과 자료 목록 버전이 모두 일치할 때 전체 묶음으로 이루어진다. 브라우저를 두 개 열었거나 모델 실행 중 내용을 편집했다면 오래된 제안을 적용하지 않는다.

자료는 불변이며 정정·대체 대상은 명시적이다. 이후에 도착했다는 이유만으로 기존 사실의 권한을 덮어쓰지 않는다. 이력 복원은 내용의 새 버전을 만들며 원문 목록, 소유자, 비용 기록, 만료 상태를 과거로 되돌리지 않는다.

## 로컬 시작과 검증

Node.js 24 이상에서 프로젝트 루트에서 실행한다.

```sh
npm ci
npm run build
npm run db:local
npm run dev
```

화면은 `http://127.0.0.1:5173`, API는 `http://127.0.0.1:8787`이다. D1 로컬 상태는 무시된 `.wrangler/`에 저장된다. `db:local`은 로컬 DB만 대상으로 한다. 개발 서버를 종료해도 저장 상태는 남는다.

2026-09-09 로컬 DB에 마이그레이션 0001~0005를 적용했다. 0004는 전역 유입·저장 제한과 집계, 0005는 질문 답변의 출처 문맥을 추가한다. 기존 작업 공간 1개·원문 3개·스냅샷 4개·비용 기록 3개의 행 수가 유지됐고 저장량 재집계 차이는 0이었다. 기존 설치에서 새 코드를 실행하기 전에 `npm run db:local`을 실행한다.

```sh
npm run verify
npx playwright install chromium
npm run test:e2e
npm run eval:live -- --dry-run
npm run deploy:check
```

`verify`는 타입·린트·코어 단위 테스트·Workers/D1 통합 테스트·프런트 빌드를 실행한다. 브라우저 검증과 실제 모델 평가는 별도 단계다. 배포 dry-run은 번들 구성 확인이며 원격 배포 성공이나 실제 운영 검증을 의미하지 않는다.

`test:e2e`는 전용 실행기 `scripts/dev-e2e.ts`로 5174/8788 서버와 격리된 D1을 준비한다. 일반 개발 서버를 재사용하지 않고, 별도 config 옆의 빈 키 파일과 자식 프로세스 환경 정리로 실제 키가 테스트에 전달되지 않게 한다. 일반 개발용 5173/8787 및 `.wrangler/state` 데이터는 그대로 사용할 수 있다. 근거: [Cloudflare 로컬 환경변수](https://developers.cloudflare.com/workers/configuration/environment-variables/), [로컬 상태 격리](https://developers.cloudflare.com/workers/local-development/local-data/).

## 모델 연결과 평가

`.dev.vars.example`을 참고해 `.dev.vars`의 `GEMINI_API_KEY`를 로컬에서 설정한 뒤 개발 서버를 재시작하고 화면을 새로고침한다. `.dev.vars`는 소유자만 읽고 쓸 수 있는 권한(0600)이며 Git에서 제외한다. 키를 문서나 대화에 붙여 넣지 않는다. `/api/config`의 `liveAvailable`은 서버가 키를 읽었다는 뜻이며, 인증·크레딧·실제 생성 성공을 검증한 값은 아니다. 키가 없거나 서비스 예산이 부족하면 재시도 실행을 만들지 않아 한 번의 복구 기회를 소모하지 않는다.

2026-09-09 Gemini 키의 인증된 모델 조회와 실제 구조화 생성은 HTTP 200이었다. 여행 인원/도착 변경 평가도 통과했다. 최신 사례별 결과는 `PLANS.md`와 `QA_REPORT.md`를 따른다. 9월 8일 OpenAI 평가 실패와 $0.089536 예약액은 과거 증거이며 Gemini 사용량과 합쳐 확정 청구액으로 해석하지 않는다.

모델 설정은 `wrangler.jsonc`의 `MODEL`, 비용 계약은 `src/core/model-policy.ts`다. 현재 `gemini-3.8-flash`만 허용하며 다른 모델은 `UNSUPPORTED_MODEL`로 실패한다. 2026-12-31까지 Standard 가격은 입력 100만 토큰당 $0.75, 출력·thinking 100만 토큰당 $3.75다. 가격 만료인 2027-01-01 UTC부터 호출 전에 `MODEL_PRICING_EXPIRED`로 차단하므로 공식 가격을 확인하고 정책과 테스트를 함께 갱신한다. [Gemini 가격](https://ai.google.dev/gemini-api/docs/pricing), [모델 계약](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash).

입력 12,000·응답 출력 4,096 토큰 기준으로 실행당 **24,360 microUSD = $0.024360**을 예약한다. native `generateContent` HTTP 호출은 리다이렉트를 자동으로 따르지 않고 3xx도 실패로 처리한다. 실제 설치된 Workerd의 `Request` 파서로 검증했다. 호출은 60초 제한, 자동 재시도 없음, `store:false`, `thinkingLevel:low`를 사용한다. `store:false`는 요청 저장 옵션이며 공급자의 모든 보관 정책을 없애는 보증은 아니다. 복잡한 스키마의 배열 크기 제한은 실제 요청에서 400을 일으켜 공급자 스키마에서 제외했다. 반환값에는 원래 Zod의 길이·개수·패턴·필수값 검증과 엔진의 근거/상태 보호를 그대로 적용한다. [REST 계약](https://ai.google.dev/api/generate-content).

예약 한도는 **호출 허용 한도이며 공급자 청구의 강제 상한이 아니다.** Gemini 3.8에서 `maxOutputTokens`가 thinking을 포함한 모든 과금 토큰을 제한한다는 명시적 근거는 확보하지 못했다. 사용량이 일관되면 `totalTokenCount - promptTokenCount`를 과금 출력으로 계산해 숨겨진 thinking도 포함한다. 사용량이 없거나 모순되면 예약액을 유지한다. 사용량이 확인된 호출은 출력 검증 실패나 오래된 제안 폐기에서도 비용을 남긴다.

측정 비용이 예약액보다 크면 D1에 실제 비용과 `policy_violation`을 한 번씩 기록하고 해당 제안은 게시하지 않는다. 이후 새 호출과 대기 중 호출도 수동 정책 검토 전까지 차단한다. 이미 공급자에게 전달된 동시 호출을 취소하거나 청구를 되돌리는 장치는 아니다. 구 모델의 낮은 예약액으로 대기하던 실행은 `MODEL_RESERVATION_MISMATCH`로 호출 전에 실패한다.

입력 검사는 실제 메시지와 출력 스키마의 UTF-8 바이트 상한에 프레이밍 여유를 더한다. 비용을 과소 추정하지 않는 대신 긴 한글 자료는 저장 한도인 6,000자 이내여도 현재 작업 내용과 합쳤을 때 모델 한도에 걸릴 수 있다. 이는 토크나이저 기반 정밀 계산을 추가하기 전의 의도적으로 보수적인 제한이다.

로컬 기본값과 미배포 production 템플릿은 UTC 하루 $0.50 / 누적 $15이다. 공개 서비스를 운영하는 staging의 2026-09-12 공개 배포 설정은 `DAILY_BUDGET_MICRO_USD=2500000`, `TOTAL_BUDGET_MICRO_USD=15000000`, `OWNER_DAILY_RUNS=10`이다. 이는 UTC 하루 $2.50 / 누적 $15 / 소유자별 하루 10회다. 적용된 공개 버전은 `PLANS.md`의 배포 체크포인트로 확인한다. 후불 공급자 계정의 한도와 별개로 앱의 예약 제한은 유지한다. 전체 $30 중 모델 $15 배분 안에서 조정하며 CLI 평가 비용도 별도로 합산한다. 예약과 토큰 기준 측정 비용을 구분하고, 불확실한 호출 비용을 0으로 보거나 예약을 환급하지 않는다.

2026-09-12 07:32:56 UTC의 읽기 전용 집계에서 오늘 예약은 0, 누적 예약은 97,440 microUSD였다. 회당 예약 24,360 microUSD 기준 기존 $0.25/$1 설정은 오늘 최대 10회·누적 잔여 37회였고, 준비된 $2.50/$15 설정은 오늘 최대 102회·누적 잔여 611회다. 이는 해당 시점의 전역 예산 산술이며 사용자 한도, 동시 요청, 정책 차단, 저장량, 제공자 장애를 통과한 실제 서비스 보장 횟수가 아니다.

```sh
npm run ops:capacity -- --target staging --usage-file artifacts/finals-delivery-2026-09-12/ops-before.json
```

이 명령은 **로컬 설정 + 저장된 원격 집계**를 읽는다. 배포된 변수나 실시간 잔액을 확인하는 명령이 아니다. 새 집계는 `scripts/ops-status.sql`의 SELECT만 `wrangler d1 execute DB --env staging --remote --command=<SQL> --json`으로 실행한다. 이 Wrangler 버전의 `--file --json` 결과는 SELECT 행 대신 import summary일 수 있어 용량 계산 입력으로 사용하지 않는다. 원문·계정 식별자·비밀 키를 조회하거나 비용 장부를 초기화하지 않는다.

키를 설정한 뒤 사람이 실제 평가를 실행할 때:

```sh
npm run eval:live -- --dry-run
npm run eval:live -- --case travel-participants-arrival --strategy incremental --max-usd 0.10
```

실행기는 네 가지 합성 사례를 두 전략에 동일하게 제공한다. 부분 변경 전략과 전체 재생성 전략 모두 동일 모델·현재 상태·자료·보호 규칙·검증기를 받는다. 전체 8회 호출은 $0.194880을 예약하며 `--max-usd 0.20`을 명시해야 실행된다. 기본 $0.10으로 전체를 요청하면 유료 호출 전에 거절한다. `--case`와 `--strategy`로 필요한 사례만 선택할 수 있다. CLI 평가 예산은 서비스 D1 장부와 별개이므로 평가를 실행했다고 서비스 예산 행이 생기지 않는다. 그래도 반복 실행 비용은 전체 프로젝트 예산에 포함해 관리한다. 자동 반복 실행하지 않는다.

결과에는 `plannedCalls`, `attemptedCalls`, `stoppedReason`과 안전한 오류 분류·HTTP 상태만 기록한다. 인증(401), 권한(403), 크레딧/요청 한도(429), 요청 계약(400), 모델 접근(404), 연결 불확실 오류는 나머지 평가를 중단한다. 원문 응답과 SDK 오류 메시지는 저장하지 않는다. 실패 호출의 예약액은 유지하므로 실제 청구는 공급자 사용량과 별도로 대조한다. 중단 원인을 해결하고 새 실행의 비용 범위를 확인한 뒤 수동 재실행한다. 모델 출력 검증 실패는 사례별 실패로 기록하며 다음 사례를 평가할 수 있다.

CLI에서도 예약액을 넘는 사용량은 `artifacts/model-budget-block.json`에 기록하고 이후 유료 실행을 차단한다. 재개 전에 결과와 공식 가격·토큰 정책을 대조하고 필요한 코드/예약 변경을 검증한다. 이 파일만 지우고 반복 실행하지 않는다. 서비스 D1 차단의 해제도 승인된 운영 변경으로 처리하며 실제 비용·예약 장부를 삭제하지 않는다.

결과는 무시된 `artifacts/eval-*.json`에 저장한다. 성공 여부뿐 아니라 사실·파생값 검사, 보호 상태 손실, 불필요한 수정, 확인 질문, 충돌 대상, 지연과 비용을 구분한다. 원문이나 모델 원문 응답은 보고서에 저장하지 않는다. 이 소규모 고정 사례 점수는 일반 의미 정확도나 경쟁 서비스 대비 우위의 증명이 아니다.

## Google 로그인 운영

공개 본주소의 Google 로그인은 별도 Google Cloud 프로젝트 `ieojim-auth-2026`과 웹 클라이언트 `IEOJIM public web`으로 활성화했다. authorized origin은 `https://ieojim.jungseongheon.org` 하나이고 callback은 `https://ieojim.jungseongheon.org/api/auth/callback/google` 하나다. scope는 `openid`, `email`, `profile`뿐이며 incremental authorization은 끈다. Google Auth Platform audience는 External / Production이고 Verification Center에는 review가 필요한 sensitive/restricted scope가 없다. Google 브랜드 검증은 완료 상태로 표현하지 않는다. 실제 동의 화면은 `jungseongheon.org`를 표시한다.

인증 callback은 Google authorization code를 받아 Better Auth가 Google HTTPS token endpoint와 프로필 응답을 처리한 뒤 D1 세션을 만든다. 브라우저가 보낸 이메일을 신원 근거로 쓰지 않는다. 합성 unsigned ID token 테스트는 제품 제어 흐름 검증이며 Google JWT 서명 검증 증거가 아니다.

실제 Chrome에서 프로젝트 비소유 Google 계정 로그인, `/settings`의 계정/현재 세션/사용량 표시, 로그아웃 후 빈 게스트 UI 복귀와 원격 D1 active session 0 집계를 확인했다. 같은 계정 재로그인 후 게스트 작업은 자동 연결되지 않았고, 명시 체크 후 1개 게스트 작업을 계정으로 옮기는 흐름을 확인했다. 다시 로그아웃하고 새 로그인한 뒤 옮긴 작업의 일정·비용·체크리스트·메모가 유지되는 것도 확인했다. 검증용 작업은 실제 UI 삭제 흐름으로 정리했다. 최종 집계는 인증 사용자 1명, 검증 사용자 1명, 활성 세션 0개, 남은 검증 fixture 0개다. 이 증거는 한 Chrome 브라우저의 세 번의 실제 OAuth 로그인이다. 다른 브라우저 세션/해제 관리는 아직 별도 확인 대상이다. 계정 전체 삭제/erasure는 구현되지 않았다.

로그와 문서에는 OAuth code/state, 이메일, 토큰, secret 값을 남기지 않는다. secret 원본 파일은 제한된 권한의 비공개 위치에서 관리하며 공개 문서에 경로나 값을 링크하지 않는다. Artifact secret scan은 실제 secret/cookie 유출 없음을 확인했다. Google/Auth secret 교체는 기존 세션과 암호화된 provider 토큰에 영향을 줄 수 있으므로, 교체 전 현재 활성 세션 수와 재로그인 경로를 확인한다.

## 공개 유입과 저장 계약

일반 목록·설정 조회는 새 익명 소유자를 만들지 않는다. 첫 작업 공간 생성 성공과 소유자 저장이 같은 D1 batch로 처리되며 실패한 요청은 쿠키나 빈 소유자 행을 남기지 않는다. 기존 소유자의 활동 기록은 시간당 한 번으로 제한한다.

| 보호 항목 | 초기 한도 | 강제 위치 |
| --- | --- | --- |
| 같은 IP의 쓰기 유입 | 60초당 60회 | staging/production Rate Limiting binding, 최선형 유입 방어 |
| 전체 활성 작업 공간 | 200개 | D1 트리거, 원자적 검사 |
| 하루 공간 생성 / 명령 저장 | UTC 100회 / 2,000회 | D1 일일 누적, 삭제해도 당일 횟수 유지 |
| 공간별 내용 이력 / 명령 응답 | 201개 / 300개 | D1 트리거, 초과 쓰기 전체 롤백 |
| 전체 저장 내용 | 50 MiB | UTF-8 내용 증가량을 D1 트리거로 집계 |

저장량은 제목·목적·원문·답변 문맥·제안·스냅샷·재전송용 응답의 논리 바이트다. SQLite 페이지·인덱스·비용 장부 등 실제 DB 전체 크기와 다르며 클라우드 청구 상한이 아니다. 원문 추가가 실패하면 실행/예산 예약/명령 응답도 함께 롤백된다. 삭제는 내용 용량을 반환하지만 비용 장부는 유지한다. `storage_policy`와 `storage_usage`는 필수 운영 행이며 삭제하거나 한도를 우회하는 방식으로 초기화하지 않는다.

배포 환경이 불명확하거나 공개 쓰기 limiter/IP 정보가 없으면 503으로 닫는다. 로컬 예외는 development/test 환경의 loopback 또는 테스트 호스트에만 해당한다. API 및 정적 자산 응답에는 CSP·프레임 금지·MIME 추측 금지·referrer 제한을 적용한다. 자산 헤더는 `public/_headers`에서 관리하므로 Vite 개발 응답만으로 공개 CSP를 검증하지 않는다.

## 질문 답변과 AI 검증 경계

`추가 정보로 답변`은 답변을 새 불변 원문으로 저장한다. 클라이언트는 대상 제안/기준 버전만 보내고 서버가 기존 질문을 붙여 출처 문맥을 만든다. 답변 저장, 기존 제안 대체, 새 실행 예약은 같은 트랜잭션에 속한다. 오래된 질문에 대한 답변은 409, 저장 실패는 기존 질문을 유지한다. 같은 텍스트라도 다른 질문의 답변이면 다른 관측으로 취급한다. AI는 질문 메타데이터가 아닌 실제 답변 원문을 인용해야 한다.

숫자 검증은 숫자 또는 숫자 문자열과 인용의 단일 명시 숫자를 대조한다. 여러 숫자·범위·일부 부정/계산 표현은 모호함으로 거절한다. 일반 문장의 의미·단위·시간대 전체를 검증하는 장치는 아니다. 정정/대체 대상의 기존 사실과 정규화된 이름이 겹치는데 새 key를 만들면 거절한다. 다른 표현으로 우회하는 모든 의미적 중복까지 해결한 것은 아니다.

라이브 원문 추가와 재시도는 전체 모델 입력 크기를 비용 예약 전에 검사한다. 자료 6,000자/누적 24,000자는 저장 계약이며 모델 처리 용량과 다르다. 실패하면 원문을 줄이거나 공간을 나눠야 한다. 역사 전체를 보내는 현재 구조는 유지하며 필요한 근거만 보내는 입력 축소는 다음 단계다.

평가 CLI는 호출 완료와 품질 통과를 구분한다. 구조적으로 유효해도 기대값이 틀리거나 보호 상태가 손실되면 종료 코드 1이다. 질문이 필요한 사례는 명시적인 expectedOutcome으로 평가한다. 예전 실제 모델 평가를 새 숫자/질문 계약의 검증으로 재사용하지 않는다.

## 실패와 복구

만료의 활동 기준은 선택한 작업 공간의 성공한 소유자 조회와 내용/자료 변경이다. 처리 중 선택한 공간을 자동 조회하는 것도 활동으로 간주한다. 목록 조회는 다른 공간의 만료 시각을 연장하지 않는다. 만료된 공간은 조회 전에 제거하므로 조회가 과거 내용을 부활시키지 않는다. 모델 완료나 예약 작업은 만료를 연장하지 않는다.

| 증상 | 확인과 조치 |
| --- | --- |
| 자료는 저장됐지만 AI 실행 불가 | `/api/config`의 `liveAvailable`, 로컬 키 설정을 확인한다. 기존 자료와 작업 내용을 유지한다. |
| `MODEL_BUDGET_POLICY_VIOLATION` | 비용 정책과 공급자 사용량을 점검한다. 자동 재시도나 장부 초기화로 우회하지 않는다. 앱과 CLI 차단은 별개다. |
| `pending`이 오래 유지됨 | Queue 연결과 5분 주기 복구 작업을 확인한다. DB에 기록된 실행 ID를 재전달하며 새 모델 실행 레코드를 임의로 만들지 않는다. 재전달된 메시지는 DB 선점 조건 때문에 이미 처리 중이거나 완료된 실행을 다시 호출하지 않는다. |
| `running`이 끝나지 않음 | 제한 시간 후 `uncertain` 전환 여부를 확인한다. 공급자 요청 결과를 모르면 자동으로 재호출하지 않는다. |
| 실패/불확실 실행을 다시 시도 | 사용자가 명시적으로 재시도할 때만 별도 실행과 별도 비용 예약을 만든다. 같은 원본 실행의 명시적 재시도는 한 번만 허용된다. |
| 적용 시 409 | 현재 작업공간을 다시 읽는다. 오래된 제안을 강제로 적용하거나 버전 검사를 제거하지 않는다. |
| 자료 충돌 또는 잠긴 결정 충돌 | 근거와 기존 결정을 비교하고 명시적으로 선택한다. 해결하지 않은 묶음은 적용하지 않는다. |
| 잘못 적용한 내용을 복원 | 이력에서 이전 내용을 선택한다. 복원도 새 버전이며 이후 원문과 비용 기록은 유지한다. |
| 삭제/만료 | 원문·내용·제안·실행·재생 가능한 명령 응답 사본까지 제거됐는지 검증한다. 집계용 비용 기록은 삭제로 예산을 초기화하지 않도록 유지한다. 비용 장부에 원문이나 모델 원문 응답을 넣지 않는다. |

## 실행 계약 추적

마이그레이션 `0006_run_provenance.sql`부터 서비스의 live Queue 실행은 유료 호출 직전에 `runs.provenance_json`을 기록한다. 실제 전송 body, instruction, 로컬 출력 schema, generation config, 가격 정책의 SHA-256과 모델·전략·입력 크기를 저장한다. 키와 원문 응답을 저장하지 않으며 공개 API와 로그에도 이 metadata를 노출하지 않는다. 기존 실행과 fixture의 null 값은 추적 정보가 없다는 뜻이다.

신규 live 출력은 `schemaVersion:2`로 생성/수정 대상, 단위와 시간 정보를 명시한다. 표시값은 기존 scalar 형식을 유지한다. 날짜의 연도·시간대는 근거와 표시값 양쪽에 명시된 경우에만 허용한다. 기존 fact의 의미 정보를 일괄 backfill하지 않는다. typed/legacy 계산이 섞이면 기존 fact 자체의 명확한 숫자·단위 근거로 계산 검증 중에만 부족한 의미를 확인할 수 있고, 근거가 모호하면 거절한다.

추적 metadata에는 출력 계약 버전, 요청/실효 context 방식, context hash와 byte 수가 포함된다. 서비스는 full context를 사용한다. 평가 전용 compact 방식은 복원 가능한 인용문 중복만 줄이며, 비교 평가의 실패 때문에 기본값으로 승격하지 않았다. 검증 가능한 출력 오류는 `failed`로 기록하고, 실제 호출 결과를 알 수 없는 전송 오류는 `uncertain`으로 구분한다. 둘 다 기존 작업 내용을 보존하며 자동 유료 재호출을 하지 않는다.

기록은 현재 소유자·공간·기준 revision이 맞는 만료되지 않은 running/live 실행에 한 번만 허용된다. D1 기록이 실패하면 `MODEL_PROVENANCE_UNAVAILABLE`로 모델 호출 전에 중단한다. 해당 오류는 실제 모델 호출 성공이나 청구의 증거가 아니다. 마이그레이션 적용 여부와 DB 상태, 실행의 기준 revision을 확인한 뒤 기존의 명시적 재시도 절차를 따른다. 저장 기록을 지워 자동 재호출을 유도하지 않는다.

fingerprint는 입력·계약을 비교하는 단서이며 동일 모델 응답의 재현을 보장하지 않는다. 호출 전에 기록되므로 기록의 존재만으로 외부 호출이 발생했다고 단정할 수도 없다. snapshot 복원은 metadata를 바꾸지 않고, 공간 삭제/만료는 run과 함께 metadata를 삭제한다. 실제 비용 장부의 보존 정책은 별개다. 이 고정 상한 metadata는 기존 `storageContentBytes` 논리적 본문 집계에 포함되지 않으며 물리적 D1 사용량과 구분한다.

## 운영 상태 조회

Worker는 원문 대신 구조화된 JSON 이벤트를 남긴다. `run_lifecycle`의 `outcome`은 선점(`claimed`), 제안 게시(`published`), 실행 중 기준 변경으로 폐기(`discarded`), 늦은 완료 무시(`ignored`), 호출 전 실패(`failed`), 결과 불확실(`uncertain`), 중복 전달 건너뜀(`skipped`)을 구분한다. `published`는 D1에 검토 제안을 저장했다는 뜻이며 사용자가 작업 내용에 승인·반영했다는 뜻은 아니다. `durationMs`는 실행 생성부터 해당 이벤트까지의 경과 시간으로, 순수 모델 응답 지연과 구분한다.

비용 이벤트는 예약액 `reservedMicroUsd`와 관측 비용 `actualMicroUsd`를 나누며, 모델 응답의 토큰 수가 있으면 `costSource=usage_reported`, 없으면 `reserve_fallback`으로 표시한다. 출력 검증 실패나 오래된 제안 폐기에도 확인된 비용·토큰은 로그와 장부에 유지한다. 비용이 확인되지 않은 폐기/무시 결과에서는 `actualMicroUsd`가 null일 수 있다. `runId`, `workspaceId`, `changesetId`로 경로를 연결할 수 있지만 원문, 목적, 인증 쿠키, API 키, 모델 원문 응답은 남기지 않는다. 운영 로그 접근 권한과 보관 기간은 앱 데이터와 별도로 관리한다.

`cron_recovery`는 실행 시간, 타임아웃 처리 수, 실제 삭제한 공간 수, 이번 최대 25개 복구 후보와 전송 성공/실패 수를 기록한다. `outcome=completed`, `partial_redispatch_failure`, `failed`를 구분하고 DB 단계 실패는 `failedStage`와 안전한 오류 종류를 기록한 뒤 다시 예외를 발생시킨다. 로그가 있다는 이유만으로 알림 전달이 검증된 것은 아니다.

```sh
npm run ops:local
```

`scripts/ops-status.sql`은 원문·제목·소유자 식별자 없이 집계만 읽는다. 저장 내용 바이트/상한/재집계 차이와 일일 생성·명령 횟수도 포함한다. 활성/삭제 대기 공간, 실행 상태별 가장 오래된 작업의 나이, 최근 24시간 상태별 건수, 누적/오늘 예약액과 별도 기록 비용, 비용 관측이 없는 예약을 확인한다. 비용 집계의 `model_budget_policy_violations`와 `live_calls_blocked_by_cost_policy`가 차단 상태를 보여준다. 위반 행의 금액을 실제 비용에 중복 합산하지 않는다. 시간과 일일 예산 경계는 UTC다. 실행 목록은 삭제된 공간의 실행을 포함하지 않지만 비용 장부는 삭제 이후에도 포함한다.

예약액이 실제 호출 허용 한도를 결정한다. `recorded_cost_total_micro_usd`는 별도의 비용 관측값이며 예약액과 더하거나 예약 잔액에서 빼지 않는다. 사용량을 얻지 못했을 때는 보수적인 예약액이 기록 비용으로 쓰일 수도 있으므로 공급자 청구서와 동일하다고 해석하지 않는다. 실제 비용 기록이 없는 예약은 무료 호출로 간주하지 않는다. CLI 비교 평가 비용은 이 서비스 DB 집계에 포함되지 않는다.

배포 후 같은 SQL 파일을 **확정한 운영 config와 명시적인 `--remote`**로 실행한다. 이 파일은 SELECT만 수행한다. 초기 운영 점검 기준은 다음과 같으며, 자동 알림 연결·수신은 별도 검증이 필요하다.

| 지표 | 초기 조사 기준 | 확인할 것 |
| --- | --- | --- |
| 가장 오래된 `pending` | 5분 초과 warning, 10분 초과 critical | Queue 소비자, 예약 복구 실행 여부, 반복 전송 실패 |
| 가장 오래된 `running` | 70초 이상 critical | 60초 호출 제한과 5분 주기 cron의 불확실 상태 전환 여부 |
| `uncertain` | 새 발생 시 | 결과와 비용을 확인할 수 없는 원인; 자동 유료 재호출 금지 |
| 삭제 대기 공간 | 5분 간격 두 번의 조회에도 지속 | cron 실행, 삭제 실패 이벤트, D1 오류 |
| 비용 정책 위반 | 1건 이상 | 라이브 호출 차단 여부, 실제 사용량과 예약 산식, 정책 검토 없이 재개되지 않는지 |
| 오늘/누적 예약액 | $0.40 / $12부터 확인 | 각각 현재 $0.50 / $15 상한의 80%; 상한에서 정상적인 실행 제한 안내인지 |

현재 규모에서는 필요할 때 집계하는 방식을 사용한다. 트래픽이 늘면 원장 전체 스캔을 매 요청에 넣지 말고 집계 주기와 저장 비용을 먼저 측정한다. 모델 예산 제한은 D1·Queue·로그 등 인프라 요금의 전체 상한을 대신하지 않는다.

`ops_health`는 복구 이후 best-effort로 발생한다. 진단 실패는 critical `ops_health_collection_failed`로 기록하고 기존 복구 결과를 막지 않는다. pending/running/uncertain, 비용 위반, 저장량, 일일 유입 한도를 집계한다. 저장량 80% warning / 95% critical, 일일 생성·명령 80% warning / 100% critical이다. UTC 00:00 cron에서는 내용 전체 재집계와 카운터 차이도 검사한다. `ops:local`로도 수동 대조할 수 있다.

cron 자체가 실행되지 않는 장애는 그 cron 로그로 발견할 수 없다. 외부에서 최근 성공 cron 부재(10분), Queue 소비자 오류, 실제 알림 수신을 따로 검증해야 한다. 내용 없는 이벤트 발행은 알림 전송 완료가 아니다. 재집계는 새벽 1회와 수동 점검으로 제한해 큰 JSON 전체 읽기를 매 요청에 넣지 않는다.

Staging 운영 드릴은 `scripts/staging-operational-drill.ts`로 고정된 흐름만 실행한다. 도구는 `masondev1024` staging의 account, Worker 이름, D1 ID, Queue 이름, Rate Limiting namespace, origin이 현재 config와 일치하는지 먼저 확인하고 mismatch가 있으면 원격 조회나 변이를 시작하지 않는다. 기본 plan/read-only 모드는 원문, owner token hash, command response, snapshot JSON을 읽지 않고 schema/binding과 집계만 확인한다.

```sh
npm run ops:staging:plan
npm run ops:staging:read-only
```

`ops:staging:expiry-drill`은 `ops_*` 접두사의 테스트 소유 workspace/source/snapshot을 직접 삽입하고, 그 workspace가 새로 만든 owner에 속하는지 같은 D1에서 확인한 뒤 다음 scheduled cron 로그와 삭제 결과를 확인한다. `ops:staging:timeout-drill`은 `ops_*` 접두사의 테스트 소유 running run 하나를 직접 삽입해 cron이 정확히 `uncertain`으로 바꾸는지 관측한 뒤 workspace와 now-orphan owner만 삭제한다. cleanup 실행 실패나 cleanup verification 실패는 성공 artifact가 아니라 exit 1이다. 두 명령은 `--allow-remote-mutation`을 포함하므로 실행 전 대상이 staging인지, 현재 배포 코드와 migration이 호환되는지, tail 권한이 있는지 확인한다. 생성된 artifact는 `artifacts/staging-operational-drill-*.json`이며 쿠키, 원문, provider/SDK stderr를 저장하지 않는다.

pending redispatch와 동시에 도착한 pending 메시지의 선점 경쟁은 현재 도구에서 자동 원격 증명하지 않는다. pending live run의 재전달은 실제 모델 호출로 이어질 수 있으므로 승인된 비용 범위와 테스트 환경을 확인한다. 로컬 통합 테스트의 선점/복구 검증과 실제 원격 증거를 구분한다. 알림 수신도 recipient/transport가 선택되고 실제로 검증된 후에만 “전달됨”으로 인정한다.

2026-09-09 20:45 KST 실제 cron에서 DB-seeded 만료 workspace 1개 삭제와 오래된 running run 1개의 uncertain 전환을 관측했다. 두 드릴은 정리 후 owned workspace/owner가 0임을 확인했다. 이어 실제 Gemini 서비스 생성·승인·재조회·삭제가 통과했고, 삭제된 그 run의 Queue 메시지 두 개는 실제로 skipped 처리됐다. 장부는 기존 2행을 유지했다. 이는 삭제 후 중복 메시지 처리 증거이며 pending 경쟁이나 공급자 과금 전체에 대한 exactly-once 보장은 아니다. 최초 MCP 쓰기는 인증 10000으로 실패했으며 기존 Wrangler OAuth로 제한된 Queue 주입을 수행했다. 최종 상태와 artifact 경로는 `PLANS.md`와 `.omx/verification-u2-u5.json`에 있다.

꼬리 로그 관측은 내용 없는 허용 필드와 최근 20개 sample만 보관한다. 전체 trace 저장소가 아니므로 counts와 sample 수가 같다고 가정하지 않는다. until-cron 드릴은 마지막 실제 cron outcome과 DB 결과를 모두 확인한다. 알림 수신과 호환 버전으로의 롤백 훈련은 여전히 미완료다.

## 배포 전 로컬 검사와 후보 파일

```sh
npm run cf:readiness
npm run release:prepare
npm run deploy:check:staging
npm run deploy:check:production
```

`cf:readiness`는 placeholder를 허용한 환경 구조 검사다. 계정·DB가 미확정이면 두 환경의 strict `deploy:check:*`는 의도적으로 실패한다. 구조 검사가 성공해도 원격 자원 존재·secret·마이그레이션·알림은 확인되지 않는다. Rate Limiting namespace는 계정 내 충돌을 피하도록 선택하는 식별자이며 생성된 DB UUID와 성격이 다르다. staging과 production은 별도 D1 장부이므로 각각의 모델 예산을 합산한 프로젝트 전체 상한을 자동으로 공유하지 않는다. 실제 두 환경을 열기 전에 staging 시험용 예산과 production 예산을 기존 전체 예산 안에서 배분하고 공급자 사용량도 함께 대조한다.

`release:prepare`는 업로드 없는 번들 검사 후 `artifacts/release-candidate/`에 로컬 검증용 Worker/화면/마이그레이션/설정과 SHA-256 manifest를 모은다. 비밀 파일과 사용자 DB는 포함하지 않는다. 미확정 자원과 로컬 환경을 사용하므로 이 파일은 그대로 운영에 올릴 확정 산출물이 아니다. 계정 선택 후 확정된 환경으로 다시 빌드·검증한다. CI 설정은 검증 성공 시 후보 파일을 보관하도록 준비했으며 실제 원격 Actions는 실행 전이다.

## 공개 배포 대상과 실행 순서

2026-09-08 읽기 전용 조회에서 연결된 두 계정 모두 아래 이름의 이어짐 리소스가 없었다. 이후 사용자가 `masondev1024` 계정을 선택했고, 기존 staging 리소스를 본주소에 연결해 공개 체험 서비스를 운영한다. 다른 프로젝트의 리소스는 재사용하지 않는다. 아래 표는 현재 공개 체험 운영 상태와 별도 production 환경의 남은 상태를 구분한다.

| 항목 | 준비안 |
| --- | --- |
| 계정 | 사용자가 선택한 `masondev1024`, account `d77fd515103009a324bebb3ac5b81fd9` |
| Worker | staging `ieojim-staging`, production `ieojim`; 환경별 코드와 정적 화면 함께 배포 |
| D1 | staging `ieojim-staging`에 0001~0009 적용 완료. 이번 변경은 새 마이그레이션 없음. production은 미생성 placeholder이며 별도 승인·준비 필요 |
| Queue | 환경별 하나: `ieojim-runs-staging` / `ieojim-runs-production`; batch 1 / max_concurrency 1 / 최대 재전달 3 / DB 단일 선점 |
| 주소 | canonical `https://ieojim.jungseongheon.org`; legacy guest-only `https://ieojim-staging.masondev1024.workers.dev`; 별도 production 서비스 주소는 아직 없음 |
| 실행 설정 | staging `APP_ENV=staging`, Gemini Secret과 Google/Auth Secret 설정 완료, 5분 cron. 9/12 일일 USD 2.50 / 누적 USD 15 admission budget 적용, 최종 버전 `c0a2d105-efb7-4685-a03a-c5bbbdd6e1df`. 별도 production 환경은 미배포 |
| Git | 로컬 `main` 초기화 완료. GitHub App 연결 계정은 `masondev1024`; 이어짐 검색 결과 없음. 원격 저장소 이름·공개 범위·첫 커밋/게시 결정 대기 |

배포 config는 선택한 계정과 새 D1 ID를 명시하고 로컬 설정과 분리한다. 사용자가 실제 대상과 비용/공개 범위를 검토할 수 있도록 생성 전 리소스 목록과 배포 번들을 확정한다. 원격 리소스를 생성하거나 공개하는 승인은 프로젝트 `AGENTS.md`의 Authority boundaries를 따른다.

2026-09-08 공식 문서 기준 Queues와 Workers Logs는 Free에서도 사용할 수 있어 Queue 하나 때문에 유료 플랜이 필수인 것은 아니다. Free Queue 보관은 24시간, Free Workers Logs 보관은 3일이다. 따라서 7일간 앱 내용이 남는다는 약속과 운영 로그/메시지 보관은 서로 다른 정책이다. 실제 선택 계정의 플랜과 남은 한도는 배포 전에 확인한다. [Queues 요금/한도](https://developers.cloudflare.com/queues/platform/pricing/), [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/).

현재 공개 체험 서비스 변경 순서:

1. 본주소 `https://ieojim.jungseongheon.org`와 기존 workers.dev 게스트 전용 경계를 확인한다. workers.dev에 로그인 버튼이나 account auth를 열지 않는다.
2. 원격 secret 변경 전 현재 배포 버전, 바인딩, 예산, 로그 가림 설정을 확인한다. Google/Auth secret과 Gemini secret을 같은 공개 문서나 로그에 노출하지 않는다.
3. 코드나 secret을 바꾼 뒤 typecheck/lint/build/dry-run과 배포 도메인 브라우저 검사를 실행하고, `PLANS.md`에 version ID와 증거 artifact를 남긴다.
4. 공개 주소에서 합성 사례와 계정 경계를 나눠 확인한다. 합성 사례는 로그인 없이 작동해야 하고, Google 로그인은 canonical domain에서만 auth available이어야 한다.
5. 요청 실패율, Queue 지연, `pending/running/uncertain`, 비용 예약 잔액, 삭제 작업 결과를 관측한다. 알림 수신 채널과 임계값은 운영 계정에서 설정하고 실제 수신을 검증한다. 로컬 로그가 있다는 이유로 운영 알림이 준비됐다고 보지 않는다.

별도 production 환경을 새로 만들 때는 승인된 D1과 Queue를 생성하고 `wrangler.jsonc`의 해당 명시적 환경에 실제 account_id와 DB binding을 명시한다. 두 환경의 DB ID와 Rate Limiting namespace가 겹치지 않게 한다. 로컬 config의 placeholder는 로컬 개발 용도로 유지한다. Git 공개 여부는 별도 결정이다.

## 중단과 롤백

문제 발생 시 유료 모델 호출을 먼저 차단하고 기존 내용을 읽고 복구할 수 있는지 확인한다. 앱 이전 버전으로 돌아가더라도 D1 데이터가 자동으로 돌아간다고 가정하지 않는다. 파괴적 다운 마이그레이션 대신 호환 가능한 코드 롤백 또는 전진 수정을 선택한다. 롤백 대상 Worker가 현재 D1 payload를 읽을 수 있는지 별도로 검증한다. 예를 들어 새 semantic fact 필드가 추가된 뒤라면 이전 배포본의 strict schema가 그 JSON을 거절할 수 있으므로 “컬럼 추가가 호환성을 보장한다”고 보지 않는다. 내용 복원 기능은 인프라 백업을 대신하지 않는다.

D1 Time Travel로 전체 DB를 되돌리면 삭제한 원문이나 과거 비용·권한 상태가 살아날 수 있다. 일반 장애 복구는 호환 코드 롤백 또는 전진 수정을 우선한다. 전체 DB 복구는 별도 사고 절차로 취급하고 호출 차단, 삭제/만료 재적용, 현재 비용 장부와 소유권 대조를 완료하기 전 공개 서비스를 재개하지 않는다. 이 절차의 실제 원격 훈련은 수행 전이다.

7일 비활성 삭제를 넘어 원문을 장기 백업하는 정책은 현재 범위에 없다. 백업을 추가하면 사용자의 삭제와 보관 약속에 맞춰 만료·복구·삭제 전파를 함께 설계해야 한다.

## 의존성 점검 — 2026-09-09

`npm audit --omit=dev`는 알려진 운영 의존성 취약점 0건이었다. 전체 개발 의존성 트리에는 miniflare/CLI 경로의 `sharp` 전이 의존성 관련 high 4건이 남아 있다. [GHSA-rgj7-g3m4-5g8c](https://github.com/advisories/GHSA-rgj7-g3m4-5g8c). 자동 강제 수정은 Workers 테스트 도구를 호환되지 않는 버전으로 내리므로 적용하지 않았다. 호환되는 상위 도구 업데이트 후 별도 검증하며, 이 결과를 전체 보안 검증 완료로 표현하지 않는다.
