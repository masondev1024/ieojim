# 이어짐 제출용 라이선스 고지

작성 기준: `package.json`의 production dependencies, 설치된 runtime dependency closure의 `node_modules/*/package.json`, 실제 런타임 UI에서 import되는 `lucide-react`, 그리고 `public/fonts`에 번들된 SUIT 폰트 파일을 확인했다. 네트워크 조회 없이 로컬 설치물만 감사했으며, 이 문서는 제출용 사실 고지이지 법률 의견이나 완전한 법적 보증이 아니다.

실제 배포 고지 파일은 Vite public asset으로 포함되는 `public/THIRD_PARTY_NOTICES.txt`이며, 배포 후에는 `/THIRD_PARTY_NOTICES.txt` 경로에서 접근 가능해야 한다. 설치 패키지에 라이선스 파일이 빠진 `@react-three/fiber`와 `@better-auth/utils`는 upstream 근거를 별도로 기록했다.

## 요약

현재 제출 빌드의 런타임 라이브러리와 번들 자산은 permissive/open font 계열로 확인된다.

- 대부분의 JavaScript runtime dependency: MIT
- 예외 runtime/transitive dependency: `@opentelemetry/semantic-conventions` Apache-2.0, `ieee754` BSD-3-Clause
- 실제 UI 아이콘: `lucide-react` ISC
- self-hosted 폰트: SUIT Variable, SIL Open Font License 1.1
- 3D 장면: 프로젝트 코드의 procedural geometry/material이며 원격 texture/font/model asset 없음

제출/배포 시 보존해야 할 핵심 의무는 라이선스·저작권 고지 유지다. 이를 위해 원문 고지 파일을 `public/THIRD_PARTY_NOTICES.txt`에 포함했다. SUIT는 Reserved Font Name `SUIT` 조건이 있으므로 폰트를 수정해 재배포하는 경우 이름 사용 제한을 별도로 지켜야 한다. 현재는 원본 `SUIT-Variable.woff2`와 라이선스 사본을 함께 보관한다.

## 직접 production dependencies

| 패키지 | 버전 | 라이선스 | 로컬 근거 |
|---|---:|---|---|
| `@react-three/fiber` | 9.7.0 | MIT | `node_modules/@react-three/fiber/package.json`; upstream `refs/tags/v9.7.0` LICENSE 보강 |
| `better-auth` | 1.7.3 | MIT | `node_modules/better-auth/package.json`, `node_modules/better-auth/LICENSE.md` |
| `hono` | 4.13.7 | MIT | `node_modules/hono/package.json`, `node_modules/hono/LICENSE` |
| `react` | 19.2.8 | MIT | `node_modules/react/package.json`, `node_modules/react/LICENSE` |
| `react-dom` | 19.2.8 | MIT | `node_modules/react-dom/package.json`, `node_modules/react-dom/LICENSE` |
| `react-router-dom` | 7.18.3 | MIT | `node_modules/react-router-dom/package.json`, `node_modules/react-router-dom/LICENSE.md` |
| `three` | 0.186.0 | MIT | `node_modules/three/package.json`, `node_modules/three/LICENSE` |
| `zod` | 4.5.4 | MIT | `node_modules/zod/package.json`, `node_modules/zod/LICENSE` |

## Production transitive dependencies 확인 결과

| 라이선스 | 패키지 |
|---|---|
| MIT | `@babel/runtime`, `@better-auth/core`, `@better-auth/drizzle-adapter`, `@better-auth/kysely-adapter`, `@better-auth/memory-adapter`, `@better-auth/mongo-adapter`, `@better-auth/prisma-adapter`, `@better-auth/telemetry`, `@better-auth/utils`, `@better-fetch/fetch`, `@noble/ciphers`, `@noble/hashes`, `@standard-schema/spec`, `@types/react-reconciler`, `@types/webxr`, `base64-js`, `better-call`, `buffer`, `cookie`, `defu`, `its-fine`, `jose`, `kysely`, `nanostores`, `react-router`, `react-use-measure`, `rou3`, `scheduler`, `set-cookie-parser`, `suspend-react`, `use-sync-external-store`, `zustand` |
| Apache-2.0 | `@opentelemetry/semantic-conventions` |
| BSD-3-Clause | `ieee754` |

