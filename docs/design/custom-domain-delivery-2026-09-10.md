# IEOJIM 도메인 연결 전달 기록

2026-09-10: 승인된 **https://ieojim.jungseongheon.org** 본주소와 **https://jungseongheon.org/ieojim** 바로가기를 연결했다. 실제 최종 배포 버전은 `c79b2cbc-8598-4604-8d0f-a6a41c3a105c`다. 영문 이름 IEOJIM과 보조 문구 `Plans change. Your decisions stay.`를 한글 랜딩에 추가했다.

## 결과

- 기존 `ieojim-staging` Worker·D1·Queue와 운영 한도를 유지했다. 새 DB·Queue·유료 플랜·패키지·마이그레이션은 없다.
- `/ieojim`, `/ieojim/`의 GET/HEAD만 본주소로 302 이동한다. 쿼리는 전달하지 않고, 유사 경로·POST·기존 포트폴리오 경로는 포함하지 않는다.
- 기존 workers.dev도 유지한다. 배포 전 생성한 합성 게스트 작업은 배포 후 기존 주소에서 읽기 200, 새 주소에서는 404였고, 검증 후 삭제했다. 쿠키 범위를 넓히거나 데이터 소유권을 이전하지 않았다.
- 기존 포트폴리오의 DNS·Worker 경로·RUM 설정을 보존했다. 본문·주요 자산·유사 경로 5개 응답의 상태와 해시가 일치했다. 새 도메인의 DNS와 신뢰 가능한 TLS 연결도 확인했다.
- 실제 Google 로그인은 여전히 비활성이다. 새 callback 주소만 운영 문서에 반영했으며 실제 활성화 전 기존 게스트 이동 정책을 검증해야 한다.

## 검증과 수정

최종 타입·린트·빌드·staging dry-run을 통과했다. Worker 번들은 2699.70 KiB raw / 462.51 KiB gzip이다. **새 도메인 Chromium 13개와 기존 주소 Chromium 9개, 총 22개가 통과**했다. 여행 변경·고정 충돌·과제 변경·내보내기·소유권·상위 도메인 Origin 거절·모바일 320px·WebGL·HTTP 보안 헤더·리디렉션 범위를 확인했다. 이번 변경에서 이전 A2의 201 단위/156 통합/53 로컬 브라우저 검사를 재실행한 것은 아니다.

첫 실행 구성에서는 `defineConfig(base, override)`가 이름이 다른 두 프로젝트를 병합하여 검사를 중복 등록했다. 실행을 중단하고 하나의 객체로 덮어쓰도록 수정했으며, 단일 프로젝트를 확인한 뒤 다시 실행했다. 중단 로그에 포함된 시험 쿠키는 가렸고 해당 소유자의 작업 목록이 비어 있음을 확인했다.

첫 정상 구성 검사에서는 Cloudflare가 새 하위 도메인에 자동 삽입한 RUM beacon이 엄격한 CSP와 충돌해 12개 통과/1개 실패였다. 최종 배포는 HTML 진입 경로에만 `no-transform`을 적용해 삽입을 막는다. 전체 정적 자산에 적용하면 JS 압축도 꺼지므로 HTML로 범위를 좁혔다. 실제 JS/CSS의 Brotli 압축과 API `no-store`를 확인했다. CSP와 콘솔 오류 검사를 완화하지 않았다.

Single Redirect API 쓰기 검증이 인증 오류로 실패해 로그인된 Cloudflare 관리 화면에서 동일한 규칙을 배포했다. 읽기 API와 실제 접속으로 검증했다. RUM 규칙 변경은 수행하지 않았으며 앱 헤더로 해결했다. 세부 리소스 ID·공식 근거·향후 SPA 경로 관리와 복구는 [운영 가이드](../runbooks/custom-domain.md)에 있다.

## 제출 자료

[제출 가이드](../submission/preparation.md), 실제 1600×900 이미지 5장, [ZIP](../submission/ieojim-submission-images.zip)을 새 주소의 최종 배포본으로 갱신했다. 촬영은 합성 예시이며 새 유료 AI 호출이 없다. 촬영한 작업 공간 1개는 삭제했다. [이미지 기록](../submission/assets/manifest.json)에 해시·촬영 시각·배포 버전을 남겼다. 폼 업로드나 최종 제출은 수행하지 않았다.

정확한 로컬 체크포인트는 `.omx/verification-custom-domain.json`이며, 원격 설정·검사 로그·개인정보를 가린 실패 증거는 `artifacts/custom-domain/`에 있다. 이전 제출 이미지 패키지는 해당 디렉터리의 `submission-before/`에 보존했다.
