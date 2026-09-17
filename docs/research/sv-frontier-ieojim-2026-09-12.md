# SF/SV frontier AI 흐름에서 이어짐이 뽑아야 할 것

## 1. 방법과 기준선

이 문서는 2026년 9월 12일 KST 기준으로 공개 웹 자료와 현재 프로젝트 문서를 읽어 만든 제품 리서치와 브레인스토밍 기록이다. 투자사 글은 창업자 관점의 논지, 제품 릴리스는 해당 회사가 공개한 기능 설명으로 취급했다. 업계 전체를 망라한 조사가 아니라 SF/SV와 관련 제품의 원문을 선별한 조사다. 실제 구현·검증·배포 상태는 `PLANS.md`와 `DESIGN.md`의 최신 체크포인트를 따른다. 아래 연구 확장 후보는 구현 완료 기능과 구분한다.

판단의 중심은 하나다. 이어짐은 범용 OS나 만능 비서로 방향을 바꾸면 안 된다. 지금 가장 강한 후보는 **여행 총무를 위한 “근거와 선택 영향이 보이는 변경 검토”**다. 기존 계획, 새 안내, 사용자의 수동 편집·완료·잠금, 정확한 기준 revision, 원문 인용, 결정론적 계산과 원자적 적용을 연결하는 엔진이 이미 있다. 최신 SF/SV 흐름에서 가져올 것은 더 큰 이름의 에이전트가 아니라, 이 흐름을 사용자가 믿고 빠르게 검토하게 만드는 제품 표면이다.

## 2. 외부 신호가 실제로 말하는 것

YC의 Fall 2026 RFS는 AI가 물리 세계와 실제 업무 시스템으로 들어간다고 본다. 같은 페이지에서 “Small Software”, “Multiplayer AI”, “New Operating Systems for the Physical World”가 함께 등장한다.[1] 여기서 이어짐에 유효한 신호는 “모든 것을 운영하는 OS를 만들라”가 아니다. 작은 팀이나 개인이 자기 문제에 맞는 도구를 쉽게 만들고 공유하려는 욕구, AI 작업을 혼자 쓰는 채팅에서 여럿이 보는 작업 상태로 옮기려는 욕구, 실제 세계 작업의 신뢰성과 측정 가능성을 요구하는 흐름이 강하다는 점이다. 이어짐이 오늘 할 수 있는 대응은 협업 런타임이 아니라 **검토 가능한 상태와 결정의 공유 가능성**이다.

Sequoia의 2026년 글들은 장기 작업 에이전트와 하네스를 강조한다.[2][3] 다만 이 글들은 VC thesis다. “2026년은 AGI”라는 제목을 제품 검증으로 읽으면 안 된다. 유효한 부분은 애플리케이션 레이어가 모델의 한계를 감싸는 하네스를 설계해야 한다는 주장이다. 이어짐의 기존 구조는 이 방향과 잘 맞는다. 모델은 원문에서 구조화된 사실과 제안을 만들고, 코드가 근거 위치, 계산, 권한, 보호 상태, 기준 revision을 검증한다. 이는 “모델이 똑똑해졌으니 맡기자”가 아니라 “모델 출력이 좋아져도 적용 권한은 검증된 시스템에 남긴다”는 구조다.

a16z의 AI 앱 글은 지식 작업 도구가 실행 중심에서 탐색과 사고를 돕는 방향으로 넓어지고, AI 앱이 모델 오케스트레이션·도메인 UI·넓은 기능 표면을 결합하면서 모델 자체와 달라질 수 있다고 본다.[4] SAP 글은 시스템 오브 레코드 위에 승인, 감사, RBAC, 의미 모델을 갖춘 “system of action”이 생긴다고 해석한다.[5] 컴퓨터 사용 에이전트 글은 벤치마크 점수가 높아져도 실제 업무 자동화에서는 검증, 예외 처리, 에스컬레이션이 핵심이라고 못 박는다.[6] 이어짐에는 “브라우저를 클릭하는 에이전트”보다 “바뀐 원문이 현재 결정에 미치는 영향만 안전하게 적용하는 얇은 행동층”이 더 잘 맞는다.

