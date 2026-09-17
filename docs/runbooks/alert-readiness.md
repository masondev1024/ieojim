# Alert Readiness Runbook - 2026-09-09

이 문서는 이어짐 staging의 현재 운영 진단을 실제 알림 체계로 연결하기 전 점검표다. 현재 코드는 외부 알림을 보내지 않는다. 사용자가 수신자와 전송 채널을 정하고 실제 수신을 검증하기 전까지 "알림 준비 완료"로 보지 않는다.

## Current State

| 영역 | 현재 구현 | 운영 해석 |
| --- | --- | --- |
| 상태 산출 | `ops_health` 구조화 로그 | severity, check code, 원문 없는 집계 제공 |
| 수동 조회 | `npm run ops:local`, staging drill read-only | 원문, 제목, owner token, snapshot, 모델 응답을 선택하지 않음 |
| 주기 | `*/5 * * * *` cron | 5분 단위 복구와 진단. cron 미실행은 자체 로그만으로 탐지 불가 |
| Queue | batch 1, concurrency 1, retry 3 | D1 claim으로 중복 유료 호출 방지. Queue 자체는 at-least-once |
| 외부 수신 | 미구성 | Slack, email, SMS, PagerDuty 등 recipient/transport 없음 |
| production | 미배포 | production 알림은 대상 URL, D1, Queue 생성 후 별도 검증 필요 |

## Severity Rules

`src/server/ops-health.ts`와 `OPERATIONS.md` 기준이다. 외부 알림을 붙일 때는 아래 조건을 그대로 1차 라우팅 규칙으로 사용한다.

| 조건 | warning | critical | 1차 조치 |
| --- | --- | --- | --- |
| 가장 오래된 `pending` live run | 5분 초과 | 10분 초과 | Queue consumer, cron redispatch, D1 pending row 확인 |
| 가장 오래된 `running` live run | 없음 | 70초 이상 | 60초 모델 제한 후 `uncertain` 전환 여부 확인 |
| `uncertain` live run | 없음 | 1건 이상 | 공급자 결과와 비용 확인 전 자동 재호출 금지 |
| 모델 예산 정책 위반 | 없음 | 1건 이상 | live call 차단 상태 유지, 가격/usage/ledger 대조 |
| 저장량 | 80% 이상 | 95% 이상 또는 초과 | 삭제/만료 동작과 집계 drift 확인 |
| 저장 정책/사용량 singleton 누락 | 없음 | 누락 즉시 | 마이그레이션과 D1 상태 점검 |
| 저장량 재집계 차이 | 없음 | 0이 아닌 값 | counter drift 원인 조사. 장부 임의 수정 금지 |
| 일일 workspace 생성/명령 | 80% 이상 | 100% 도달 | 정상 제한인지 abuse인지 구분 |
| ops health 수집 실패 | 없음 | 즉시 | 복구 cron 결과와 별개로 DB 조회 실패 원인 조사 |
| 최근 성공 cron 부재 | 없음 | 10분 이상 | 외부 관측 필요. `cron_recovery` 로그만으로는 탐지 불가 |

## Alert Payload

외부 채널에 보낼 payload는 내용 없는 운영 필드만 포함한다.

```json
{
  "service": "ieojim",
  "environment": "staging",
  "severity": "critical",
  "checks": ["uncertain_runs_operator_review"],
  "observedAt": "2026-09-09T12:00:00.000Z",
  "pendingRuns": 0,
  "oldestPendingAgeSeconds": null,
  "runningRuns": 0,
  "oldestRunningAgeSeconds": null,
  "uncertainRuns": 1,
  "modelBudgetPolicyViolations": 0,
  "storageUsedRatio": 0.0,
  "operatorReviewRequired": true
}
```

금지 필드: source text, workspace title, purpose, owner token/hash, cookie, API key, prompt, model raw response, snapshot JSON, cached command response.

## Response Procedure

1. 최근 `cron_recovery`와 `ops_health` 로그를 확인한다. `ops_health`가 실패해도 복구 cron 자체가 성공했을 수 있으므로 두 이벤트를 분리해서 본다.
2. `npm run ops:local` 또는 staging read-only drill로 집계를 대조한다. staging read-only는 원격 조회이므로 대상 계정과 환경을 확인한 뒤 실행한다.
3. `pending`이 오래된 경우 새 run을 만들지 않는다. 기존 pending run ID가 cron에서 재전달됐는지 확인한다. pending redispatch drill은 실제 Queue consumer가 건강하면 한 번의 Gemini 호출을 만들 수 있다.
4. `running`이 오래된 경우 timeout 전환을 기다린다. 결과를 모르는 호출은 자동으로 두 번째 유료 호출을 만들지 않는다.
5. `uncertain`은 operator review로 처리한다. 공급자 대시보드, D1 `budget_ledger`, `run_lifecycle`의 usage 필드를 대조하고 사용자가 재시도를 명시하기 전까지 재실행하지 않는다.
6. 비용 위반은 live call 차단을 유지한 채 공식 가격, reservation 산식, 실제 usage를 확인한다. 장부 삭제로 차단을 해제하지 않는다.
7. 저장량이나 admission 한도는 abuse, 정상 사용 증가, 만료 실패를 구분한다. 삭제는 비용 장부를 초기화하지 않는다.
8. 복구 후 같은 집계와 로그를 다시 확인한다. 조치 결과는 원문 없는 artifact 또는 운영 노트로 남긴다.

## Staging Commands

원격 변이를 만들지 않는 사전 점검:

```sh
npm run ops:staging:plan
node --import tsx scripts/staging-pending-drill.ts --target=staging --mode=plan
```

읽기 전용 staging 집계:

```sh
npm run ops:staging:read-only
node --import tsx scripts/staging-pending-drill.ts --target=staging --mode=read-only
```

승인된 staging 변이 드릴:

```sh
npm run ops:staging:expiry-drill
npm run ops:staging:timeout-drill
node --import tsx scripts/staging-pending-drill.ts --target=staging --mode=pending-redispatch --allow-remote-mutation --duplicate-messages 2
```

변이 드릴은 `ops_*` fixture만 만들고 정리해야 한다. pending redispatch는 실제 live pending run을 Queue로 보내므로 승인된 staging 예산 창에서만 실행한다. 현재 도구는 기존 Wrangler 인증을 메모리에서 받아 D1/Queue API에 사용한다. 인증값을 출력하거나 파일에 저장하지 않는다. 유료 작업을 만들기 전 원격 D1 배치의 강제 실패와 전체 롤백을 검증한다. 드릴 실패 시 아직 claim 전인 테스트 pending run은 조건부 취소한 뒤 정리하고, 이미 running이거나 결과를 확인할 수 없으면 증거와 비용 장부를 보존한다.

## Decision Gate

외부 알림을 "운영 가능"으로 인정하려면 다음 증거가 필요하다.

| Gate | 통과 기준 |
| --- | --- |
| Recipient | 수신자와 escalation owner가 명시됨 |
| Transport | 선택한 채널이 실제 critical payload를 수신함 |
| No private data | payload와 저장 artifact에 금지 필드가 없음 |
| Missed cron | 외부 관측이 10분 이상 cron 부재를 감지함 |
| Recovery | uncertain, budget violation, pending age에 대한 수동 대응 절차가 실행 기록으로 남음 |
| Ledger preservation | 복구 중 reserve/actual/policy ledger를 삭제하지 않음 |

현재 stop condition: recipient와 transport가 선택되지 않았다. 이 문서는 알림 설계를 위한 runbook이며 실제 알림이 전달됐다는 증거가 아니다.
