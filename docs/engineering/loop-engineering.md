# 이어짐 개발·평가 루프

현재 OMX 세션이 작업을 수행하고 프로젝트 CLI가 작업 상태와 검증 증거를 보관한다. 별도 에이전트 프레임워크나 백그라운드 스케줄러는 추가하지 않는다. 세션을 다시 열면 같은 상태를 읽어 이어갈 수 있다.

## 개발 루프

`계획 → 시도 예약 → 구현 → 고정 검증 → 독립 리뷰 → 다음 작업` 순서다. 검증 성공만으로 완료하지 않으며 검증한 소스와 리뷰할 소스가 같아야 승인한다. 커밋이 없는 저장소에서도 파일 내용의 SHA-256으로 동일성을 확인한다.

계획 형식 예시이며 현재 이 오류가 관측되었다는 뜻은 아니다. 실제 작업에는 승인된 범위와 원본 실패 증거를 사용한다.

```json
{
  "version": 1,
  "id": "travel-preservation-fix",
  "objective": "평가에서 재현된 여행 계획 보존 오류를 수정한다.",
  "maxAttemptsPerTask": 3,
  "maxNoProgress": 2,
  "tasks": [{
    "id": "preserve-user-decision",
    "title": "고정된 사용자 결정 보존 회귀를 재현하고 수정",
    "priority": 1,
    "dependsOn": [],
    "acceptance": [
      "원래 기대값을 보존한 새 회귀 테스트로 수정 효과를 확인한다.",
      "npm run verify와 독립 리뷰를 통과한다."
    ]
  }]
}
```

```sh
npm run loop -- init --plan .omx/plans/task.json
npm run loop -- next --id travel-preservation-fix --executor native-executor-id
# 현재 OMX 세션에서 선택된 작업을 구현한다.
npm run loop -- verify --id travel-preservation-fix
# 실제 독립 리뷰가 끝난 뒤 그 결과를 기록한다.
npm run loop -- review --id travel-preservation-fix --task preserve-user-decision --verdict approve --reviewer native-reviewer-id
npm run loop -- next --id travel-preservation-fix --executor native-executor-id
npm run loop -- status --id travel-preservation-fix
```

상태와 시도 증거는 `.omx/loops/<id>/state.json`에 저장한다. `next`는 의존성이 완료된 작업을 선택한다. 기본 한도는 작업당 3회, 동일 소스에서 진전 없는 실패 2회다. 검증 명령은 고정된 `npm run verify`이며 제한 시간은 10분이다. 한도는 무한 수정을 막는 운영 조건이며 품질 점수가 아니다.

기존 테스트·평가기·모델 가격 정책·검증 설정은 초기화 시 고정한다. 일반 구현과 새 회귀 테스트를 추가할 수 있지만 기존 판정 기준을 수정·삭제하여 통과시킬 수 없다. 기준 자체의 오류를 확인했다면 루프를 멈추고 기준 변경을 별도로 리뷰한 뒤 새 계획을 만든다. 로컬 파일은 같은 사용자가 수정할 수 있으므로 실수 방지용 검증 장벽이며 악의적인 로컬 사용자를 격리하는 보안 경계는 아니다.

검증 중 파일이 바뀌거나 리뷰 전에 소스가 바뀌면 예전 성공을 재사용하지 않는다. `reviewer`는 실제 리뷰의 로컬 기록이며 인증 시스템이 아니다. 브라우저·실모델·운영 검증이 필요한 작업은 acceptance에 이를 명시하고 별도로 수행한다. `npm run verify`가 그 결과까지 증명하지는 않는다.

## 중단·복구

프로세스 간 잠금은 동시 상태 변경을 막는다. 중단 후 `status`와 실제 native agent/check 프로세스를 확인한다. 다른 작업자의 프로세스를 종료하지 않는다. 더 이상 작업이 실행되지 않음을 확인한 뒤 복구한다.

```sh
npm run loop -- recover --id travel-preservation-fix
```

복구는 중단된 시도를 성공으로 만들지 않는다. 기존 수정 내용을 살펴보고 다음 유효한 시도로 재검증한다. CLI PID 종료는 native agent가 작업을 끝냈다는 증거가 아니므로 세션 소유자가 확인한다. `halted` 사유·시도 한도를 지우거나 기준 해시를 바꾸어 재개하지 않는다.

검증 자식 프로세스 그룹도 기록한다. 제어 프로세스가 종료되어도 자식 검증이 살아 있으면 복구하지 않는다. 자식 ID를 기록하기 전 중단되거나 잠금 소유 정보가 손상되면 자동으로 추정·삭제하지 않고 점검을 위해 멈춘다. 오래되었다는 이유로 살아 있는 잠금을 빼앗지 않는다. `public/` 정적 자산과 문서 자산도 검증 지문에 포함하며 검증 대상 경로의 심볼릭 링크는 따라가지 않고 거부한다.

