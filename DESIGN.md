# Design

## September 19 visual critique — current UI direction

- [UI repair contract](docs/design/ui-critic-2026-09-19.md) governs this local refinement and supersedes earlier requirements for simultaneous narrow mobile columns or always-expanded email fields. The product positioning, protections and approval boundaries remain intact.
- Recovery leads with calculated event changes and protected appointments; original notice/evidence is a disclosure. Dirty/blocked results cannot display that success list. A shared centred shell contains hero, progress, comparison and actions.
- Desktop compares two timelines. Mobile shows one readable timeline and explicit before/after selectors. Email composition is optional and collapsed until requested; exact approval still follows its fields. Actual Calendar observations and failures stay visible.
- Preserve SUIT, warm paper and forest-green accents. Keep one visually primary next action; avoid adding more summary panels to solve density. Actual 320/390/1440 screenshots, enlarged-text behaviour and independent reviews are required alongside regression tests.

## September 19 change assurance

- The approved local candidate is [change-assurance-2026-09-19.md](docs/design/change-assurance-2026-09-19.md). Selected clipboard text requires explicit read, preview and import; an existing draft requires a separate replacement confirmation. No automatic clipboard access or AI call on import.
- Recovery shows calculation, local approval, Calendar execution and later observation separately. Historical verified writes remain historical. Latest drift/unavailable/stale observations require attention and cannot be styled as current success.
- After an exact verified Calendar action, manual recheck and explicit opt-in read-only 15-minute/max-24-hour watch are available. No external write is triggered by this panel. Visible consent, an always-available stop for active watches (unless a request is busy), last-check time and bounded expiry are required.
- Source changes, stale approvals, disconnected credentials, missed reads and partial observations remain distinct. Event details use progressive disclosure and the existing warm-paper/green design at 320px and desktop widths.
- Live provider verification and deployment remain separate from local mock-provider tests. Keep the broader browser-executor and proactive mailbox-ingestion roadmap out of implemented product claims.

## Source of truth
- Active direction, 2026-09-14: the competition product addresses changed notices across work, study and personal life. Corporate assistants are one use case and an adoption hypothesis. `docs/design/submission-positioning-2026-09-14.md` supersedes the earlier industry-first positioning. The broad landing/entry refresh is locally implemented; current `/assistants` and coordination implementation remain local, and the public departure story remains the deployed evidence.
- Status: D1–D3, accounts/explicit guest transfer, account usage/export and Google activation are verified (see `PLANS.md`). The September 14 departure story supersedes the prior hero and is deployed to the existing canonical service; delivery evidence is in `PLANS.md`. Commercial lifecycle remains future work.
- Last refreshed: 2026-09-19. Recovery adds separately approved external execution, later read-only observation, and the visual critique above in the local candidate. `PLANS.md` owns the deployed version and validation status.
- Primary product surfaces: introduction, guided first use, workspace home, editable plan, contextual review, login/settings, current-data export and future billing.
- Current implementation: anonymous same-browser workspace with a landing route, home, deep-linked workspaces, scoped CSS and interaction-gated WebGL2. Google account/session adapter, explicit guest transfer, account usage display and JSON v1 current-plan/source export are implemented; no billing. Actual Google provider roundtrip was verified on September 10.
- Evidence: AGENTS.md, PLANS.md, AppRouter.tsx, landing/, workspace/, scene/, core contracts/engine, server ownership/retention, premium browser screenshots and .omx/verification-premium-frontend.json. Historical concept remains separate from screenshots.
- Detailed decisions: docs/design/commercial-product-direction-2026-09-09.md.
- Desktop review (>1180px) scrolls inside a focusable inspector below the sticky tabs/status, preserving the current plan for comparison. Mobile/tablet use document flow. Page Down/comparison regression is in `tests/e2e/impact-review.spec.ts`.
- External user recruitment and alert delivery are deferred by the user; neither blocks this design phase nor is marked verified.

## Brand
- Personality: confident, thoughtful and tactile; a service people can return to daily.
- Central promise: “계획은 바뀌어도, 내 결정은 그대로.”
- Trust signals: evidence near decisions, visible protection, precise before/after values, understandable save/recovery and data ownership.
- Avoid: fake customer results, unreadable glowing scenes, invented usage counters, dead signup/payment controls and implementation jargon in primary navigation.
- Competition attribution belongs in a secondary about/footer area; the first impression communicates product value.

