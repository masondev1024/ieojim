# Human Trial Packet - 2026-09-09

이 문서는 이어짐을 실제 사람이 써 볼 때 사용할 시험 패킷이다. 목표는 제품 품질을 주장하는 것이 아니라, 여행과 과제 변경 업무에서 사람이 어디서 막히는지, 어떤 증거를 보고 결정을 신뢰하는지, 보호 상태가 실제로 이해되는지 확인하는 것이다.

## Scope

| 항목 | 값 |
| --- | --- |
| 대상 | 이미 실행 중인 로컬 `http://127.0.0.1:5173` 또는 staging `https://ieojim-staging.masondev1024.workers.dev` |
| 참가자 | 아직 모집/실행 전 |
| 시간 | 1인 20-30분 계획 |
| 도메인 | 여행 변경, 과제 마감 변경, 출처 충돌, 보호 상태 |
| 제외 | 경쟁 서비스 비교, 통계적 우위 주장, 실제 예약/발송/결제 |

시험 중 참가자에게 원문이 합성 데이터임을 알려준다. 참가자가 실제 개인정보, 실제 결제 정보, 실제 연락처를 입력하지 않게 한다.

## Preflight

진행자는 시험 전에 아래를 확인한다.

```sh
npm run ops:staging:plan
npm run ops:staging:read-only
```

이미 로컬 개발 서버가 `5173/8787`에서 실행 중이면 그 서버를 그대로 사용한다. 새 환경에서 처음 준비할 때만 아래를 실행한다.

```sh
npm ci
npm run db:local
npm run dev
```

`npm run dev`는 계속 실행되는 개발 서버이며 기존 서버와 포트가 충돌할 수 있다. 운영 집계는 다른 터미널에서 확인한다.

```sh
npm run ops:local
```

시험 중 실제 모델 호출을 사용할 경우 staging 예산과 Gemini 사용량을 별도로 기록한다. 실패나 `uncertain`이 나오면 같은 입력을 자동 반복하지 않는다.

## Trial Script

### Task 1 - Travel Initial Workspace

목적에는 `제주 워크숍 변경사항을 근거와 함께 정리한다`를 입력하게 한다. 참가자에게 아래 원문을 넣고, 제안이 준비되면 근거를 확인한 뒤 적용하게 한다.

```text
제주 워크숍 안내입니다. 참석자는 4명입니다. 숙소 체크인은 금요일 15:00입니다. 공동 고정비는 총 900000원입니다. 고정비는 참석자가 똑같이 나눕니다. 숙소 예약 확인이 필요합니다.
```

기대 관찰:

| 확인 항목 | 기록 |
| --- | --- |
| 작업공간 생성 성공 | pass / fail |
| 참석자 4명, 총액 900000원, 인당 225000원 확인 | pass / fail |
| `숙소 예약 확인` 같은 checklist 항목이 원문 근거와 연결됨 | pass / fail |
| 검토 후 제안을 적용해 revision이 생김 | pass / fail |
| 원문 근거를 참가자가 찾을 수 있음 | pass / fail |
| 잘못 이해한 화면 문구 | 자유 기록 |
| 소요 시간 | 분:초 |

### Task 2 - Travel Update And Protected State

Task 1에서 적용된 workspace에서 `숙소 예약 확인` checklist 항목을 완료 처리하고, 비용이나 일정 항목 하나를 직접 수정 또는 잠금 처리하게 한다. 그 뒤 아래 변경 원문을 추가하게 한다. 자료 관계는 `correction`으로 선택하고 대상은 Task 1의 원본 source로 지정한다.

```text
제주 워크숍 정정입니다. 참석자는 3명입니다. 숙소 체크인은 금요일 16:00입니다.
```

기대 관찰:

| 확인 항목 | 기록 |
| --- | --- |
| 참석자 변경과 인당 비용 재계산을 이해함 | pass / fail |
| 완료/잠금/수동 수정 상태가 사라지지 않음 | pass / fail |
| stale 또는 충돌 표시를 보고 다음 행동을 설명할 수 있음 | pass / fail |
| 참가자가 진행자 도움을 요청한 지점 | 자유 기록 |
| 소요 시간 | 분:초 |

### Task 3 - Source Conflict

참가자에게 아래 원문을 같은 여행 workspace에 추가하게 한다. 관계는 `addition`으로 선택하고 대상은 Task 1의 원본 source로 지정한다.

```text
숙소 담당자 추가 안내입니다. 참석자는 5명이라고 전달받았습니다. 기존 비용 공지는 아직 재확인 중입니다.
```