실제 제품 릴리스도 비슷하다. Linear Agent는 workspace의 roadmap, issues, code 맥락을 바탕으로 요약·추천·행동을 돕고, recurring workflow를 skill로 저장한다.[7] Priority Inbox는 알림을 Priority와 Other로 나누되 사용자가 필터를 조정할 수 있게 한다.[8] Notion은 에이전트가 직접 수정하는 대신 제안을 만들고 사용자가 위에서 아래로 승인하는 흐름을 공개했다.[9] Granola는 에이전트가 읽은 범위와 한계를 보여주는 Coverage Notes를 강조한다.[10] 이 흐름을 이어짐으로 번역하면 “AI가 알아서 고쳐준다”가 아니라 “AI가 무엇을 보았고, 무엇을 바꾸자고 하며, 사용자가 무엇을 유지하도록 선택했는지 보인다”다.

기술 블로그들은 같은 결론을 운영 언어로 말한다. Anthropic의 Managed Agents 글은 session, harness, sandbox를 분리하고, 세션 로그를 하네스 밖에 두어 실패 후 재개할 수 있게 한다.[11] Google ADK 글은 장기간 agent workflow에서 raw chat history를 계속 붙이는 방식 대신 명시적 상태 기계와 durable session을 쓰라고 설명한다.[12] OpenAI의 agent eval 문서는 trace, grader, dataset, eval run으로 workflow 단위의 실패를 잡는 방식을 제시한다.[13] METR의 2026년 설문은 AI 생산성 체감이 크다는 신호를 주지만, 편의 표본·자기보고·선택 편향의 한계를 같이 드러낸다.[14] 따라서 이어짐의 제출 주장은 “AI 시대에 생산성이 몇 배 오른다”가 아니라 “우리가 정의한 변경 검토 작업에서 필요한 변경, 불필요한 변경, 검토 시간, 보호 손실을 측정하겠다”여야 한다.

## 3. 이어짐의 현재 강점과 약한 고리

이어짐의 강점은 최신 트렌드의 이름을 따라가는 것이 아니라 이미 생산 시스템처럼 생각하고 있다는 점이다. 원문은 불변 source로 저장된다. AI는 구조화된 fact와 change proposal을 만든다. 결정론적 코드는 evidence quote, source relation, 계산, manual edit, locked decision, completed checklist, exact revision을 검증한다. 사용자는 conflict를 고르고, 승인된 bundle은 기준 revision이 맞을 때 atomic하게 적용된다. model failure가 기존 상태를 덮어쓰지 않고, 불확실한 유료 호출은 자동 재호출하지 않는다는 운영 계약도 있다.

약한 고리는 세 가지다. 첫째, 사용자가 이 차이를 30초 안에 이해하지 못하면 기술 강점이 제품 가치로 전환되지 않는다. 둘째, 여행 계획 변경은 고통이 구체적이지만 빈도가 낮을 수 있다. 셋째, 검토 화면이 더 똑똑해질수록 사용자는 “또 확인해야 할 것”이 늘었다고 느낄 수 있다. 최신 제품들이 제안, 우선순위, coverage, approval을 강조하는 이유도 여기에 있다. AI 기능의 양보다 **검토 부담을 줄이는 설계**가 더 중요하다.

따라서 이번 주 남은 48시간의 질문은 “어떤 새 AI 기능을 더 붙일까”가 아니다. “이미 존재하는 변경 검토 엔진이 사용자에게 극단적으로 유용해 보이려면 무엇을 보여주고, 무엇을 숨기고, 무엇을 측정해야 하는가”다.

## 4. 추천 포지션

첫 문장은 이렇게 좁히는 편이 낫다.

> 새 안내가 오면, 이미 합의한 여행 계획에서 바꿀 항목과 유지할 결정을 근거와 함께 검토합니다.

이 문장은 AI 운영체제, 협업 에이전트, 여행 플래너, 문서 편집기라는 오해를 피한다. 사용자는 이미 계획을 갖고 있고, 새 안내 때문에 무엇을 바꿔야 할지 확인해야 한다. 이어짐은 여행지를 추천하거나 예약하지 않는다. 대신 “900,000원은 그대로, 인원은 4명에서 3명, 1인 부담은 225,000원에서 300,000원, 첫날 도착 10:00은 16:00으로 변경”처럼 현재 결정에 대한 영향만 좁게 다룬다. 둘째 날 19:00 저녁은 새 안내와 직접 근거 관계가 없으면 변경 대상으로 꾸미지 않는다. 잠금 보호는 별도 충돌 근거가 들어왔을 때 승인 없는 덮어쓰기를 막는 장치로 설명한다.