## Product goals
- Next milestone: show one common changed-notice problem with work/study/life entry points and a role-neutral real-source path. Preparation metadata and review are already locally implemented for all checklists. Calendar dispatch, multi-user delegation and institutional integrations remain subsequent milestones.
- Immediate: make the value understandable to anyone maintaining a plan from changing external instructions; use three concrete examples with one shared approval and preservation workflow.
- Near term: saved workspaces, onboarding, navigation and contextual review suitable for repeat use.
- Commercial destination: real accounts, safe guest transfer, explicit retention, usage/plan visibility and verified billing lifecycle.
- Non-goals for this design phase: arbitrary app generation, booking/messaging, collaboration or collecting payments.
- Success signals: understand the promise from the first screen; reach a usable first workspace through one guided flow; inspect evidence, approve, reload and recover without losing decisions.
- These are proposed acceptance goals, not measured human outcomes.

## Personas and jobs
- Core persona: a person who receives changed notices and must update a plan without losing decisions or completed work. Work, study and life are three evidence contexts. A small-company assistant/operations coordinator remains one potential commercial adopter; executive-account delegation is not implemented.
- First-time visitor: understand value and try the product without learning the internal data model.
- Returning individual: find a plan, bring new information, review consequences and continue work.
- Judge: see a short credible demonstration of changing inputs, recalculation and preserved decisions.
- Future customer: access owned data across devices/sessions, understand current limits, export current plan/source data and control deletion.
- Main travel and second assignment scenarios share the engine and generic product shell.

## Information architecture
- `/assistants`: focused corporate meeting-preparation introduction with real `template=coordination` entry and explicit synthetic `example=coordination` entry. No automatic creation/model invocation. Existing `/` gains a visible link to this workflow; established travel examples remain usable.
- `/app?template=coordination` and `/app?example=coordination`: corporate setup copy, selectable existing templates, source-based generation and explicit sample creation. Preparation settings are available to checklist items in any workspace, so usefulness is not fixture-only.
- `/`: departure-eve changes and two protected-state decisions, with a labeled engine-backed browser preview and optional secondary 3D explanation. Primary “내 여행 정리하기” links to `/app?template=travel`; secondary “복합 예시로 직접 확인하기” links to `/app?example=departure`. Navigation alone never creates a record or calls a model.
- `/app`: recent workspaces, intentional empty state, primary creation action and explicit synthetic travel-coordinator entry. A page load or link navigation must not create or auto-open a workspace; sample creation stays behind a user-activated button.
- `/app/workspaces/:id`: compact navigation, broad plan canvas and contextual source/review inspector.
- Plan, source and history are accessible views; creation/deletion no longer occupy permanent peer columns.
- Guided creation: purpose → initial source → first result review. Later source relation/target remain explicit, with Korean explanations for addition, correction and replacement authority.
- `/login`: Google login or an honest unavailable state with guest entry. `/settings`: verified identity, seven-day session expiry, other-session revocation/logout, explicit guest preview/confirmation, real account usage, UTC daily AI reset and workspace expiry links. Billing remains future scope.
- These paths are implemented. The URL selects a workspace; home lists saved workspaces without auto-opening one. Browser navigation and failed links have regression coverage.

## Design principles
- Show one primary next action in each state; keep evidence and protection adjacent to approval.
- Animate actual changed-input/affected-output relationships, preserving visual object identity.
- Never depict an unrelated protected item as a dependency of the changed fact.
- DOM plan canvas is the working surface. 3D is progressive enhancement and an optional explanation.
- Use a contextual inspector instead of permanently presenting all forms, history and controls together.
- Tradeoff: dark introduction establishes identity; bright work canvas supports sustained reading/editing.

## Visual language
- Color: charcoal/ink-green introduction #101b18, warm work canvas #fbfaf7, emerald commands, mint preservation, amber conflict and red destructive actions.
- Typography: self-hosted SUIT Variable under SIL OFL, with system sans-serif fallback and optional font display. Korean headings keep words together. Generated concept letterforms are not font assets.
- Spacing: compact navigation, generous canvas, consistent 4/8 scale and differentiated heading/content/metadata density.
- Shape/elevation: 10–16px content surfaces where useful, thin borders and selective elevation for active review; avoid borders around every nested element.
- Motion: CSS control transitions and a 1.6-second user-triggered scene, with pause/reset and offscreen suspension. Pending/review/applied labels come from real run state.
- Imagery: bespoke source/plan/decision scene, mainly procedural geometry/local assets. Concept travel scenery is optional art direction, not a new runtime/domain requirement.
- Keep lucide-react operational icons.

