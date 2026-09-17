# Ieojim agent integration feasibility notes

Date: 2026-09-14

Purpose: decide which Korean life-agent integrations are realistic for a one-person product wedge. This is product and engineering feasibility research, not legal advice.

## Executive synthesis

Ieojim should not position the first paid version as an agent that automatically reads every KakaoTalk room or every personal Naver mailbox. The public official docs reviewed here support a narrower, more credible path: user-initiated input, copy/paste, later forwarding to a dedicated inbox, and explicitly approved calendar writes.

The strongest wedge is therefore: "When a user forwards or shares a changing notice, Ieojim turns it into an evidence-linked change proposal and asks before touching protected commitments." This fits the current product invariant better than a universal personal-data ingestion promise, and it keeps review burden, privacy risk, and one-person operating cost lower.

After the latest product direction, the first true external execution MVP should be Google Calendar only. Other channels can feed evidence into Ieojim, but they should not execute actions yet.

## Calendar-only external execution MVP

Recommended first action surface: create one Ieojim-owned secondary Google Calendar per connected user, then create/update/delete only events on that app-created calendar after explicit user approval.

Why this is the right first external action:

- It demonstrates a real agentic loop: source change -> proposed schedule delta -> protected-user-decision conflict check -> approved external action -> reconciled provider state.
- It avoids the unbounded promise of controlling every personal app.
- It is reversible enough for an MVP: calendar events can be updated or deleted as compensating actions if Ieojim stores the provider calendar ID, event ID, etag, and approval/action ledger.
- It is low blast radius: do not touch the user's primary calendar or existing personal calendars in the first version.

Official facts to anchor the implementation:

- Google Calendar exposes `https://www.googleapis.com/auth/calendar.app.created`, whose meaning is: make secondary Google calendars, and see, create, change, and delete events on them. Source: https://developers.google.com/workspace/calendar/api/auth
- `Calendars.insert` creates a secondary calendar, and the authenticated user becomes the data owner. It accepts `calendar.app.created` as one of the authorization scopes. Source: https://developers.google.com/workspace/calendar/api/v3/reference/calendars/insert
- `Events.insert` accepts `calendar.app.created`, and Google explicitly says client-supplied event IDs help keep local database entities in sync and prevent duplicate event creation if the operation succeeds in Calendar but fails before the client observes success. Source: https://developers.google.com/workspace/calendar/api/guides/create-events
- Event IDs must be 5 to 1024 chars, use base32hex characters (`a-v`, `0-9`), and be unique per calendar. Google warns global distribution means collisions may not always be detected at creation time, so use an established UUID algorithm to reduce collision risk. Source: https://developers.google.com/workspace/calendar/api/v3/reference/events/insert
- If an insert hits an existing identifier, Google documents HTTP 409 with reason `duplicate`; the suggested action is to generate a new ID for a new instance, or use update if this is the same logical instance. Source: https://developers.google.com/workspace/calendar/api/guides/errors
- Calendar resources expose etags. For update/delete, Google supports `If-Match`; if the resource changed after retrieval, the API returns 412 Precondition Failed. This should be treated as a conflict/reconcile path, not a blind overwrite. Source: https://developers.google.com/workspace/calendar/api/guides/version-resources
- For `Events.insert`, `sendUpdates` controls creation notifications. Google documents `all`, `externalOnly`, and `none`; it also says some emails might still be sent, the default is `false`, and `none` can cause external-calendar sync/loss issues for some users. Source: https://developers.google.com/workspace/calendar/api/v3/reference/events/insert
- For `Events.delete`, `sendUpdates=none` means no deletion notifications; the delete endpoint also supports `calendar.app.created`. Source: https://developers.google.com/workspace/calendar/api/v3/reference/events/delete

MVP policy:

