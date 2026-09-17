# AI 대회 수상작 기술 카탈로그

기준일: **2026-09-09**. 목적: 공개 수상 근거와 기술 자료를 구분해 이어짐의 고도화 결정을 돕는다.

이번 확인 범위는 **10개 대회의 수상작 42개와 Honorable Mention 10개, 총 52개**다. 2026년 사례를 중심으로 2025년 ADK와 2024년 Gemini 사례를 보완했다. 전 세계 모든 대회의 전수조사는 아니다. 아래에서 “전원”은 해당 공식 발표의 수상 목록 전체를 뜻하며, 모든 작품의 비공개 코드까지 확인했다는 뜻은 아니다. ADK·Gemini 2024는 명시적으로 일부 사례만 포함했다. 아직 수상 결과가 없는 원티드 2026은 이 합계에서 제외했다.

## 근거를 읽는 방법

- **수상 근거**: 주최사 발표·공식 대회 갤러리로 확인한다. 참가자의 자기소개만으로 수상작에 포함하지 않는다.
- **공개 코드/manifest 확인**: 공개 저장소의 README·구현·의존성 자료를 읽었다. 별도 실행 검증이나 운영 보안 인증을 뜻하지 않는다. 확인한 현재 코드와 수상 당시 제출 커밋은 다를 수 있다.
- **제작자 설명**: Devpost·공식 제출 페이지의 기술 설명이다. 그 구성 전체가 실제로 작동한다는 검증은 아니다.
- **기술 미확인**: 수상은 확인했으나 구체적인 구현 근거가 부족하다. 스택을 추측하지 않는다.

후원사 대회 표본은 플랫폼 선택에 편향이 있다. 수상과 특정 프레임워크 사이의 인과관계나 시장 점유율을 계산할 수 없다. Claude Code 같은 **개발용 AI**와 제품에서 실제 호출하는 **런타임 AI**도 구분한다. 이 문서의 성능·안전성 설명은 출처의 설명이며, 이어짐에서 직접 검증한 결과는 별도 구현 보고서에만 기록한다.

## 원티드 AI Championship 2026