## Components
- New preparation panel: checklist work only; explicit user due date and estimated minutes, completed/missing/stale states, a visible reference date and clear local-save feedback. No auto-filled AI estimates or calendar-sync badges. Existing note blocks can hold model-proposed preparation notes; a generic document agent is not part of this milestone.
- Reuse behaviors: SourceComposer, WorkspaceBlock, ProposalReview, ImpactSummary, ProtectedStateLedger, ChangeRow, EvidenceDetails, HistoryPanel and WorkspaceExportButton.
- Implemented modules: AppRouter, ProductLanding, ContinuityScene/ContinuityCanvas, WorkspaceApp and its existing source/plan/review/history components.
- Current boundaries: src/client/landing/, workspace/, scene/, account/ and base.css; the domain engine and server stay separate. Preserve request/selection/concurrency safeguards when splitting the large WorkspaceApp module in future work.
- Keep shared CSS tokens; no new CSS framework or general state library is required solely for redesign.
- States: loading, empty, unavailable, pending/running, needs input, ready, conflict, stale, locked, completed, edited, preserved, failed and uncertain.

## Accessibility
- Semantic DOM owns headings, values, navigation, forms, evidence and approval; canvas is never the only access path.
- Scene actions have keyboard-operable equivalents; manage focus through inspector/route transitions.
- State uses labels/icons as well as color; measure contrast for text/controls.
- Respect prefers-reduced-motion: replace camera/parallax with instant/minimal-opacity state changes; provide pause/replay for illustrative sequences.
- WebGL failure/context loss/initialization failure produces useful static/DOM fallback. Editing and approval keep working.
- Preserve appropriate role=alert and aria-live/status announcements.

## Responsive behavior
- Desktop: compact sidebar, broad canvas and contextual review inspector.
- Tablet: one-column canvas with contextual panels. Mobile has compact home/create navigation and one active task panel; full workspace selection stays available on home.
- Mobile: one active view with plan/source/review navigation and reachable primary action, rather than one long stack of desktop panels.
- Scene: reduced detail on constrained devices, no mandatory hover/drag, complete 2D fallback.
- Target 44px primary touch controls, no horizontal overflow at 320px, and no truncation of critical values.

## Interaction states
- First visit: value, labeled illustrative example and working actual guest entry. The first guided sample is synthetic and says so; it is not presented as live AI accuracy evidence.
- Returning visit: home requires an explicit selection; a workspace URL reloads that record. Unsaved drafts survive in-app workspace/home navigation, not a full reload or tab close.
- Loading: show actual run states. Clear the previous record when changing workspace URLs. Accept server results and switch panels together, before any secondary list refresh; a late list response cannot move the user to another panel.
- Success: committed state comes from API response/re-read. Never announce successful apply before server confirmation.
- Preview: resolveChangeSet remains authoritative for selected choices; proposed and committed states stay distinguishable.
- Approved copy: only a current committed `apply_changeset` revision can expose a local change brief. Read the owner-scoped export with current plus immediately preceding snapshot (maximum two), validate it, and derive actual differences. Hide after manual edits/restores; missing base fails with an explanation. Clipboard rejection retains the preview for manual selection. Copying is not external delivery.
- Error/offline: retain inputs, decisions and useful focus/scroll. Uncertain model outcomes never trigger an automatic paid retry.
- Disabled: explain unresolved conflicts or missing information preventing approval.
- Evidence: show actual stored quote; label calculation explanation separately from source text.
- Clarification: retain source-based answers and stale-context checks.
- Deletion/restore: individual workspace deletion is explicit; content restore keeps content-only semantics. Account-wide erasure remains future scope.

## Content voice
- Korean, clear and product-facing: 원문, 변경안, 고정, 확인 필요, 내 결정 유지, 변경 이력.
- Explain validation in terms of the next user action; never expose private payloads.
- Label illustrative scenes and saved examples. Generated concepts are not working feature screenshots.
- Exact demo arithmetic: total KRW 900,000; per-person KRW 225,000 for four and KRW 300,000 for three; protected dinner is day two at 19:00. Review copy prioritizes required choice, before/after value and stored evidence, and derives Korean explanations from typed statuses/conflict kinds rather than raw internal reason strings.
- Show pricing/long-term retention promises only after corresponding policies are implemented and accepted. Current account retention remains seven-day inactivity cleanup.