이 포지션은 VC 글의 “system of action”을 소규모 소비자/팀 문제로 낮춘 것이다. 시스템 오브 레코드가 SAP라면 이어짐의 기록 시스템은 사용자가 붙여 넣은 원문, 현재 plan revision, 수동 결정, source catalog revision이다. 행동은 항공편 예약이나 메시지 발송이 아니라 승인된 변경 bundle 적용이다. 작지만 프로덕션스럽다.

## 5. 제품 아이디어 12개

| 번호 | 아이디어 | 분류 | 사용자 효과 | 필요한 데이터 | 실패 조건 | 결정 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 실제 typed dependency 기반 영향 지도 | 연구 확장 후보 | 어떤 항목이 왜 바뀌는지 한눈에 본다 | factKeys, calculation refs, item links, protected ledger | plain string reason을 dependency처럼 꾸미면 신뢰 하락 | 제출 전 후보 |
| 2 | Side-by-side what-if preview | 연구 확장 후보 | 특정 선택을 바꾸면 결과가 어떻게 달라지는지 본다 | 현재 proposal, selected resolutions, deterministic resolver | 모든 조합을 2^n으로 펼치거나 LLM을 재호출하면 비용·복잡도 증가 | 제출 전 후보 |
| 3 | Context coverage panel | 연구 확장 후보 | AI가 사용한 원문과 한계를 확인한다 | source ids, cited quotes, target source relation, validation errors | 95% confidence 같은 근거 없는 숫자를 붙이면 위험 | 제출 전 후보 |
| 4 | 승인 후 변경 요약 복사 | 기존 확장 | 총무가 카톡/노션에 붙일 확정 변경만 얻는다 | persisted approved revision, before/after summary | pending proposal을 확정처럼 복사하거나 개인정보 제거를 과장 | 이미 P4 범위 |
| 5 | Decision memory with reason/revoke/expiry | 새 가설 | “왜 잠갔는지”와 언제 다시 검토할지 남긴다 | lock reason, source/evidence, expiry/revoke event | 잠금이 영구 진실처럼 굳어 schema drift 유발 | 제출 후 |
| 6 | Preference feedback, not truth feedback | 새 가설 | 사용자는 “다음엔 이렇게 보여줘”를 남긴다 | UI preference, display grouping, verbosity | 피드백을 모델 정답 라벨이나 자동학습으로 오해 | 제출 후 |
| 7 | Repeated change digest | 새 가설 | 여러 안내가 온 뒤 누적 변경만 본다 | source order, revision diff, accepted bundle history | event-time이 없는 자료를 시간 진실처럼 해석 | 제출 후 |
| 8 | Group-ready review link | 새 가설 | 동행자가 읽을 수 있는 안전한 요약을 본다 | share scope, redaction policy, auth | 협업 권한·원문 노출을 설계하지 않고 공개 링크 생성 | 보류 |
| 9 | Role-based collaboration | 새 가설 | 총무, 비용 담당, 일정 담당이 각자 선택한다 | account identity, role permissions, conflict ownership | 실제 사용자 시험 전 협업 UI가 복잡도만 증가 | 시험 후 |
| 10 | Multimodal itinerary ingestion | 새 가설 | 캡처 이미지나 PDF 공지를 넣는다 | OCR, image provenance, quote mapping | 원문 위치와 증거 추적이 약해짐 | 드롭/후순위 |
| 11 | Agent booking or payment | 새 가설 | 변경 적용 후 예약/정산까지 한다 | external credentials, idempotency, refund policy | 외부 부작용과 비용·책임 폭증 | 드롭 |
| 12 | Generic vector DB memory | 새 가설 | 많은 원문에서 관련 내용을 찾는다 | embedding, recall eval, deletion policy | exact source relation보다 흐릿한 검색을 먼저 도입 | 드롭 |

상위 세 개는 서로 연결되지만, 모두 현재 완성 기능으로 쓰면 안 된다. 현재 제품에는 impact summary와 선택된 resolution의 적용 preview 성격이 이미 있다. 여기서 말하는 typed dependency 영향 지도, 완전한 side-by-side what-if, coverage panel은 그 기반을 더 명시적으로 연구·확장하는 후보이다. 세 기능 모두 새 모델 호출 없이 기존 proposal과 deterministic resolver 위에서 작동해야 하며, 구현하지 못한 경우 제출 문구에서는 “현재 기능”으로 부르지 않는다.

