# Calendar 재확인 운영

현재 변경은 로컬 배포 후보에 포함되어 있다. 원격 migration·배포·실제 Google 확인 결과는 `PLANS.md`의 로컬 검증 기록과 구분한다.

## 대상과 동의

- 사용자가 승인해 `verified`로 끝난 Calendar 작업만 확인한다. 별도로 연결한 이어짐 전용 Calendar의 해당 이벤트만 읽는다.
- 수동 확인은 새 버튼 클릭으로 시작한다. 실행 당시 기록과 나중의 확인 시각/결과는 별도다.
- 반복 확인은 기본으로 꺼져 있다. 동의하고 켜면 15분 간격, 최대 24시간 확인한다. 작업 공간 만료와 일정 확인 범위의 끝이 더 빠르면 먼저 끝난다.
- 외부 변경/삭제, 원래 안내·계획 변경, 연결 해제/권한 변경은 자동 수정 사유가 아니다. 확인을 중단하고 재검토를 안내한다.
- 일시적인 읽기 실패는 최대 3회 연속 실패까지 제한된 backoff로 처리한다. 모델 호출, Calendar 쓰기, Gmail 발송은 수행하지 않는다.

## 데이터와 처리 경계

`recovery_actions`는 승인 및 실행 기록이다. `recovery_calendar_events`는 실행 직후 확인한 ID/etag/값이다. 새 `recovery_calendar_verifications`는 최신 관찰과 반복 확인 설정이다. 재확인으로 기존 실행 기록이나 etag를 덮어쓰지 않는다.

확인은 action ID, payload hash, 계정/소유자, workspace/source/condition revision, 연결 ID/auth version에 묶인다. DB claim으로 중복 실행을 제한하고 결과 저장 시 같은 기준인지 검사한다. 사용자가 끄거나 기준이 바뀐 뒤 돌아온 응답은 정상 결과로 채택하지 않는다.

비교 대상은 제목, 시작/끝 시각, 설명, 이어짐 식별 정보, etag다. 전체 캘린더나 다른 앱의 완료 상태까지 검사하지 않는다. `matched`는 **표시한 확인 시각에, 조회한 이벤트가 일치했다**는 뜻이다. 여러 이벤트의 Google 조회는 하나의 원자적 snapshot이 아니다.

## 배포 순서와 되돌리기

1. 독립 리뷰와 `npm run verify`, 브라우저 검증 결과를 확인한다.
2. 승인된 배포 작업에서 D1 backup/restore 지점을 확보하고 additive migration `0013_calendar_verification.sql`을 먼저 적용한다.
3. 새 Worker를 배포하고 기존 계정/원문/승인과 새 API를 확인한다. 테이블 없이 새 Worker부터 배포하면 recovery 조회가 실패한다.
4. 실제 연결 계정에서 별도 승인된 Calendar 실행을 대상으로 수동 확인, 외부 수정 감지, 반복 확인 끄기를 검증한다. 로컬 fake provider 결과를 이 검증의 대체 근거로 쓰지 않는다.
5. 롤백 시 먼저 반복 확인을 중지한다. 이전 Worker는 추가 테이블을 사용하지 않으므로 additive schema를 남길 수 있다. 코드 롤백이 외부 이벤트를 되돌리지는 않는다.

## 관측과 중지

Worker의 `calendar_verification` 로그에서 claim 수, 일치 수, 확인이 필요한 건수를 확인한다. `calendar_verification_failed`는 cron 처리 실패다. 원문, 이벤트 본문, OAuth 토큰은 로그로 남기지 않는다. 기존 유료 모델 run 복구와 별도 실패 경계로 실행한다.

운영 권한을 확인한 뒤 사용할 읽기 전용 SQL:

```sql
SELECT status, watch_enabled, COUNT(*) AS count
FROM recovery_calendar_verifications
GROUP BY status, watch_enabled;

SELECT action_id, status, checked_at, next_check_at, watch_expires_at,
       consecutive_failures, stopped_reason
FROM recovery_calendar_verifications
WHERE watch_enabled = 1 OR status IN ('drifted', 'unavailable', 'stale')
ORDER BY updated_at DESC LIMIT 50;
```