### September 15 final Korean copy pass
- User direction: approachable language a junior data engineer could explain in person, with enough concrete engineering detail for judges. Use short, natural Korean; helpful 해요체 for descriptions and familiar action labels. Avoid slang, inflated claims and repetitive rhetorical contrasts.
- First-screen hook: “일정 하나 바뀌었다고, 처음부터 다시 짜지 마세요.” Follow immediately with changed-notice input, Gemini finding changes and source evidence, and the user's review before applying changes.
- Explain the actual division of work: AI reads the notice and proposes facts/changes; TypeScript code checks references, calculations, protected items and plan versions. Schedule adjustment uses times/availability explicitly confirmed by the user. Approval saves changes; external Calendar/email actions require their separate connection and approval. No claim that AI continuously optimizes or autonomously contacts people.
- Terminology: 합성 예시 → 체험용 예시 (retain the statement that this is prepared sample data without a live AI call); 수습안/복구안 → 일정 조정안; 원문 means the notice the user pasted; conflicts involving protected work → 확인이 필요한 변경 (use 일정 겹침 only for actual time overlap); snapshots → 저장된 계획; outbox/receipts/readback → 처리 기록/실제로 저장됐는지 확인.
- Preserve useful terms: AI, Gemini, TypeScript, Google Calendar, API where technically relevant, 원문, 버전, 고정, 변경 이력. Put implementation detail in the how-it-works explanation, not every button or success toast.
- All routes and supporting empty/loading/error/consent states are in scope. Do not edit pasted source text, stored fixture evidence, identifiers, request/schema keys, model prompts, policies or behavior to make copy easier. Legal copy can be clarified without changing retention, consent, provider handling or user rights.
- Root archived all source/tests in `.omx/criteria/final-copy-2026-09-15/before/`. Existing browser/unit assertions may update exact display wording/selectors only; preserve route targets, state/permission assertions, counts and timing. Root coordinates test wording migration and solely owns runners and deployment. Human-facing API/scheduler errors and new outgoing Calendar descriptions may be reworded; preserve error codes, control flow, stored evidence, action boundaries and algorithms. A copy-only OMX pass uses independent baseline/diff review, full verification, desktop/mobile browser inspection and release checks; no additional paid model test is needed.

## Implementation constraints
- Keep TypeScript, React/Vite, Hono, Workers, D1 and Queue.
- 3D: Three.js 0.186.0 + React Three Fiber 9.7.0 for React 19, no Drei or remote textures. A DOM illustration remains available without WebGL.
- UI motion: CSS transitions. Motion/Motion+ are not installed or required.
- Lazy-load scene separately from the working app; pause offscreen/hidden animation, cap DPR, demand-render when idle and dispose resources.
- Initial engineering targets: landing LCP ≤2.5s, INP ≤200ms, CLS ≤0.1 on a named test profile; initial compressed scene/assets target ≤1MB. These are not current measurements or field p75 claims.
- Reduce scene complexity or use fallback if budgets fail; never delay the primary action until WebGL is ready.
- Keep owner isolation, stable IDs, exact revisions, atomic approval, evidence validity, seven-day guest expiry and paid-call safeguards.
- Accounts currently preserve cross-session ownership through server sessions and account-owner links, but still use the seven-day inactivity retention policy. Durable paid storage, account erasure and long-term retention require separate contracts.
- Browser acceptance: guest creation/edit/lock/review/apply/reload/history/delete, cross-owner isolation, keyboard/focus, mobile overflow, reduced motion and failed-WebGL path; use isolated test servers.

## Open questions
- [ ] Visual preference: dark introduction + light workspace is a working assumption until user preference; concept is not a pixel-approved baseline.
- [x] Typeface: SUIT Variable selected, self-hosted with its license and inspected in browser.
- [x] Initial provider: Google through pinned Better Auth 1.7.3 with D1 sessions. Operator configuration and real provider roundtrip verified September 10; see `PLANS.md`.
- [x] Guest transfer design: exact preview/current account, explicit consent and atomic idempotent claim, preserving owner buckets and ledgers. Changed previews require renewed consent; successful claim revokes old guest credentials.
- [ ] Account retention: select and migrate before promising durable paid storage. Current account workspaces still expire after seven days of inactivity.
- [ ] Billing: seller jurisdiction/provider, limits, pricing and failure/cancellation/refund behavior need a commercial specification before collection.
- [ ] External human trials and notification destination are deferred by user choice; revisit at launch readiness.