## 6. 영향 지도는 새 지식 그래프가 아니다

가장 위험한 유혹은 “의존성 그래프”라는 말을 붙이고 실제로는 현재 문자열 사유를 선으로 그리는 것이다. 현재 질문·사유가 plain string이면 그것만으로 “도착 시간이 저녁 약속에 영향을 준다” 같은 관계를 만들어서는 안 된다. 도착 시간, 인원, 총액, 분담금처럼 typed fact와 calculation reference가 있는 항목부터 시작해야 한다. 일정 항목도 직접 참조가 있을 때만 영향으로 보이고, 나머지는 “AI가 제안했지만 결정론적 의존성은 없음”으로 구분해야 한다.

제품적으로는 지도보다 목록이 나을 수 있다. 예를 들어 “비용: 인원 4→3 때문에 1인 부담 225,000→300,000”, “일정: 첫날 도착 10:00→16:00”, “유지: 둘째 날 19:00 저녁은 이번 원문에서 직접 변경 근거 없음”처럼 사용자가 검토할 단위로 보여준다. 해당 저녁 일정이 잠긴 상태라면 “잠금이라 충돌 증거 없이 자동 변경하지 않음”을 별도로 표시한다. 그래프는 설명 장면이나 접기 가능한 보조 UI로 충분하다.

## 7. What-if는 조합 폭발이 아니라 선택 하나의 결과다

Side-by-side what-if는 “모든 가능한 미래”가 아니다. 사용자가 충돌 A에서 “내 결정 유지”와 “새 안내 반영” 중 하나를 바꿨을 때, 다른 선택은 고정하고 결과 preview를 다시 계산하는 것이다. 이렇게 하면 추가 LLM 호출 없이 `resolveChangeSet`에 가까운 deterministic engine으로 처리할 수 있다. 비용과 latency도 안정적이고, 결과가 틀리면 엔진 테스트로 잡을 수 있다.

이 기능의 좋은 문구는 “다른 선택은 그대로 두고 이 결정만 바꿔 보기”다. 나쁜 문구는 “AI가 최적 조합 추천”이다. 최적화 목표가 없고, 총무가 무엇을 우선하는지 모르면 추천은 쉽게 오만해진다. 이어짐은 선택지를 줄이고 결과를 보이게 하면 된다.

## 8. Coverage는 confidence score보다 낫다

Granola의 Coverage Notes가 유효한 이유는 완벽한 답을 주장하지 않고, 무엇을 봤고 무엇을 덜 봤는지 보여주기 때문이다.[10] 이어짐도 confidence 95% 같은 숫자를 만들 필요가 없다. 대신 “사용한 원문 2개”, “직접 인용 4개”, “계산은 코드 검증 통과”, “시간대가 없는 날짜는 질문 필요”, “이 제안은 현재 source revision 기준”처럼 시스템이 실제로 아는 것을 보여준다.

이 coverage는 심사와 제품 양쪽에서 좋은 후보이지만, 아직 검토 시간을 줄인다는 측정 결과는 없다. 가설은 “사용자가 근거와 한계를 더 빨리 판단할 수 있다”이며, 실제 효과는 사용자 시험의 review time과 오류율로 확인해야 한다. OpenAI eval 문서의 trace 사고와도 맞는다.[13] 단, 내부 prompt나 private run metadata를 노출하지 않는다. 사용자가 보는 것은 원문 근거, validation 상태, 적용 기준뿐이다.

## 9. P1 비교 실험의 정확한 주장

P1의 비교는 “이어짐이 ChatGPT/Notion보다 우수하다”를 증명하지 않는다. 현재 하네스의 full/regenerate와 incremental은 같은 보호 엔진을 거친다. 따라서 비교 가능한 것은 같은 모델, 같은 corpus, 같은 보호 엔진 아래에서 전략별 필요한 변경 반영, 누락, 과잉 변경, 보호 손실, 질문/충돌, 비용, 지연이다. 이 한계를 먼저 말하면 신뢰가 올라간다.

공정한 실험 문장은 이렇다. “12개 고정 한국어 합성 변경 사례에서, 같은 모델과 같은 보호 엔진으로 전체 재생성과 변경 중심 제안을 비교했다. 우리는 필요한 업데이트, 불필요한 변경, 검토 질문, 보호 상태 손실, 비용과 지연을 함께 측정했다.” 결과가 동률이면 동률로 적는다. VC 글이나 제품 릴리스로 시장 수요를 증명하지 않는다.