주의: `better-auth`의 설치 metadata에는 여러 adapter 패키지가 dependency로 포함되어 있다. 현재 앱이 모든 adapter를 직접 호출한다는 뜻은 아니지만, 설치된 runtime dependency closure에 존재하므로 shipped notice에 보수적으로 포함했다.

## 실제 번들 자산과 UI asset

| 자산 | 라이선스 | 로컬 경로 | 확인 내용 |
|---|---|---|---|
| SUIT Variable font | OFL-1.1 | `public/fonts/SUIT-Variable.woff2`, `public/fonts/SUIT-LICENSE.txt` | Copyright (c) 2022, SUNN. Reserved Font Name `SUIT`. 원본 폰트를 self-hosting하며 라이선스 사본을 저장한다. |
| lucide-react icons | ISC | `node_modules/lucide-react/package.json`, `node_modules/lucide-react/LICENSE` | `src/client/account/*`, `src/client/landing/ProductLanding.tsx`, `src/client/workspace/WorkspaceApp.tsx`에서 SVG React icon으로 import된다. |
| Continuity 3D scene | 프로젝트 자체 작성 | `src/client/scene/ContinuityCanvas.tsx` | Three.js/R3F의 procedural geometry와 material만 사용한다. 원격 texture, stock image, 외부 3D model, 외부 font asset을 사용하지 않는다. |

## 설치 license file 누락 항목의 upstream 보강

다음 패키지는 package metadata에 라이선스 값이 있지만 설치 디렉터리에 `LICENSE`, `LICENCE`, `COPYING`, `NOTICE` 파일이 없었다. `public/THIRD_PARTY_NOTICES.txt`에는 upstream 근거, ref, 수집일, 원문을 함께 기록했다.

| 패키지 | 버전 | metadata license | 보강 근거 | 한계 |
|---|---:|---|---|---|
| `@react-three/fiber` | 9.7.0 | MIT | `https://raw.githubusercontent.com/pmndrs/react-three-fiber/v9.7.0/LICENSE`; `refs/tags/v9.7.0` 확인 commit `0a107412ac64667b1908422e859447952f57feef` | matching release tag LICENSE 원문으로 보강됨 |
| `@better-auth/utils` | 0.4.2 | MIT | `refs/tags/v0.4.2` README의 `License: MIT` 확인; tag object `10b6572844c99ed9a4410a687bd6f2c565e5341e`, peeled commit `b20329a32d78f1f9bcc088bbd6f982b28c4192f1`; full text는 `https://raw.githubusercontent.com/better-auth/utils/main/LICENSE` | matching tag에 LICENSE 파일이 없어 main branch LICENSE fallback이며, tag-verified full text라고 주장하지 않음 |

## 제출 문구에 반영할 수 있는 표현

> 본 서비스는 참가자가 직접 구현한 TypeScript/React/Hono/Cloudflare 기반 웹 서비스입니다. 화면 캡처는 실제 실행 화면이며, 별도 유료 디자인 asset이나 외부 3D model/texture를 사용하지 않았습니다. 주요 런타임 라이브러리는 MIT 중심이며, Apache-2.0/BSD-3-Clause/ISC/OFL-1.1 라이선스 항목은 고지와 라이선스 사본 보존 기준으로 관리합니다. 배포 고지 파일은 `/THIRD_PARTY_NOTICES.txt`에 포함됩니다.

## 운영상 caveat

- 이 문서는 현재 로컬 설치 상태, `package-lock.json`, 그리고 2026-09-10에 확인한 두 upstream 보강 근거 기준 감사 결과다. 제출 직전 dependency upgrade, lockfile 재생성, 폰트/아이콘/이미지 추가가 있으면 다시 감사해야 한다.
- Apache-2.0, BSD-3-Clause, ISC, MIT, OFL-1.1 모두 저작권 및 라이선스 고지를 보존해야 한다.
- SUIT 폰트를 수정해 배포하는 경우 Reserved Font Name 조건 때문에 `SUIT` 이름 사용 제한을 별도로 검토해야 한다. 현재 감사 범위에서는 폰트 수정 흔적을 확인하지 않았다.
- dev/test tooling 라이선스는 production runtime 고지 범위에는 포함하지 않았다. 제출 설명에서 Playwright/Vitest/Vite 같은 개발 도구를 강조할 경우 해당 toolchain도 별도로 고지 목록에 추가하는 편이 안전하다.