## September 13 product-outcome slice
- Audience: travel/group coordinator remains the working first customer. A possible company-workshop pivot is an optional user question, not a prerequisite or implemented claim.
- Job: after new information arrives, understand the consequences, protect prior decisions and leave with an accurate message to send to companions.
- Landing: warm editorial command desk inside the existing ink-green brand; prominent human outcome, readable incoming message, before/after cost, protected dinner and message preview in the first desktop viewport. A user-operated illustration switches between review and resulting message; it is explicitly synthetic, API-silent, and never simulates live AI processing. Keep exact 900,000 / 4 → 3 arithmetic. 3D is secondary and retains its accessible fallback.
- Guided entry: travel/custom purpose templates, clearly ordered create → source → review steps, editable fields and explicit create button. Example route emphasizes the existing explicit synthetic sample action. Existing personal drafts and custom use remain available; URL reads cause no database mutation. Honest guest retention information stays visible.
- Current-plan brief: a prominent plan-panel action reveals a preview and copy control derived from the owner-scoped export, validated against checksum, schema, workspace ID and current content revision. Only saved values are included; pending proposals are excluded. Label it “현재 저장된 계획”, never “모두 승인·합의된 계획”. Notes are excluded by default and may be included deliberately. Clipboard denial retains a selectable preview. Stale scope/late requests cannot copy another workspace or revision. This is local copy, without public links or external delivery.
- Existing approved-change brief remains stricter: current `apply_changeset` and previous snapshot are required. Full-plan copy must not weaken that contract.
- Acceptance: no mutations from landing/URL/template selection; usable explicit guided start; actual scoped full-plan output and clipboard fallback; existing approval/edit/recovery/ownership regressions; keyboard/reduced-motion/320px and desktop screenshot review. Required `npm run verify`, isolated browser suite, independent code review and recorded evidence.
- Non-goals: pricing, payment, collaboration, bookings, outbound notifications, new infrastructure, server/model contract changes, or claims of measured willingness to pay.

## September 14 departure-change story
- User correction: arithmetic-first hero is not persuasive. Show the work of maintaining decisions across simultaneous changes, not more complicated arithmetic or unsupported planning intelligence. This section supersedes the September 13 illustrative hero, while retaining its guided entry and current-plan-copy functions.
- Story: a synthetic departure-eve correction changes travelers 4→3, arrival 10:00→16:00, proposes locked dinner 19:00→20:00 and removal of an already completed paper-confirmation task. A manually edited companion note remains intact but needs review. Cost is a secondary deterministic consequence. One pasted correction contains these instructions; do not claim external chat/booking ingestion or independently authenticated providers.
- First screen: show the unexpected changes, visible protected-state consequences, and two unresolved decisions. Let a visitor inspect real quotes, choose each conflict, then compare the engine-resolved result. Progressive disclosure keeps it understandable; avoid a wall of infrastructure jargon.
- Demonstration truth: interactive results use the production core buildChangeSet/resolveChangeSet and the same fixture as the saved demo. Load the engine on explicit interaction. Label browser preview as synthetic and memory-only, not a live AI call, database transaction, or saved result. No fake loading/progress/confidence scores.
- Persistence bridge: `/app?example=departure` highlights an explicit **출발 전날 복합 체험 시작** button. Only clicking creates the new `departure` synthetic workspace. Existing travel/syllabus samples retain their exact data and behavior. The database already has sample_scenario; extend its accepted value without a migration. Prepare locked/edited/completed fixture state before the existing atomic create.
- Saved demo: same correction and two conflicts use the real scoped sample-update/apply/restore endpoints. Existing exact-base, idempotency, owner isolation, retention, budgets and immutable source behavior remain authoritative. Home/landing queries never write. The workspace identifies the scenario through existing persisted sampleScenario, never mutable display titles.
- Visuals: extend ink-green/warm-paper brand with a clear source→affected items→human decision arrangement. Keep all critical values and both choices readable at 320/390/1440/1600. Semantic DOM, keyboard controls and reduced-motion defaults. Existing optional 3D remains secondary.
- Acceptance: two real unresolved conflicts block result confirmation; all four choice combinations produce the expected actual snapshot; manual note and stable IDs survive; evidence points to real source substrings; no API/model call from landing interaction; saved fixture survives reload, applies once and restores content as a new revision; old samples pass regressions.
- Evaluation contract change: old hero wording/toggle assertions intentionally need revision for this user-requested story. Review those criteria explicitly rather than freeze obsolete selectors in a repair loop. OMX owns this bounded feature; no new local loop controller is initialized against incompatible old visual criteria.