## 10. 지금 미뤄야 할 것

멀티모달 입력은 매력적이지만 evidence quote와 source position 검증을 약하게 만들 수 있다. 예약, 결제, 메시지 발송은 외부 부작용과 환불·권한·재시도 정책을 요구한다. generic vector DB는 작은 source catalog와 exact source relation이 먼저인 현재 구조에 비해 운영 복잡도를 키운다. multi-agent runtime은 독립 하위 작업이 실제로 생기고 single-model 대비 품질 이득이 반복 평가로 확인될 때 검토한다. collaborative roles도 최소 3명 이상의 사용자 시험에서 실제 병목이 보인 뒤 설계해야 한다.

미루는 것은 소극적인 선택이 아니다. 생산 수준의 데이터 플랫폼 관점에서는 데이터 계약, lineage, idempotency, backfill 가능성, observability 없이 표면만 넓히는 것이 더 큰 리스크다. 이어짐은 현재 좁은 범위 안에서 “AI가 제안하고, 시스템이 검증하고, 사용자가 승인하고, 정확한 revision에 적용한다”는 계약을 선명하게 만드는 편이 더 강하다.

## 11. 세 가지 실패 모드

첫째, 기존 도구로 충분할 수 있다. ChatGPT Projects는 chats, files, instructions를 한 workspace에 묶고, shared projects에서 팀원이 같은 context hub를 볼 수 있게 한다.[15] Wanderlog는 일정, 지도, 예약 import, 실시간 협업, 예산·비용 분담, checklist와 AI 기능을 이미 여행 계획 표면에 갖고 있다.[16][17] Notion과 Linear도 승인형 AI 기능을 빠르게 흡수하고 있다. 이어짐이 이기려면 “승인 버튼이 있다”가 아니라 “여행 변경처럼 계산·보호·근거가 얽힌 좁은 변경 검토에서 기존 도구보다 덜 틀리고 덜 번거로운가”를 보여야 한다.

둘째, 여행 변경 문제의 빈도와 retention이 위험할 수 있다. 다만 매주 쓰지 않아도 sustainable한 계절성·고관여 제품은 가능하다. 문제는 빈도 자체보다, 사용자가 다음 여행이나 다음 그룹 계획 때 다시 떠올릴 만큼 변경 검토 가치가 크고 데이터 보존·공유 정책이 맞는가다. 그래서 제출에서는 여행 총무를 첫 고객으로 좁히되, 장기 확장은 행사 운영·과제 마감·가족 돌봄 일정처럼 “합의된 계획이 새 공지로 바뀌는” 반복 영역에서 검증해야 한다.

셋째, 새 UI가 오히려 검토 부담을 늘릴 수 있다. 영향 지도, coverage, what-if가 모두 펼쳐져 있으면 사용자는 “AI가 도와주는 게 아니라 감사 보고서를 읽으라는 건가”라고 느낄 수 있다. 기본 화면은 필수 변경과 보존된 결정만 보여주고, 근거와 coverage는 필요할 때 펼치는 쪽이 낫다.

## 12. 공정하고 반증 가능한 실험

실험은 사용자 3명 이상, 실제 사람 검토로 시작한다. 이는 실패 발견과 제품 언어 검증을 위한 작은 trial이지, 시장성이나 통계적 우위를 증명하기에 충분한 표본이 아니다. 또한 현재 프로젝트 상태에서는 외부 사용자 모집과 trial이 사용자 결정에 따라 유예되어 있으므로, 제출 전 완료 사실로 쓰면 안 된다. 외부 webhook이나 자동 메시지 발송은 이번 실험에 넣지 않는다. 참가자에게 기존 계획과 새 안내를 주고, 이어짐과 기존 방식 중 하나 또는 둘 다로 처리하게 한다. 측정 항목은 네 가지다.

1. 꼭 필요한 업데이트가 반영됐는가.
2. 바꾸면 안 되는 항목이 바뀌지 않았는가.
3. 의도하지 않은 변경이나 근거 없는 변경이 있었는가.
4. 사용자가 검토와 승인에 쓴 시간이 줄었는가.

정성 질문은 “다시 쓸 이유가 있었는가”, “무엇이 불안했는가”, “어떤 화면이 불필요했는가”로 충분하다. 만족도 점수만으로 성공을 말하지 않는다. 소수 시험은 시장 통계가 아니라 실패 발견 장치다. METR 설문처럼 자기보고 생산성은 유용한 신호지만 과장 가능성이 있으므로, 이어짐은 task outcome과 review time을 함께 기록해야 한다.[14]

