# IEOJIM 도메인 운영

2026-09-10 승인된 본주소는 **https://ieojim.jungseongheon.org**다. 영문 브랜드는 **IEOJIM**, 한글 이름은 **이어짐**이다. `https://jungseongheon.org/ieojim`은 본주소로 이동한다. 경로 아래에 앱을 설치하지 않아 `/api`, `/app`, 정적 자산과 인증의 출처가 하나로 유지된다.

## 구성과 관리 경계

| 항목 | 현재 값 |
| --- | --- |
| Worker / Wrangler 환경 | `ieojim-staging` / `staging` |
| Cloudflare 계정 | `d77fd515103009a324bebb3ac5b81fd9` |
| Zone | `edd2250c1913589cc651bc907f4e6297` (`jungseongheon.org`) |
| Custom Domain ID | `24d608e7199b9eeb165e750a7894d1fb9d96fb2a` |
| Redirect ruleset ID | `e209c6583ebb444d812253f971a38dd2` |
| Redirect rule ID / ref | `753bb9f65440490f9ac0641829c337df` |
| 최종 Worker 버전 | `c79b2cbc-8598-4604-8d0f-a6a41c3a105c` |
| 연결 전 호환 버전 | `84032c03-ef2a-4630-82ed-7de93933b7da` |

서비스 도메인과 `workers_dev: true`는 루트 `wrangler.jsonc`의 `env.staging`에서 관리한다. D1·Queue·비용 한도·7일 미사용 만료 정책은 기존 값을 유지한다. Cloudflare API의 Worker domain 응답에 나타나는 `environment: production`은 서비스 배포 슬롯 값이며, 이 저장소의 미구성 `env.production`을 새로 배포했다는 뜻이 아니다.

리디렉션은 별도 Worker가 아닌 zone의 Single Redirect다. [선언 파일](../../infra/cloudflare/ieojim-entry-redirect.json)은 다음 조건과 일치한다.

```text
(http.host eq "jungseongheon.org" and http.request.uri.path in {"/ieojim" "/ieojim/"} and http.request.method in {"GET" "HEAD"})
```

정적 대상 `https://ieojim.jungseongheon.org/`, 상태 `302`, query 전달 없음. `/ieojimX`, 하위 경로, 대문자 경로, POST는 이 규칙에 포함하지 않는다. 초기 연결을 되돌릴 때 영구 리디렉션 캐시를 피하기 위해 302를 사용한다.

MCP의 규칙 쓰기 검증 요청은 인증 오류 `10000`으로 실패했다. 기존에 로그인된 Cloudflare 관리 화면에서 위 조건으로 배포했고, API 읽기와 실제 HTTP 응답으로 확인했다. 새 인증 정보·권한·유료 플랜을 만들지 않았다. 다음 갱신도 현재 규칙 ID를 대상으로 한다. **전체 ruleset을 이 파일로 덮어쓰지 않는다.** 다른 운영자가 추가한 규칙을 먼저 읽고 보존한다. 향후 API 자동화에는 범위를 제한한 Single Redirect 편집 권한이 필요하다.

기존 apex의 `jungseongheon-portfolio` Worker와 `jungseongheon.org/*` 경로, apex DNS는 수정하지 않았다. 루트·`/portfolio/`·주요 JS/CSS·유사 경로 응답은 연결 전후 상태와 SHA-256을 비교했다.

## 자동 삽입과 정적 응답

기존 zone Web Analytics는 모든 하위 도메인에 통계 스크립트를 자동 삽입했다. 새 도메인 검사에서 이 스크립트가 엄격한 `script-src 'self'`와 충돌하는 것을 확인했다. CSP 허용 목록과 테스트를 완화하지 않고 `public/_headers`의 HTML 진입 경로에 `Cache-Control: public, max-age=0, must-revalidate, no-transform`을 설정했다. 기존 캐시 재검증 방침을 유지하고 자동 본문 변경을 막는다.

`no-transform`은 압축도 막으므로 `/`, `/index.html`, `/app`, `/login`, `/settings`와 해당 하위 진입 경로에만 적용한다. JS·CSS·폰트는 압축을 계속 사용하며, API의 개인 데이터는 Worker가 `no-store`로 응답한다. 새로운 최상위 SPA 경로를 추가할 때 HTML 헤더와 원격 검사를 함께 갱신한다. 알 수 없는 경로의 SPA fallback까지 자동 적용하는 정책은 아니다.