- Use `calendar.app.created`, not full `calendar`, unless implementation discovers a blocking limitation.
- Create a dedicated calendar named like `Ieojim` or `이어짐`.
- Use deterministic, app-generated event IDs from Ieojim block/proposal IDs converted to a valid base32hex-safe format.
- Do not add attendees in v1. This avoids invite email semantics and keeps `sendUpdates` mostly irrelevant. If attendees are ever added, never promise "no email" as a hard guarantee because Google says some emails may still be sent for creation/update notification settings.
- For insert timeout/unknown outcome: first `events.get(calendarId, eventId)` by deterministic ID. A found event is not automatically success; only mark success if approval identity, operation identity, expected owner/calendar, event ID, and approved payload or provider metadata match the action ledger. If 404, perform bounded reconciliation, then retry insert with the same event ID and idempotency ledger. If 409 duplicate, never blindly update; fetch by ID and reconcile whether this is the same approved operation before deciding between success, conflict, or a new operation.
- Calendar creation bootstrap has its own unknown-outcome problem. A timeout after `Calendars.insert` may leave a secondary calendar created without a locally persisted ID. The MVP needs a separate bootstrap reconciliation strategy before rollout, such as a stored setup operation ledger and a bounded lookup/confirmation flow, because event-level deterministic IDs do not solve duplicate calendar creation.
- For update: fetch current event, compare stored etag, update with `If-Match`. On 412, refetch and present a conflict if the provider event was changed outside Ieojim.
- For delete/undo: use a compensating delete only for Ieojim-created events. Local content restore does not imply external undo. External delete has its own approval, ledger row, provider response, and failure state.
- Never claim external messages are undoable. Calendar is the only bounded reversible action in this MVP.

## Verified integration boundaries

### KakaoTalk

Verified from Kakao Developers: KakaoTalk Message is a sending feature between users of the same service, or to oneself. Sending to friends requires additional permission, Kakao Login consent items, Biz app review, and a concrete reviewed usage scenario. Kakao's public docs describe Share and Message as send/share flows; they do not document arbitrary personal chat-history reading for third-party apps.

KakaoTalk Share is also user-driven: the service prepares content, KakaoTalk opens, and the user selects the friend or chatroom. Kakao's comparison table says Share does not support REST API, while Message supports REST API but requires permission. The same table states both Kakao Developers Share and Message are user-to-user features, and services cannot send directly to users through those products.

Product implication: KakaoTalk Share is an outbound share/send surface from Ieojim to KakaoTalk, not the same thing as "share a KakaoTalk message into Ieojim." Do not build the core story around "Ieojim reads your KakaoTalk chats." If Kakao Business products are considered later, treat them as a separate channel-message project with review, templates, business approval, and message-ledger requirements.

Source: https://developers.kakao.com/docs/en/kakaotalk-message/common

### Naver personal email

Verified from Naver Developers: the public OpenAPI list includes Naver Login profile lookup, Cafe, Calendar create, DataLab, Search, captcha, and share APIs. The reviewed public Naver Developers OpenAPI list does not present a personal Naver Mail read API comparable to Gmail API.

Naver Help separately documents POP3/IMAP/SMTP settings for external mail clients after the user enables the feature in Naver Mail settings. That is feasible as a user-configured mail-client style integration, but it is not the same as a low-friction OAuth API through Naver Developers. It would introduce credential/security support burden and should not be the first default onboarding path.

Product implication: an Ieojim forwarding inbox is feasible as a future product path, but it is not implemented today. Direct Naver IMAP can remain an advanced, opt-in connector after we have deletion, retention, least-privilege storage, and support docs.

Sources:
- https://developers.naver.com/docs/common/openapiguide/apilist.md
- https://help.naver.com/service/30029/contents/21344?lang=ko

### Gmail

Verified from Google: Gmail API scopes should be as narrow as possible. Google classifies broad Gmail access as restricted, and if an app stores or transmits restricted-scope data on servers, it must go through a security assessment. This can add review time, policy work, security evidence, and likely external cost.