## 13. 남은 48시간의 선택

9월 12일부터 19일까지 하루 6시간 기준 남은 실작업은 48시간이다. 새 아이디어를 전부 넣을 시간이 아니라, 이미 승인된 P0–P5를 더 날카롭게 만드는 시간이다. 추천 순서는 다음과 같다.

1. P0 용량과 실패 안내를 먼저 닫는다. 공개 서비스에서 AI가 안 될 때 정직하게 멈추는 것도 제품 신뢰다.
2. P1 실험은 shared-engine limitation을 문서 첫머리에 넣고, 불리한 결과도 남긴다.
3. P2/P3는 현재 impact summary와 selected-resolution preview를 더 정확한 문구와 배치로 개선하는 것을 기본 목표로 둔다. typed dependency 영향 지도, 완전한 side-by-side what-if, coverage panel은 시간이 허용될 때만 들어가는 연구 확장 후보이며, 미구현이면 제출 자료에서 제외한다.
4. P4 복사는 approved revision의 확정 요약만 다룬다. 외부 전송은 하지 않는다.
5. P5 제출 문구는 시장 검증, 인간 시험, 경쟁 우위, 장기 보관, 결제, webhook을 완료 사실로 쓰지 않는다.

## 14. 결론

SF/SV의 뜨거운 흐름을 한 문장으로 요약하면 “채팅에서 상태 있는 작업으로, 데모에서 검증 가능한 행동으로”다. 이어짐은 이 흐름을 쫓아 큰 에이전트 플랫폼으로 바뀔 필요가 없다. 이미 가진 강점은 상태, 근거, revision, 보호된 결정, atomic apply다. 남은 일은 이 강점을 여행 총무가 이해하는 화면과 공정한 실험으로 바꾸는 것이다.

가장 일관된 연구 확장 묶음은 세 가지다. 실제 typed dependency로만 만든 영향 표시, 다른 선택을 고정한 bounded what-if, 실제 사용한 원문과 한계를 보여주는 context coverage. 현재 제품에는 이 방향의 일부 재료가 있지만 세 후보가 모두 완성된 것은 아니다. 지금은 기능 이름을 앞세우는 시간이 아니라, 이미 있는 impact/review/preview가 왜 믿을 만한지 짧고 정확하게 보여주고, 확장 후보는 구현된 만큼만 주장하는 시간이다.

## 주석

[1] Y Combinator, “Requests for Startups,” Fall 2026 섹션, 페이지 자체는 날짜 없는 RFS 페이지이며 2026-09-12 확인. https://www.ycombinator.com/rfs

[2] Sequoia Capital, Team Sequoia, “AI Ascent 2026,” 2026-05-08. https://sequoiacap.com/article/ai-ascent-2026

[3] Sequoia Capital, “2026: This is AGI,” 2026-01-14. https://sequoiacap.com/article/2026-this-is-agi

[4] Andreessen Horowitz, Anish Acharya, “Notes on AI Apps in 2026,” 2026-01-08. https://a16z.com/notes-on-ai-apps-in-2026/

[5] Andreessen Horowitz, Eric Zhou and Seema Amble, “Why the World Still Runs on SAP,” 2026-03-16. https://a16z.com/why-the-world-still-runs-on-sap/

[6] Andreessen Horowitz, Fabrizio Serafini, Seema Amble, and Eric Zhou, “Can Agents Use a Computer Yet? We’ve Got the Data,” 2026-08-10. https://a16z.com/can-agents-use-a-computer-yet-weve-got-the-data/

[7] Linear, “Introducing Linear Agent,” 2026-03-24. https://linear.app/changelog/2026-03-24-introducing-linear-agent

[8] Linear, “Priority inbox,” 2026-09-03. https://linear.app/changelog/2026-09-03-priority-inbox

[9] Notion, “Ask your agent to suggest edits,” 2026-08-28. https://www.notion.com/releases/2026-08-28

[10] Granola, Toby, Robert, Xiuting, “How Granola thinks about designing agents,” May 6, 페이지에 연도 표기는 없고 2026년 맥락의 현재 사이트로 2026-09-12 확인. https://www.granola.ai/blog/how-granola-thinks-about-designing-agents