기대 관찰:

| 확인 항목 | 기록 |
| --- | --- |
| 출처 간 참석자 충돌 또는 확인 필요 상태를 인지함 | pass / fail |
| 충돌을 임의로 적용하지 않고 근거를 비교함 | pass / fail |
| 참가자가 keep/use 선택 의미를 설명할 수 있음 | pass / fail |
| 적용 전 미리보기와 실제 적용 결과가 일치함 | pass / fail |
| 소요 시간 | 분:초 |

### Task 4 - Assignment Deadline

새 workspace를 만들고 목적에는 `AI 데이터 과제 변경사항을 근거와 함께 정리한다`를 입력하게 한다. 아래 과제 원문을 넣고 제안이 준비되면 적용한다.

```text
AI 데이터 과제 안내입니다. 제출 마감은 11월 20일 23:59입니다. 제출물은 리포트입니다. 팀 수는 6팀입니다. 리포트 제출 전 실행 로그 확인이 필요합니다.
```

초기 제안을 적용한 뒤 `실행 로그 확인` checklist 항목을 완료 처리한다. 그 다음 아래 정정 원문을 추가하게 한다. 자료 관계는 `correction`으로 선택하고 대상은 과제 원본 source로 지정한다.

```text
AI 데이터 과제 정정입니다. 제출 마감은 11월 27일 23:59로 연장됩니다. 제출물은 실행 로그입니다.
```

기대 관찰:

| 확인 항목 | 기록 |
| --- | --- |
| 여행이 아닌 과제 업무에서도 같은 검토 흐름을 이해함 | pass / fail |
| 마감과 제출물 변경을 구분함 | pass / fail |
| 완료된 항목 삭제 또는 보호 충돌이 있을 때 의미를 이해함 | pass / fail |
| 부자연스러운 화면 이동/대기/재시도 지점 | 자유 기록 |
| 소요 시간 | 분:초 |

## Evidence Form

시험마다 아래 양식을 복사해 채운다. 원문 전체, 쿠키, API key, 모델 raw response는 기록하지 않는다.

| 필드 | 값 |
| --- | --- |
| Trial ID |  |
| Date / environment |  |
| Browser / device |  |
| Participant profile | 예: PM, backend engineer, non-engineer |
| Used live model | yes / no |
| Model calls attempted |  |
| Model calls failed / uncertain |  |
| Operator intervention count |  |
| Task 1 result / time |  |
| Task 2 result / time |  |
| Task 3 result / time |  |
| Task 4 result / time |  |
| Evidence clarity issues |  |
| Conflict/protection confusion |  |
| Data loss or wrong overwrite observed |  |
| Unexpected cost/latency issue |  |
| Follow-up fix required before next trial |  |

## Success Criteria

한 명의 trial을 통과로 볼 수 있는 최소 기준:

| 기준 | 통과선 |
| --- | --- |
| Completion | 4개 task를 모두 끝냄 |
| Evidence trust | 참가자가 최소 3개 변경에서 근거 원문을 확인함 |
| Protected state | 완료/잠금/수동 수정 중 하나 이상이 보존됨을 확인함 |
| Conflict handling | 충돌 또는 확인 필요 상태를 진행자 설명 없이 해결 방향까지 말함 |
| Safety | 원치 않는 조용한 덮어쓰기, 삭제, 개인정보 입력 없음 |
| Operations | failed/uncertain 발생 시 자동 반복 없이 원인과 비용을 기록함 |

## Decision Gate

다음 구현 단계로 넘어가기 전 gate:

| Gate | 진행 기준 |
| --- | --- |
| Usability | 최소 3명 이상이 주요 흐름을 진행자 개입 1회 이하로 완료 |
| Evidence | 참가자가 변경 근거와 적용 결과를 구분해서 설명 |
| Conflict | 출처 충돌에서 임의 병합보다 보류/선택을 이해 |
| Protection | 완료/잠금/수동 수정 보존 실패 0건 |
| Reliability | live call의 `failed`/`uncertain`은 모두 원인 기록과 ledger 보존 확인 |
| Product decision | 반복 혼란 지점이 있으면 기능 추가보다 UI copy/flow 수정으로 먼저 해결 가능성 평가 |

이 gate를 통과하기 전에는 "사용자 검증 완료", "대회 우위 입증", "통계적으로 유의한 성능"이라고 쓰지 않는다. 현재 stop condition은 trial 미실행이다.