## September 14 horizontal product implementation
- This user-approved implementation supersedes the narrow first-screen positioning above. Generic product promise and primary CTA “내 안내로 시작하기” → `/app?template=custom`; bare `/app` defaults to custom. Headline “새 안내를 반영해도, 내 결정은 이어집니다” stays. Work/study/life are applications of one engine, not separate apps.
- Three visible entry cards: 업무·프로젝트 → `/app?example=coordination`; 학업·과제 → `/app?example=syllabus`; 생활·약속 → `/app?example=departure`. Navigation alone is read-only. Real-source creation must remain free of synthetic data.
- Hero representative: synthetic customer presentation/meeting correction backed by existing coordination text: meeting14→16, briefing13→15 proposal against locked13, materials9/17→9/16, room change, completed print removal. Explicit user-started browser preview uses the same core; two choices before result, real quotes, preserved due/estimate and note warning. No persistence/API/model. Existing departure preview moves into a secondary life example with intact controls and links. 3D stays optional and secondary.
- New generic home heading: “내 계획, 여기서 이어가세요.” Explicit travel/departure context keeps travel heading; coordination keeps meeting; syllabus gets assignment context. Template drafts remain per-template across navigation. User can switch contexts without creating anything.
- Appearance: retain ink-green/warm-paper/SUIT. Generic story and role-neutral CTA precede scenario detail. Readable change cards and source/user-state labels; no fake progress/confidence. Three equal context links and accessible keyboard controls.
- Root owns browser/build/verify runners. Prior loop receipts stay historical. Bare `/app` heading expectations are explicitly reviewed before initializing the new frozen loop; all behavioral invariants and existing concrete scenario controls remain protected.

## September 15 dense-schedule recovery
- The approved scope is `.omx/plans/change-recovery-experience-2026-09-15.md`. `/recovery` is an explicit, synthetic Sept17/18 two-day timetable. The initial screen explains the incoming change, impacted presentation/travel/preparation, movable expense task and protected appointments. Chronological before/after views are derived from the real bounded solver. Closed constraints show a blocker instead of a misleading successful timetable.
- Work/study/life remain the general product positioning. This slice adds a representative recovery experience and a landing entry; it does not claim arbitrary natural-language scheduling, institutional integration or multi-user consent.
- Editable confirmed preparation duration and free-window availability recompute locally. Saved workspaces retain edits as drafts until explicit recompute; exact workspace/source/condition/proposal revisions gate approval. Saving, recalculating and applying survive reload and lost responses without duplicate revisions.
- Original source evidence lives behind an accessible details control. A protected appointment remains visible and unchanged. Desktop and 320px layouts use semantic DOM and the existing warm-paper/green brand. No fake AI processing, timers or invented confidence.
- Calendar connection is separate from Google login. Dedicated app calendar only, primary availability check, bounded app-event inventory, etag preflight, per-event readback and actual queued/executing/verified/partial-failure statuses. Real-time expiry blocks writing past changes. Email starts with no recipient and shows the exact change-only body for separate approval; accepted means provider acceptance, not delivery or consent.
- Ops boundaries, limitations and live readiness: `docs/operations/change-recovery-2026-09-15.md`. Fixed synthetic dates, 30 events/48h/at most one flexible move, seven-day workspace retention, no auto resend on unknown results, no rollback of external side effects, and no live verification claim from fixtures.

## September 15 notice recovery setup

- Entry: an approved source workspace exposes “이 안내로 일정 재배치”. The setup page shows the selected source and evidence-linked AI facts, then asks for missing execution constraints. Full date/time semantics are suggestions, never availability or authority.
- Recovery is a separate linked workspace. Its review uses actual event titles, calendar dates, source text and user-confirmed conditions. Original notices and user decisions remain in the source workspace. Recoveries cannot become the origin of another recovery.
- Required confirmation covers baseline and changed intervals, preparation duration/deadline, travel time, the planning horizon, available windows and all other schedule commitments. Defaults must not introduce example appointments or invented free time. Protected/manual state comes from the server.
- Existing source mode remains visible. Fixture-origin recovery is labelled as synthetic source; deterministic setup does not create a model run or imply another AI call. A saved notice recovery has read-only conditions and a link to start a newly confirmed plan from the origin.
- Loading or losing access to a saved recovery shows a pending/error state rather than sample content. Changed or deleted origins show a blocked result with no approval or external execution. Success summaries use actual protected counts and event titles.
- Keep the existing synthetic example and its controls intact. Scope remains Seoul, 48 hours, 30 intervals and at most one movable other task. Details: `docs/design/notice-recovery-bridge-2026-09-15.md`.