[11] Anthropic, “Scaling Managed Agents: Decoupling the brain from the hands,” 2026-04-08. https://www.anthropic.com/engineering/managed-agents

[12] Google Developers Blog, “Build Long-running AI agents that pause, resume, and never lose context with ADK,” 2026-05-12. https://developers.googleblog.com/build-long-running-ai-agents-that-pause-resume-and-never-lose-context-with-adk/

[13] OpenAI API Docs, “Evaluate agent workflows,” 날짜 표기 없는 현재 문서로 2026-09-12 확인. https://developers.openai.com/api/docs/guides/agent-evals

[14] METR, Joel Becker, “Measuring the Self-Reported Impact of Early-2026 AI on Technical Worker Productivity,” 2026-05-11. https://metr.org/blog/2026-05-11-ai-usage-survey/

[15] OpenAI Help Center, “Projects in ChatGPT,” updated 26 days before 2026-09-12 retrieval. https://help.openai.com/en/articles/10169521-using-projects-in-chatgpt

[16] Wanderlog, “Wanderlog travel planner: free vacation planner and itinerary app,” 현재 제품 페이지, 2026-09-12 확인. https://wanderlog.com/

[17] Google Play, “Wanderlog - Trip Planner App,” updated 2026-08-31. https://play.google.com/store/apps/details?hl=en&id=com.wanderlog.android

## Source Inventory

| 번호 | Publisher | Title | Date | URL |
| --- | --- | --- | --- | --- |
| 1 | Y Combinator | Requests for Startups | 페이지 날짜 없음; Fall 2026 섹션 확인 | https://www.ycombinator.com/rfs |
| 2 | Sequoia Capital | AI Ascent 2026 | 2026-05-08 | https://sequoiacap.com/article/ai-ascent-2026 |
| 3 | Sequoia Capital | 2026: This is AGI | 2026-01-14 | https://sequoiacap.com/article/2026-this-is-agi |
| 4 | Andreessen Horowitz | Notes on AI Apps in 2026 | 2026-01-08 | https://a16z.com/notes-on-ai-apps-in-2026/ |
| 5 | Andreessen Horowitz | Why the World Still Runs on SAP | 2026-03-16 | https://a16z.com/why-the-world-still-runs-on-sap/ |
| 6 | Andreessen Horowitz | Can Agents Use a Computer Yet? We’ve Got the Data | 2026-08-10 | https://a16z.com/can-agents-use-a-computer-yet-weve-got-the-data/ |
| 7 | Linear | Introducing Linear Agent | 2026-03-24 | https://linear.app/changelog/2026-03-24-introducing-linear-agent |
| 8 | Linear | Priority inbox | 2026-09-03 | https://linear.app/changelog/2026-09-03-priority-inbox |
| 9 | Notion | Ask your agent to suggest edits | 2026-08-28 | https://www.notion.com/releases/2026-08-28 |
| 10 | Granola | How Granola thinks about designing agents | May 6; year absent on page | https://www.granola.ai/blog/how-granola-thinks-about-designing-agents |
| 11 | Anthropic | Scaling Managed Agents: Decoupling the brain from the hands | 2026-04-08 | https://www.anthropic.com/engineering/managed-agents |
| 12 | Google Developers Blog | Build Long-running AI agents that pause, resume, and never lose context with ADK | 2026-05-12 | https://developers.googleblog.com/build-long-running-ai-agents-that-pause-resume-and-never-lose-context-with-adk/ |
| 13 | OpenAI API Docs | Evaluate agent workflows | 날짜 없음; 현재 문서 확인 | https://developers.openai.com/api/docs/guides/agent-evals |
| 14 | METR | Measuring the Self-Reported Impact of Early-2026 AI on Technical Worker Productivity | 2026-05-11 | https://metr.org/blog/2026-05-11-ai-usage-survey/ |
| 15 | OpenAI Help Center | Projects in ChatGPT | Updated 26 days before 2026-09-12 retrieval | https://help.openai.com/en/articles/10169521-using-projects-in-chatgpt |
| 16 | Wanderlog | Wanderlog travel planner: free vacation planner and itinerary app | 날짜 없음; 현재 제품 페이지 확인 | https://wanderlog.com/ |
| 17 | Google Play | Wanderlog - Trip Planner App | Updated 2026-08-31 | https://play.google.com/store/apps/details?hl=en&id=com.wanderlog.android |