기준일에는 접수 단계이며 아직 이번 회차 수상작은 없다. 접수 마감 9월 18일, 제출 마감 9월 20일, 예선·투표 9월 21일–10월 5일, TOP20 발표 10월 7일, 데모데이·시상 10월 17일로 안내되어 있다. 자유 주제의 실제 문제 해결과 AI 활용을 설명하고 서비스 배포 링크 등을 제출한다. 예선은 내부 심사 80%·투표 20%, 본선은 심사위원 평가 100%다. 심사진은 강정구·김호민·김덕중·조정석·정기수다. [원티드 공식 안내](https://event.wanted.co.kr/ai-championship/2026), [공식 랜딩](https://static.wanted.co.kr/ai-championship/2026/landing.html)

따라서 아래 비교는 원티드 수상 공식을 알아냈다는 주장이 아니다. **처음 보는 입력에서도 변경을 정확히 반영하고 사용자의 결정을 보존하는 제품**을 배포·실험·설명할 수 있게 만드는 것이 이어짐에 대한 우리의 권고다.

## 1. Gemini 3 글로벌 해커톤 — 주요상 3개·Honorable Mention 10개 전원

공식 발표가 세 주요상과 열 Honorable Mention을 확인한다. 최종 발표일은 이 조사에서 확정하지 않았다. Globot은 추가 자격 검토 이후에도 Grand Prize를 유지한다는 운영진 발표를 별도로 확인했다. [공식 수상 발표](https://gemini3.devpost.com/updates/40729-the-moment-you-ve-been-waiting-so-patiently-for), [운영진 자격 검토 결과](https://gemini3.devpost.com/forum_topics/43709-gemini-3-hackathon-update-on-the-eligibility-review)

| 상 | 작품 | 기술 자료와 해석 |
| --- | --- | --- |
| 1위 | Globot | 제출 설명: Python/FastAPI, CrewAI, React/TypeScript, Deck.gl, Gemini, SQLite/Chroma, WebSocket 기반 공급망 분석. 현재 저장소에는 synthetic/mock 데이터와 Ollama 기본 설정·선택적 provider가 있어 제출 설명과 구분한다. [제출](https://devpost.com/software/globot-341w9q), [공개 저장소](https://github.com/Vector897/Globot) |
| 2위 | Aegis | Next.js/TypeScript, Google GenAI, Zustand, React Leaflet와 위기 대응 승인 흐름. 현재 repo의 Next 16과 제출 설명의 버전 차이, simulation 데이터 사용을 확인했다. [제출](https://devpost.com/software/aegis-autonomous-multi-agent-crisis-command), [공개 저장소](https://github.com/iamdanishm/aegis) |
| 3위 | Netra | Python/FastAPI, Gemini Flash, JavaScript, WebSocket/WebAudio, Pillow. 비전·음성 처리의 우선순위와 중복 제거, JSON 기억 저장을 설명한다. [제출](https://devpost.com/software/netra-empowering-the-visually-impaired), [공개 저장소](https://github.com/ZentraHost/netra_project) |

다음 10개는 **Honorable Mention 확인·개별 기술 스택 미확인**이다. 근거는 위 공식 수상 발표다.

1. AgentGuard: The Semantic Firewall for the Agentic Web
2. BatteryForgeAI
3. Logic Lift
4. PROCSee
5. Proofy.AI
6. Agent-weaver
7. Orbital Assets
8. CineStream: A2A Mesh & Cinematic Learning
9. Orphafold
10. Gemini GeoFlow

## 2. Gemini 3 서울 해커톤 — 상위 3개 전원

| 상 | 작품 | 수상 근거 | 기술 자료와 해석 |
| --- | --- | --- | --- |
| 1위 | GeminiSpace / SpatialOS — 장민수 | [Google 우승자 인터뷰](https://blog.google/intl/ko-kr/company-news/inside-google/gemini-seoul-hackathon-first/), [공식 갤러리](https://cerebralvalley.ai/e/gemini-3-seoul-hackathon/hackathon/gallery/27) | Next.js/React, FastAPI, Google GenAI, D3/Three.js, NetworkX, ROS2, Cloud Run. 사진에서 공간·위상·voxel 표현으로 연결한다. README가 개념 검증 단계와 SLAM 고도화 필요를 밝힌다. [공개 저장소](https://github.com/mincasurong/GeminiSeoulHackathon2026) |
| 2위 | 자기 진화 보안 에이전트 — 김용규, 팀 SaaS | [Google 수상자 인터뷰](https://blog.google/intl/ko-kr/company-news/inside-google/gemini-seoul-hackathon-second/) | 인터뷰에서 Gemini·AI Studio·Antigravity와 공격→방어→평가→전략 수정 루프를 설명한다. 언어·런타임 프레임워크는 미확인이다. Antigravity 사용을 ADK 도입으로 환산하지 않는다. |
| 3위 | MangstoonAI | [공식 갤러리](https://cerebralvalley.ai/e/gemini-3-seoul-hackathon/hackathon/gallery/9) | ADK, Gemini Pro/Flash Image, FastAPI/Cloud Run, Next.js/Vercel, GCS, GitHub Actions WIF. 컷별 비동기 생성과 구조화된 부분 수정을 설명한다. [공개 저장소](https://github.com/jays0606/mangstoon_ai) |

AlphaAgent는 Top 6 finalist 자료가 있으나 위 3개 수상작과 합산하지 않았다. [참가자 저장소](https://github.com/sehooni/Alpha_Agent)

## 3. Claude Opus 4.8 Build Day — 상위 3개 전원

6월 13일 행사, 6월 17일 공식 발표에서 아래 순위를 확인했다. [Anthropic 공식 수상 발표](https://claude.com/blog/meet-the-winners-of-our-claude-opus-4-8-build-day-hackathon)

| 상 | 작품 | 공개 저장소에서 확인한 구성·구현 신호 |
| --- | --- | --- |
| 1위 | Tekton | Next.js 정적 export, React/TypeScript, Three.js/R3F/drei, Zustand, Playwright. 출처 JSON과 파생·검증 단계를 연결한다. 공개 구성은 런타임 LLM 없이 작동하는 정적 경험으로, AI를 활용한 제작 과정과 서비스 런타임을 구분해야 하는 사례다. [저장소](https://github.com/tangxiya-star/Tekton) |
| 2위 | SimFrancisco | Rust/Axum, SQLite, ACS PUMS 기반 가중 인구 archetype, 배치·cache, SSE, JavaScript. 모델 호출 단위와 계산량을 줄이는 설계가 관찰된다. 제작자 예측 성능은 독립 검증하지 않았다. [저장소](https://github.com/tejasprabhune/simfrancisco) |
| 3위 | CustomUniverse | FastAPI, WebGL, FLUX.2 Klein 9B, PyTorch/CUDA·Docker, 로컬 H100 또는 외부 추론 경로. debounce·AbortController·직렬 GPU lock으로 상호작용과 추론 경합을 다룬다. [저장소](https://github.com/jss8649/image-edit-realtime-hackathon) |

## 4. Built with Opus 4.6 Claude Code Hackathon — 5개 상 전원

아래 수상 관계는 2026년 4월 20일 공식 게시물로 확인했다. 게시일을 행사 개최일로 간주하지 않는다. [Anthropic 공식 수상 발표](https://claude.com/blog/meet-the-winners-of-our-built-with-opus-4-6-claude-code-hackathon)

| 상 | 작품 | 기술 자료와 해석 |
| --- | --- | --- |
| 1위 | CrossBeam | Next.js 16/React 19, Express 5/Cloud Run, Vercel Sandbox, Claude Agent SDK, Supabase Postgres/Realtime/Storage. 장시간 작업과 domain skill 자료를 연결한다. [공개 저장소](https://github.com/mikeOnBreeze/cc-crossbeam) |
| 2위 | Elisa | Electron, 시각적 목표·spec·test, task DAG, 사람 검토 gate, OS keychain, Cloud Run/ESP32 plugin을 설명한다. [공개 저장소](https://github.com/zoidbergclawd/elisa) |
| 3위 | PostVisit.ai | 진료 후 기록·근거와 연결된 환자 설명이라는 공식 소개를 확인했다. 구체적 backend 스택은 미확인. [프로젝트](https://postvisit.ai) |
| Keep Thinking | TARA | 도로 상태의 시각 분석과 경제성 평가라는 공식 소개를 확인했다. 연결된 repo의 세부 런타임은 이번 조사에서 미검증. [저장소](https://github.com/Kye256/tara-transport-assessment) |
| Creative Exploration | Conductr | 공식 소개 기준 JavaScript·C 엔진·WebAssembly·브라우저 MIDI를 활용한 음악 제작. 개별 의존성은 미검증. [저장소](https://github.com/nanassound/conductr) |

## 5. SANS Find Evil 2026 — 상위 5개 전원

8월 27일 발표된 다섯 수상작이다. 주최 측은 실무자 평가와 finalist 재검증을 설명한다. 이 검증 범위를 공개 서비스 전체의 운영 보안 인증으로 확대하지 않는다. [SANS 공식 수상 발표](https://www.sans.org/press/announcements/sans-names-the-five-winners-of-find-evil-2026)

| 순위 | 작품 | 공개 코드·manifest·README에서 확인한 구성 |
| --- | --- | --- |
| 1 | Mulder | Python, MCP, SQLAlchemy/Pydantic, Volatility 3, Claude Agent SDK. typed forensic tool, shell 제한, evidence reference, append-only audit, 계획·수행·분석·반박·보고 단계를 설명한다. [저장소](https://github.com/calebevans/mulder), [manifest](https://raw.githubusercontent.com/calebevans/mulder/main/pyproject.toml) |
| 2 | TRUDI | Python, FastMCP/httpx/Anthropic/YARA. director·analyst·reviewer, 단계별 gate, mock 검증, 한도가 있는 수정 루프를 설명한다. [저장소](https://github.com/nebulae/trudi) |
| 3 | Camel | C#/.NET 9, MCP, Jint JavaScript sandbox, Serilog. 제한된 typed SDK와 I/O·shell 경계를 설명한다. 모델 생성 코드 실행은 별도 격리 설계가 필요한 선택이다. [저장소](https://github.com/allisterb/Camel), [CLI manifest](https://raw.githubusercontent.com/allisterb/Camel/master/src/Camel.CLI/Camel.CLI.csproj) |
| 4 | FindEvil | Python, MCP, pytest/ruff/Hypothesis. 읽기 전용 AST 검사, 감사 기록, 줄 단위 근거, contradiction·coverage gate를 설명한다. [저장소](https://github.com/marlyocat/findevil) |
| 5 | Protocol SIFT++ | Python, Anthropic, MCP, Pydantic, Starlette/Uvicorn, Volatility 3. hash-chain audit, evidence SHA-256, Investigator/Skeptic, replay를 설명한다. [저장소](https://github.com/tupils1/protocol-siftpp) |

## 6. Microsoft Agent Academy Hackathon 2026 — 4개 트랙의 12개 수상작 전원

대회는 5월 12일–6월 2일, 수상 발표는 6월 18일이다. 아래 각 트랙의 1·2·3위는 공식 발표에 따른다. 기술 상세는 가능한 경우 참가자 repo로 교차 확인했다. [Microsoft 공식 수상 발표](https://devblogs.microsoft.com/powerplatform/agent-academy-hackathon-winners/), [공식 행사](https://microsoft.github.io/agent-academy/events/hackathon/)

| 트랙·순위 | 작품 | 기술 자료와 해석 |
| --- | --- | --- |
| Recruit 1 | Performance Development Assistant | 공식 소개: Copilot Studio, SharePoint, Power Automate. 코드 미확인. |
| Recruit 2 | Meeting Tasks Agent | 공식 소개: Copilot Studio, Word 회의록→task. 코드 미확인. |
| Recruit 3 | Conversational AI Agent for Vehicle Insurance Self-Service Portal | 공식 소개: Dataverse, 신원 확인·승인. 코드 미확인. |
| Operative 1 | VendorGuard | Copilot Studio와 4 specialist, Dataverse, Power Automate/Teams, Dataverse MCP, AI Builder 추출. [공개 저장소](https://github.com/experienceswithanishh/vendorguard-copilot-studio) |
| Operative 2 | Engagement Hub | Dataverse/SharePoint/Power Automate, 승인, 중복 방지, correlation ID 감사 흐름. 선언된 흐름과 실제 동시성 보장은 별도로 검증해야 한다. [공개 저장소](https://github.com/leila-marspooner/engagement-hub-agent) |
| Operative 3 | FrostByte AI Advisor | 공식 소개: Dataverse MCP, 읽기/쓰기 agent 분리, Claude Sonnet. 코드 미확인. |
| Special Ops 1 | SprintForge | Copilot Studio, Microsoft Learn/Jira MCP, 구조화 SprintPlan JSON. **README는 attachment 처리를 선택적 미구현 작업으로 적고 있어 발표 소개와 구분한다.** [공개 저장소](https://github.com/Shrusti13/sprint-forge) |
| Special Ops 2 | Calamity Agent | Node.js/TypeScript/Zod, Streamable HTTP MCP, .NET Aspire/Azure Container Apps, NWS·NASA FIRMS·Azure Maps, Copilot Studio. [공개 저장소](https://github.com/tagr/CalamityCopilotService) |
| Special Ops 3 | Warehouse Picking Agent | 공식 소개: Node.js MCP, Dynamics 365, Azure AD 인증. 코드 미확인. |
| Cowork Collective 1 | Copilot Cowork Autonomous ITSM Platform on Microsoft 365 | SPFx React, Power Automate/Copilot Studio, Teams 승인, Graph scoped principal, Flow Studio MCP. **README가 working PoC이며 production hardening 전이라고 명시한다.** [공개 저장소](https://github.com/ninihen1/copilot-studio-itsm-agent) |
| Cowork Collective 2 | Client Kick-off Skill | SKILL.md와 M365 도구, 계획→승인 단계, 항목별 확인, 사람 식별과 날짜·시간대 불확실성 처리. [공개 저장소](https://github.com/appieschot/client-kickoff-skill) |
| Cowork Collective 3 | Team Yaito | 공식 소개: Copilot Cowork 기반 PMO 협업. 코드 미확인. |

## 7. TechEx: Transforming Enterprise Through AI — 3개 수상작 전원

5월 19일 결선의 실제 Winners 순위를 사용했다. 같은 페이지의 투표 수·인기 순위를 수상 순위로 바꾸지 않았다. [주최 측 수상 목록](https://lablab.ai/ai-hackathons/techex-intelligent-enterprise-solutions-hackathon/live)

| 상 | 작품 | 기술 자료와 해석 |
| --- | --- | --- |
| 1위 | Trellis | 제작자 설명: Gemini Nano/Presidio 비식별화, Gemini Pro, 사람의 게시 승인, vector+graph 검색과 MCP, 근거 부족 시 응답 제한. repo 내용을 확보하지 못해 **구현 검증 전 설계 주장**으로 분류한다. [공식 제출](https://lablab.ai/ai-hackathons/techex-intelligent-enterprise-solutions-hackathon/pan-sa-manila/trellis-the-knowledge-fabric-for-law-firms) |
| 2위 | Sendero | 제작자 설명: Gemini Flash OCR/Zod, Pro 추론, Vercel Workflows, HMAC, PII 암호화, Langfuse/Phoenix, Liveblocks, MCP. repo 내용을 확보하지 못해 **구현 검증 전 설계 주장**으로 분류한다. [공식 제출](https://lablab.ai/ai-hackathons/techex-intelligent-enterprise-solutions-hackathon/sendero/sendero-ai-automated-corporate-travel) |
| 3위 | AquaLens | Next.js 15/TypeScript, FastAPI/SQLModel/Alembic, Postgres 16/PostGIS/pgvector, Gemini Flash, NumPy, MapLibre, WeasyPrint. 결정론적 위험 점수와 AI 설명을 분리하며 trace/fallback을 설명한다. [공식 제출](https://lablab.ai/ai-hackathons/techex-intelligent-enterprise-solutions-hackathon/team-labaik/aqualens-autonomous-freshwater-monitoring-agent), [공개 저장소](https://github.com/talhaabidj/aqualens) |

## 8. MIT NandaHack — 3개 수상작 전원

6월 13일–7월 11일 진행, 8월 4일 공식 recap에서 수상을 확인했다. 대회가 hosted endpoint와 SKILL.md 및 agent 기반 테스트를 요구했다는 점과 개별 제품이 어떤 언어·framework를 사용했다는 주장은 구분한다. [MIT 공식 행사·결과](https://nandahack.media.mit.edu/)

| 상 | 작품 | 공식 소개에서 확인한 범위 |
| --- | --- | --- |
| 1위 | AgentPress | 자율 뉴스룸과 결정론적 평가 기준. 개별 backend 스택 미확인. |
| 2위 | 2036 Agentic Town | AI Constitution·Civil Ledger 개념. 개별 backend 스택 미확인. |
| 3위 | Litmus | NANDA agent를 위한 보안 honeypot. 개별 backend 스택 미확인. |

## 9. Google Cloud ADK Hackathon 2025 — 대표 수상작 4개

아래는 전체 수상작 목록이 아니라 Grand Prize와 지역 수상 사례다. [Google Cloud 공식 결과](https://cloud.google.com/blog/products/ai-machine-learning/adk-hackathon-results-winners-and-highlights), [공식 갤러리](https://googlecloudmultiagents.devpost.com/project-gallery)

| 상 | 작품 | 제작자 설명의 스택·구현 신호 |
| --- | --- | --- |
| Grand Prize | SalesShortcut | ADK/A2A, Gemini, Cloud Run, BigQuery, Pub/Sub, WebSocket, 사람 승인. 34 agents·5 microservices는 제작자의 구성 설명이며 필요성·성능을 독립 재현하지 않았다. [제출](https://devpost.com/software/salesshortcut) |
| North America | Energy Agent AI / WattsWise | ADK/Gemini, BigQuery, XGBoost/SHAP, GCS/Cloud Run, Streamlit. 예측·설명·행동을 연결하며 synthetic 데이터 기반 실험을 구분한다. [제출](https://devpost.com/software/energy-agent-ai) |
| Asia Pacific | GreenOps | ADK/Gemini, BigQuery ML, Climatiq, Cloud Run/Streamlit. forecast 후 action을 제시하는 흐름. [제출](https://devpost.com/software/greenops-gzp4aj) |
| EMEA | Nexora AI | Python/FastAPI, ADK/Gemini, MySQL/Chroma, React/Vite, Docker. 교육 콘텐츠와 생성 UI 검증을 설명한다. [제출](https://devpost.com/software/teachai-upzofa) |

## 10. Gemini API Developer Competition 2024 — 역사적 비교 1개

**Jayu — Best Overall**: Gemini 기반 컴퓨터 보조 경험이라는 공식 소개를 확인했다. 이 조사에서는 세부 런타임을 확인하지 않았으며 최신 2026 기술의 근거로 사용하지 않는다. [Google 공식 수상 발표](https://developers.googleblog.com/en/announcing-the-winners-of-the-gemini-api-developer-competition/)

## 이번 집계에서 제외한 후보와 조사 한계

- ElevenLabs Worldwide Hackathon 2025는 [공식 수상 발표](https://elevenlabs.io/blog/announcing-the-winners-of-the-elevenlabs-worldwide-hackathon)가 있으나 개별 기술 자료 확인 범위를 넓히지 않아 이번 52개 표에서 제외했다. “수상 미확인”과는 다른 이유다.
- DACON 스마트 제조 사례는 [공식 리더보드](https://dacon.io/competitions/official/236655/leaderboard)를 찾았지만, 대회별 최종 수상 확정과 제출 코드·발표 자료를 동일 수준으로 대조하지 못해 기술 비교 집계에서 제외했다.
- Litify·HeatGuard 등 자기소개에 수상 표현이 있는 후보는 이 조사에서 주최사 수상 확인까지 연결하지 못했다. 수상작으로 단정하지 않는다.
- [AI Champion](https://ai-champion.or.kr)의 진행 중인 공고와 원티드의 향후 수상을 기존 수상 결과와 섞지 않았다.
- 공개 자료가 적은 국내 기업 내부 대회, 비공개 repo, 모든 지역·대학 대회를 망라하지 못했다. 미확인 항목은 실패한 기술이나 수상하지 못한 작품이라는 의미가 아니다.

## 이어짐에 대한 비교 해석

이 표본에서 재사용할 가치가 큰 것은 **도메인 근거, 구조화된 행동 계약, 사람이 통제하는 변경, 실패를 드러내는 평가·기록**이다. “다중 에이전트가 많을수록 우수하다”는 결론은 지지되지 않는다. Tekton의 정적 결과물, SimFrancisco의 계산량 제어, SANS의 제한된 도구, Engagement Hub의 승인·중복 방지, AquaLens의 결정론적 점수 분리는 서로 다른 문제에 맞춘 설계다.

이어짐은 원문→관측 사실→제안→사용자 승인→새 revision의 관계를 검증 가능한 상태로 유지하는 방향이 적합하다. 총액·인원 변화의 정확한 계산, 늦게 들어온 정정의 권한, 기존 ID·수동 수정·완료·잠금 보존, 중복 전달과 불확실한 유료 호출 처리가 경쟁력 후보다. 이것은 **설계 판단**이며, 사용자 실험과 새 입력 평가 전까지 경쟁작보다 우수하다는 실증 주장은 하지 않는다.

실제 채택 순서, 최신 연구의 성숙도, 구현 완료와 잔여 범위는 [이어짐 엔지니어링 고도화안](ieojim-engineering-upgrade-2026.md)과 [PLANS](../../PLANS.md)에 기록한다. 원문·모델 응답을 telemetry에 복제하는 대신 private fingerprint와 최소 결정 metadata를 사용한다.