Product implication: avoid Gmail read scopes for the first paid wedge unless email ingestion becomes the highest-confidence channel. Prefer manual paste now; treat inbound forwarding, upload, and share-target flows as future ingestion work until they are implemented. If Gmail sync is later added, design it as a separate premium connector with strict scope minimization, retention controls, audit logs, user deletion, and a launch plan that accounts for verification.

Source: https://developers.google.com/workspace/gmail/api/auth/scopes

### Calendar writes

Verified from Google Calendar endpoint references: creating and deleting Google Calendar events does not require the full `https://www.googleapis.com/auth/calendar` scope when the app confines itself to an app-created secondary calendar. `Events.insert` and `Events.delete` both accept `https://www.googleapis.com/auth/calendar.app.created`; `Calendars.insert` also accepts that scope for creating the secondary calendar.

Product implication: the stronger MVP path is narrower than the older full-calendar write assumption. Prefer `calendar.app.created` with a dedicated secondary calendar, and only fall back to broader scopes if testing proves a necessary user-visible behavior cannot work. Store provider event IDs, etags, base proposal IDs, idempotency keys, and the exact source revision that caused the action. Local Ieojim undo can reverse our local state, but it cannot magically undo external side effects unless we perform a compensating provider action while still authorized. Calendar events can be updated/deleted if we retain the event ID and permission; external messages should be treated as sent and immutable from our product's perspective.

Sources:
- https://developers.google.com/workspace/calendar/api/v3/reference/calendars/insert
- https://developers.google.com/workspace/calendar/api/v3/reference/events/insert
- https://developers.google.com/workspace/calendar/api/v3/reference/events/delete

### Smartphone share/paste and PWA share target

Verified from W3C: the Web Share API lets a site share text, links, and other content to a user-chosen destination; share targets are supplied by the user agent or operating system. The Web Share Target spec lets a website declare itself as a target for shared content through its Web App Manifest.

Product implication: mobile-first ingestion should start with paste because it is already within the current product shape. Upload, forwarding inbox, and PWA/native share-to-Ieojim are future ingestion surfaces until implemented. PWA Web Share Target support must be verified on the target browsers/platforms before promising it, because support is user-agent/platform dependent.

Source: https://w3c.github.io/web-share-target/level-2/

## Wedge recommendation

Choose a user-initiated ingestion wedge first:

1. Paste a notice into Ieojim first; add upload, share target, and forwarding inbox later after platform support and implementation are verified.
2. Extract evidence-linked facts.
3. Show exactly which schedules, costs, checklist items, and notes changed.
4. Protect locked decisions, completed tasks, and manual edits.
5. Ask for explicit approval before creating or updating app-owned Google Calendar events.

This is more defensible than a universal "AI reads all your apps" story. It also makes the product cheaper to operate as a solo founder because the first version avoids Kakao private-channel ambiguity, Gmail restricted-scope review, Naver IMAP support load, and broad external-action liability.

## Needs confirmation before implementation

- Whether any private Kakao partner program exists that would permit chat-history style ingestion. No such public official API was found in the reviewed Kakao Developers docs.
- Whether Naver personal-mail IMAP access can meet the product's desired consent, credential, and deletion posture without unacceptable support burden.
- Which inbound email provider or Cloudflare email path best fits Ieojim's current Cloudflare Workers/D1/Queue architecture. This note intentionally does not choose a provider.
- Whether Google Calendar write access is worth adding before we have enough active users to validate that calendar actions are a paid conversion driver.

## Engineering constraints for future external actions

Every external action should have an action ledger:

- provider, account, target resource, provider resource ID
- source revision IDs and proposal ID
- idempotency key and request hash
- before/after payload summary
- status: proposed, approved, dispatched, confirmed, failed, compensating, compensated
- human approval timestamp and actor

Never bind "restore Ieojim content" to "undo all provider actions." Local restore should restore local content as a new revision. External undo should be a separate compensating operation with its own approval, idempotency key, provider response, and failure state.
