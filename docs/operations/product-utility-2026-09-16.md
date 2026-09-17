# 2026-09-16 사용성 개선 배포 범위

동일 canonical Worker에 코드와 정적 자산을 배포한다. DB migration, 보관 기간, 요금제, 예산, OAuth 권한, Calendar/email 실행 계약은 바꾸지 않는다.

- 완료한 항목의 내용/의존 사실이 변경되면 기존 completed 기록을 보존하고 stale로 재확인을 요청한다. 체크리스트의 일반 수정은 확인을 대체하지 않는다. 재시작은 기존 PATCH에서 completed:false와 acknowledgeReview:true를 원자적으로 저장한다.
- Setup은 명시적으로 연결된, 검증 가능한 날짜/시간과 저장된 준비 시간만 자동 입력한다. 사용자 수정과 의도적으로 지운 값은 보존한다. 종료 시각, 이동, 가용 시간은 추측하지 않는다.
- 새 홈페이지 체험은 실제 core를 메모리에서 사용하며 모델 호출/저장을 하지 않는다. 기존 충돌 체험은 펼침 영역에 남는다.
- 새 로컬 효용 비교 도구는 입력부터 확인까지의 전체 시간을 기록한다. 실제 참가자 측정 없이 절약 시간을 게시하지 않는다.

## 검증 및 배포

Root가 verify와 browser runner를 단독 소유한다. 고정 기준과 독립 리뷰 이후 기존 배포 권한 범위에서 실행한다. `artifacts/product-utility-2026-09-16/`에 측정/로컬/공개 기록을 남긴다. 모델 측정은 별도 호출 예약으로만 시행하며 실패와 원본을 보존한다.

공개 스모크 생성 예산: fixture workspace 1개, 유료 모델 0회, 외부 작업 0회. 운영 상태를 읽어 용량을 확인한다. 스모크가 생성한 ID 하나만 삭제하고 404로 확인한다. 기존 사용자 workspace, verified Calendar action, 누적 admission/budget ledger는 그대로 둔다. 오늘 UTC 생성0/200, 활성4, 내용56,258bytes에서 시작한 read-only preflight는 별도 JSON에 보관한다.

복구: 스키마 변경이 없으므로 이전 Worker version으로 되돌릴 수 있다. 이미 저장한 stale/completed는 기존 스키마 필드이며 데이터 migration은 필요 없다. 다만 이전 바이너리는 이번 재확인 보장을 제공하지 않으므로 이전 동작으로 되돌아간다는 점을 기록해야 한다. 외부 Calendar 결과나 예산 원장은 이 작업의 롤백 대상이 아니다.