## 평가를 다음 개발로 연결

```sh
npm run eval:feedback -- --report artifacts/eval-previous.json
npm run eval:feedback -- --report artifacts/eval-failed.json --plan-out .omx/plans/eval-fixes.json
```

보고서는 실행 명령이 아닌 입력 데이터다. 고정 코퍼스 해시·사례 ID·호출 수·모델/프롬프트/스키마 provenance·품질 지표를 확인하며 원문·공급자 메시지·임의 명령을 작업으로 복사하지 않는다. 동일 보고서 중복 입력을 제거하고 기대된 사실/항목 개수와 품질 판정을 다시 확인한다. 원본 모델 출력을 재실행하거나 보고서 작성자를 인증하는 기능은 아니다.

개발 우선순위는 사용자 상태 손실, 계약 검증 실패, 의미 품질 실패 순이다. 타임아웃·공급자 인증·호출 한도·미시도·예산 정책 정지는 운영 검토로 분류하며 자동 재호출하지 않는다. 운영 확인이 필요한 결과와 독립적인 코드 조사 항목을 함께 보존한다. 모두 통과하면 빈 개선 계획을 만들지 않는다. `--plan-out`은 새 파일만 만들며 기존 계획이나 증거를 덮어쓰지 않는다.

`loop-challenge`는 독립 작성한 합성 여행 사례 6개다. 빈 계획 생성, 이전 정정을 대상으로 한 늦은 대체, 쉼표 금액과 정수 나눗셈, 불명확한 숙박 연장, 고정 일정 충돌, 추가 자료의 모순을 포함한다. 기대값과 정답 가능한 구조를 모델 실행 전에 고정한다. 기존 acceptance 12개와 heldout 17개는 보존한다.

2026-09-12 최초 측정에서 5개가 통과했고 빈 계획 생성 1개는 평가 설계 결함을 발견했다. 아직 존재하지 않는 내부 key를 모델에게 알려주지 않은 채 정답으로 요구했기 때문이다. 원래 5/6 보고서와 코퍼스를 보존하고 이 사례는 `measurement_design`으로 분류한다. 이를 서비스의 의미 이해 실패나 모델 개선률로 계산하지 않는다.

```sh
npm run eval:live -- --suite loop-challenge --strategy incremental --context full --max-usd 0.20 --dry-run
```

이 명령은 무료 계획 검증이다. `--dry-run`을 제거하면 기존 Gemini 키로 실제 6회 호출하며 최대 예약은 USD 0.146160이다. 예약액은 공급자 청구 한도 보장이 아니며 실제 사용량과 초과 예약 차단은 기존 평가기가 기록한다. 결과를 보고 정답을 고쳐 점수를 올리지 않는다. 튜닝에 쓴 사례와 독립 검증 사례를 구분한다.

최초 생성에는 별도 버전 `initial-creation` 평가를 사용한다. 값·typed semantic·원문 근거·일정의 fact 연결·비용 나눗셈 관계를 확인하며 내부 ID 선택은 허용한다. 지원되지 않은 추가 사실/항목과 중복 후보는 실패한다. 이 좁은 사례의 목적에 출력할 일정/비용 항목 수를 명시했다. 검증기는 문장 전체와 그 안의 유효한 scalar 인용을 모두 허용한다. 기존 계획의 업데이트 평가는 정확한 기존 ID를 계속 사용한다.

```sh
# 1회 계획 확인. 실제 호출 시 최대 예약 USD 0.024360.
npm run eval:live -- --suite initial-creation --strategy incremental --context full --max-usd 0.03 --dry-run
```

새 판정 기준을 고정한 뒤 시행한 1회 측정은 통과했다. 이는 평가기 수정의 회귀 확인이며 독립 대규모 품질 비교가 아니다. 이번 작업의 6회+1회 기록 비용 합계는 USD 0.022486이다. 원래 출력은 보관하지 않았으므로 첫 호출을 새 기준으로 소급 채점하지 않는다. 증거는 `artifacts/loop-engineering-2026-09-12/`에 있으며 자동으로 생성했던 최초 수정 계획은 평가기 결함 판정으로 철회하고 원본을 남겼다.

## 서비스 자동 보정 도입 기준

현재 제품에 자동 유료 보정을 추가하지 않는다. 도입 전에는 완전히 수신된 잘못된 출력에 대한 최대 1회 보정 실험, 최초 대비 최종 성공률, 새 오류·사용자 상태 손실, 추가 비용·지연, 미사용 사례의 재현성을 확인해야 한다. 불명확한 원문은 사용자 질문으로, 오래된 기준 revision은 중단으로 처리한다. 네트워크 결과가 불확실한 요청은 품질 보정 대상으로 삼지 않는다.