긴급 중지에는 별도 승인 후 모든 watch의 `watch_enabled=0`, `next_check_at=NULL`, `claim_token=NULL`, `claimed_at=NULL`을 설정한다. 진행 중 `checking`은 `unavailable`로 바꾸고 운영 중지 사유를 기록한다. 이미 전송한 읽기 요청까지 취소되지는 않지만 후속 조회와 결과 채택은 막아야 한다. 이 문서나 로컬 검증은 원격 변경 권한이 아니다.

반복 조회는 7일 미사용 보관 기간을 연장하지 않는다. 삭제된 작업 공간의 확인 기록은 외래 키 cascade로 제거한다. 외부 메일/슬랙 알림은 포함하지 않는다.

## 처리량과 장애 복구

- 기존 5분 cron이 한 번에 최대 5개 승인 건을 처리한다. 한 건은 최대 30개 이벤트, 전체 읽기 시간은 30초, 개별 조회는 최대 8초로 제한한다. 확인용 Queue나 새 유료 인프라는 추가하지 않았다.
- 정상 확인 뒤 15분 후를 다음 시각으로 예약한다. cron 시각과 공급자 지연에 따라 실제 확인은 늦어질 수 있다. 현재 상한으로 15분 주기를 유지할 수 있는 규모는 이론상 동시 watch 약 15건이며, 운영 부하 시험 결과가 아니다. 사용자가 늘면 아래 지연 지표를 보고 Queue 분리와 계정별 공정한 배분을 먼저 설계한다.
- 조회 실패 후 다음 확인은 15분, 60분 뒤로 늦춘다. 3회 연속 실패하면 중지한다. 최대 24시간, 작업 공간 만료, 계획 범위의 종료 중 가장 이른 시각을 넘기지 않는다.
- claim lease는 2분이다. Worker가 결과를 남기기 전에 종료되면 다음 cron이 미완료 claim을 실패로 기록하고 제한된 재확인 대상으로 돌린다. 늦은 응답은 기존 claim token으로 결과를 덮어쓸 수 없다.
- 수동 새 조회는 마지막 확인 후 60초 간격이다. 같은 request ID를 재전송하면 같은 확인 시각의 영수증을 돌려준다. 새 클릭은 새 ID이며 이 경우에만 새 조회를 요청한다. 작업 공간의 recovery 요청 영수증 상한은 200개다. 상한에 도달해도 사용자의 반복 확인 중지는 막지 않는다.
- 진행 중 확인을 중지하면 이번 결과를 채택하지 않고 과거 일치 문구를 현재 결과로 재사용하지 않는다. 기존 `recovery_actions`의 실행 성공 이력은 보존한다.

예약 지연 확인 SQL (읽기 전용):

```sql
SELECT COUNT(*) AS overdue_watches,
       MAX(unixepoch('now') - unixepoch(next_check_at)) AS oldest_due_seconds
FROM recovery_calendar_verifications
WHERE watch_enabled = 1 AND next_check_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
```

오래된 예약이 연속 cron에서도 줄지 않으면 공급자 실패와 처리량을 함께 확인한다. 단순히 한도를 올리기 전에 Worker 실행 시간, Google quota와 D1 읽기량을 측정한다. 현재 외부 알림과 대규모 처리량 보장은 없다.

## 수동 인수 확인

1. 작업 공간의 원문 화면에서 짧은 안내를 복사해 가져온다. 미리보기만 열었을 때 초안은 유지되어야 한다. 가져오기만으로 저장이나 AI 호출이 발생하면 안 된다.
2. 저장한 일정 조정안에서 계산, 이어짐 적용, Calendar 반영, 이후 확인이 서로 구분되는지 확인한다.
3. 실제 Google 검증은 별도 승인된 계정·실행 건으로 수행한다. 재확인 결과에 조회 시각과 이벤트별 차이가 보여야 한다. Google에서 사용자가 직접 수정한 이벤트를 이어짐이 임의로 되돌리면 안 된다.
4. 반복 확인은 처음 꺼져 있어야 한다. 동의 후 켜고, 중지 후 새로고침해도 꺼진 상태인지 확인한다. 기준이 오래되어 수동 확인이 막힌 경우에도 중지 버튼은 사용할 수 있어야 한다.
5. 로그에서 모델 호출·Calendar 쓰기·메일 발송이 추가되지 않았는지 확인한다. 로컬 테스트의 mock 응답과 실제 Google 검증 결과를 별도로 기록한다.
