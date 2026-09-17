# 제품 유용성 로컬 검증 프로토콜 — 2026-09-16

## 목적

이 문서는 이어짐이 수동 정리보다 실제로 도움이 되는지 확인하기 위한 로컬 paired comparison 절차다. 숨은 분석 수집도 아니고, 제품에 심는 telemetry도 아니고, 일반 사용자가 더 빠르게 일한다고 증명하는 도구도 아니다.

외부 사용자 모집은 아직 미뤄 둔다. 독립 참가자 데이터가 생기기 전까지 결과는 `self` 또는 `operator` 로컬 관찰로만 말해야 한다.

## 실행

```bash
node --import tsx scripts/utility-trial.ts path/to/trial.json
```

JSON에는 `schemaVersion: 1`, 익명 `studyId`, `records`만 넣는다. 원문 안내, 개인 일정, 이메일, 이름, 캘린더 내용, 모델 원문 출력, 스크린샷 경로, 숨은 분석 ID는 넣지 않는다.

## 기록 단위

한 참가자와 한 케이스마다 `manual` 1건, `service` 1건이 정확히 있어야 한다. 중복되거나 한쪽이 빠지면 거절한다. 같은 pseudonym이 케이스마다 `self`, `operator`, `independent`를 바꾸는 것도 거절한다.

`participantType`은 다음 중 하나다.

- `self`: 만든 사람이 직접 해 본 기록
- `operator`: 운영자가 절차를 따라 재현한 기록
- `independent`: 제품 제작자가 아닌 사람이 해 본 기록

## 시간 정의

모든 시간은 초 단위이고, 수동 방식과 서비스 방식 모두 같은 기준으로 잰다. API 대기 시간과 화면 로딩 대기 시간도 사용자가 실제로 기다린 시간이면 포함한다.

- `copy`: 안내문이나 필요한 정보를 가져와 입력할 준비를 마치는 시간
- `setup`: 케이스 시작, 새 작업 공간 또는 수동 문서 준비, 필요한 조건 입력 시간
- `review`: 결과를 읽고 바뀐 점, 근거, 영향 범위를 확인하는 시간
- `correction`: 잘못된 내용 수정, 빠진 변경 찾기, 다시 조정하는 시간
- `approval`: 최종 승인, 저장, 적용 여부 결정, 적용 결과 확인 시간

총합은 하루 86,400초를 넘을 수 없다. 0초만 있는 기록은 거절한다.

## 품질과 속도 신호

시간 차이는 양쪽 outcome이 모두 `completed`인 쌍에서만 계산한다. 실패하거나 중단한 기록은 시간 비교에서 제외하지만, 실패 수와 제외 사유에는 그대로 남긴다. 서비스가 더 오래 걸리면 음수 savings로 남긴다.

품질 게이트는 서비스 쪽 `missedChanges`가 0이고, 수동 방식보다 `corrections`가 늘지 않을 때만 통과한다. 수동도 놓친 변경을 서비스도 똑같이 놓쳤다면 품질 통과가 아니다.

도구가 내는 `localComparisonSignal.supported`는 로컬 paired observation 신호일 뿐이다. 이 신호도 다음 조건을 모두 만족해야 true가 된다.

- 완료된 쌍이 1개 이상 있다.
- 실패 또는 중단 기록이 없다.
- 품질 게이트를 통과한다.
- 평균 paired savings가 양수다.
- manual-first와 service-first 순서가 둘 다 있다.

`speedClaim.allowed`와 `globalClaim.allowed`는 항상 false다. 이 도구만으로 일반 사용자 속도 개선, 구매 의향, 시장 수요를 주장하면 안 된다.

## 순서 편향

첫 번째 방법을 하면서 케이스 내용을 배운 뒤 두 번째 방법이 빨라질 수 있다. 그래서 manual-first와 service-first를 둘 다 포함해야 한다. 한쪽 순서만 있으면 `ORDER_OR_PRACTICE_BIAS_RISK`가 남고 로컬 비교 신호도 지원되지 않는다. 같은 케이스에서 manual과 service의 `order`가 같으면 입력 오류로 거절한다.

## 빈 입력 템플릿

아래는 측정값이 들어 있지 않은 템플릿이다. 숫자를 지어내지 말고 실제로 잰 뒤 채운다.

```json
{
  "schemaVersion": 1,
  "studyId": "ieojim_utility_trial_local_001",
  "records": [
    {
      "participantPseudonym": "p01",
      "participantType": "self",
      "caseId": "case_notice_change_001",
      "order": 1,
      "method": "manual",
      "elapsedSeconds": {
        "copy": 0,
        "setup": 0,
        "review": 0,
        "correction": 0,
        "approval": 0
      },
      "outcome": "completed",
      "corrections": 0,
      "missedChanges": 0
    },
    {
      "participantPseudonym": "p01",
      "participantType": "self",
      "caseId": "case_notice_change_001",
      "order": 2,
      "method": "service",
      "elapsedSeconds": {
        "copy": 0,
        "setup": 0,
        "review": 0,
        "correction": 0,
        "approval": 0
      },
      "outcome": "completed",
      "corrections": 0,
      "missedChanges": 0
    }
  ]
}
```

이 템플릿은 그대로 실행하면 0초 기록이라 거절된다. 실제 측정 뒤 각 구간을 채워야 한다.