## September 15 UI hardening
- User requested strict independent agent review and correction of broken/cluttered UI. This visual refinement supersedes the earlier dense presentation, preserving the existing routes, labels, domain behavior and approval boundaries. Evidence: `artifacts/ui-hardening-2026-09-15/before/` and the new failing browser cases in `before-regressions/`.
- Observed defects: recovery time ranges wrap at desktop/tablet widths, mobile navigation touch targets are too small, email approval precedes its detached body, and the mobile preparation heading breaks because a flex row incorrectly receives grid-only responsive rules. Initial pages have no document overflow; this does not establish readable child content. Recovery reaches 5610px at390px wide and presents all stages with equal visual weight.
- Recovery hierarchy: compact introduction and actual change outcome, editable conditions with longer explanation disclosed on demand, readable before/after comparison, local save/approval, then separately labeled optional external actions. Keep fixed appointments, source evidence and failure reasons accessible. Never hide an infeasible or stale state behind success styling.
- Typography: existing SUIT and ink-green/warm-paper tokens, 400–500 body text, 600–700 labels/headings and selective 800 emphasis. Avoid blanket900 weights and long oversized headings. Separate sections with whitespace and light dividers; reserve filled green for the primary current action. Avoid shadows and borders on every nested row.
- Time ranges remain on one line using intrinsic column sizing/tabular numerals; compact rows retain title and protected/moved labels. Desktop comparison uses two columns only when each has enough readable space. Mobile must expose the changed outcome before long repeated explanation. No critical content is clipped to hide overflow.
- Email recipient, subject and body appear inside the email action panel before the exact-approval checkbox and send action. Fields remain directly accessible in the established saved workflow. Local approvals, connected-provider status and provider acceptance retain separate honest labels.
- Workspace: show the actual saved plan before auxiliary preparation editing and sharing tools where practical; preserve their state, labels and keyboard access. Preparation section header adapts its real layout mode and does not squeeze the title against long metadata. Shared navigation, form controls and scope selectors must survive client-side route changes.
- Accessibility/responsiveness: 44px primary/navigation/checkbox-label targets; visible high-contrast focus; actual DOM reading/focus order matches the visual action order. Inspect320/390/768/1024/1440 widths and enlarged text. Maintain original reduced-motion and WebGL failure contracts. No new package/framework, API, paid call or animation is required.
- Verification: root owns all browser/build runners. Preserve existing tests/config; add concrete regressions, run the fixed deterministic gate and complete Chromium suite, inspect fresh screenshots and obtain independent code/visual review. Local preview is separate from the currently deployed public version. No new product claims or deployment follow from UI completion.

## September 16 product usefulness
- The primary interactive example now follows changed presentation materials after preparation was completed. Use the actual core engine in memory; show what needs another check while retaining completion history, fixed decisions and manual notes. Never imply live AI, persistence, delivery or measured savings. Keep the earlier locked/deletion preview in a closed, keyboard-accessible disclosure labelled “고정한 일정과 완료 기록을 바꾸려 할 때”; preserve its fixture and tests.
- A changed completed checklist item becomes review-required, not silently complete for the new content. Explicit actions distinguish retaining completion after review from reopening the task. Ordinary text/flag edits are not acknowledgement. Existing deletion conflicts and exact-revision approval remain.
- Notice setup reuses only unambiguous evidence-backed full datetimes and saved preparation metadata. Show provenance; preserve user-entered drafts including deliberate blanks, reset on source/target changes, and ask for missing interval ends, travel and availability. No guessed year, timezone, duration or free time.
- Retain SUIT, ink-green and warm-paper surfaces, readable compact change rows, keyboard access and 320px layout. Load demo logic only on explicit interaction.
- Validate usefulness with a full-task paired manual/service protocol recording corrections, missed changes, failures and participant type. Self-use and synthetic tests cannot establish independent demand or general time savings. No hidden analytics or third-party recruitment.