RUM API 쓰기는 인증 오류였고 관리 화면의 고급 옵션도 정상적으로 열리지 않아, RUM 제외 규칙은 생성하지 않았다. 기존 RUM ruleset `23099404-3eb8-436f-a5e2-9115513be3b5`와 기본 포함 규칙 `6dbc0ff9-b22b-4556-81f4-6b8f4d6bc329`를 보존했다. 이어짐은 브라우저 통계 beacon을 사용하지 않으며 Worker 관측 설정은 유지한다. [Cloudflare FAQ](https://developers.cloudflare.com/web-analytics/faq/)와 [압축 문서](https://developers.cloudflare.com/speed/optimization/content/compression/)에 따른 동작이다.

## 게스트 데이터와 인증

기존 주소 `https://ieojim-staging.masondev1024.workers.dev`도 유지한다. 호스트 전용 쿠키를 사용하는 기존 게스트는 **기존 주소와 브라우저**에서 작업을 계속 연다. 새 주소의 작업 목록으로 자동 이동하지 않는다. Cookie Domain을 상위 도메인으로 넓히거나 소유권 검사를 완화하지 않는다. 포트폴리오 Origin을 붙인 쓰기도 403이다.

배포 전에 만든 합성 작업을 배포 후 기존 쿠키로 읽기 200, 새 주소에서는 404로 확인하고 시험 작업을 삭제했다. 임시 자격 증명 파일도 제거했으며 최종 증거에는 쿠키 값이 없다.

`BETTER_AUTH_URL`은 새 본주소로 준비됐으나 **실제 Google 로그인은 아직 비활성**이다. 향후 callback은 `https://ieojim.jungseongheon.org/api/auth/callback/google`을 등록한다. 인증을 활성화하면 비표준 출처의 인증 처리가 거부되므로, 기존 주소의 게스트를 보존·이동할 절차를 먼저 검증해야 한다. 현재 게스트 연속성 검사는 인증 활성화 이후의 동작까지 보장하지 않는다. [계정 운영 가이드](accounts.md)를 함께 따른다.

## 배포 후 검증

브라우저 실행은 한 번에 하나만 한다.

```sh
npm run typecheck
npm run lint
npm run deploy:check:staging
npm run test:domain
```

`test:domain`은 새 도메인에서 기존 원격 시나리오 9개와 도메인 경계 4개를 실행한다. 합성 작업만 생성하고 테스트 소유 작업을 삭제하며 실제 Gemini/Google 호출은 하지 않는다. DNS A/AAAA와 신뢰 가능한 TLS 연결, `/api/account`의 실제 인증 가용성, 기존 포트폴리오 해시는 별도로 확인한다. 일반 개발 서버와 로컬 DB는 재사용하거나 종료하지 않는다.

최종 UI 검증 후 `node --import tsx scripts/prepare-submission.ts`는 새 본주소에서 실제 화면 5장을 촬영한다. 이미지·ZIP·해시·배포 버전과 [제출 가이드](../submission/preparation.md)를 함께 갱신한다. 촬영된 작업 공간은 시험 후 삭제되므로 이미지의 상세 경로를 서비스 링크로 제출하지 않는다.

## 복구

1. 바로가기 문제라면 Cloudflare 규칙 화면에서 위 **해당 rule ID 하나만 비활성화**한다. 전체 ruleset이나 포트폴리오 경로를 삭제하지 않는다. 원인을 고친 뒤 실제 `/ieojim`, `/ieojim/`, 유사 경로를 검사하고 다시 활성화한다.
2. 앱 회귀라면 계정 스키마와 호환되는 연결 전 버전으로 Worker를 롤백한다. 도메인·리디렉션은 버전과 별도 관리되므로 현재 매핑을 다시 확인한다. DB를 되돌리거나 오래된 익명 전용 Worker로 복구하지 않는다.
3. 새 도메인 연결 자체를 철회해야 한다면 바로가기를 먼저 비활성화하고 **이어짐의 custom domain만** 해제한다. `wrangler.jsonc`의 해당 staging route를 함께 수정하되 `workers_dev: true`는 유지한다. apex DNS나 포트폴리오 custom domain은 대상이 아니다.
4. 기존 주소의 게스트 접근과 포트폴리오 상태/해시를 다시 확인한다. DNS나 인증서 장애를 이유로 브라우저 인증서 검사를 끄지 않는다.

초기 백업은 `artifacts/custom-domain/wrangler.before.jsonc`, `cloudflare-before.json`, `public-before.json`이다. 구성·TLS·연속성·검사·촬영 결과는 `.omx/verification-custom-domain.json`과 `artifacts/custom-domain/`에 기록한다. 로컬 증거를 외부에 공유할 때는 자격 증명과 사용자 원문을 제외한다.

공식 근거: [Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/), [workers.dev 유지 설정](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/), [Single Redirect API](https://developers.cloudflare.com/rules/url-forwarding/single-redirects/create-api/).
