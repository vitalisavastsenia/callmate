# CallMate backend to UI message contract

Status: proposed rules, formats, and examples for implementation review. Updated: 2026-10-15. This document adds no application implementation.

Engineer 2 produces these messages; Engineer 1 consumes them. Engineer 3 supplies conversation and booking information to the backend through the internal dialogue ports. The browser receives application messages, never raw Twilio/OpenAI events.

Exact field definitions remain in [Shared interfaces v1](interfaces.md) and the existing [schemas](../packages/contracts/src/schemas.ts). This guide specifies when to send each message and what the UI should do. Follow the [engineering agreement](engineering-contract.md) for ownership and coordinated changes.

## 1. Transport and message rules

Use HTTP JSON for commands and snapshots, and server-sent events (SSE) for ongoing call updates. SSE is backend → browser only; approval, Start, and Stop use HTTP requests. All routes are on the private local API.

| Rule | Required behavior |
| --- | --- |
| Structured meaning | UI logic uses `type`, state, reason, and error codes. Never interpret English text to decide whether a booking succeeded or approval is required. |
| Display text | UI owns standard labels such as “Ringing” and “Waiting for your approval.” Backend supplies `summaryEn`, translations, and safe error explanations. These strings are display content, not commands. Render them as text. |
| Two separate states | `callState` describes the telephone connection; `bookingState` and `outcome` describe the appointment. An ended call does not mean a confirmed appointment. |
| Authoritative state | Backend persists a consistent snapshot and its events together before publishing. The UI cannot grant booking authority or infer acceptance from a button click. |
| IDs and time | UUIDs identify app entities. Timestamps include an offset; appointment data also includes business-local time and IANA timezone. Show the business timezone explicitly. |
| Prices | Integer minor units: `3500 EUR` means €35. Service prices are EUR; call costs are USD in v1. Unknown values are `null`, never zero. |
| Privacy | Never send credentials, provider payloads, stack traces, or unapproved contact data. Error text must not echo sensitive request content. |
| Compatibility | Parse messages using the shared schemas. Unknown event type/version or invalid payload requires resynchronization and an incompatibility indicator if it persists; do not guess a meaning. |

## 2. HTTP exchanges

The [complete API reference](interfaces.md#4-private-http-api) defines all fields and errors. These are the main UI interactions; paths below include `/api/v1`.

| User action | UI sends | Backend returns | UI behavior |
| --- | --- | --- | --- |
| Open app | `GET /api/v1/readiness` | `200 Readiness` | Show simulator/live mode and readiness checks. Disable live Start when not ready. No attempt event stream exists yet. |
| Prepare request | `POST /api/v1/plans` with `RequestDraft` | `201 { plan: ReviewPlan }` | Show normalized details for deliberate review. This does not start a call. |
| Start reviewed plan | `POST /api/v1/calls` with `{ planId, planVersion, mode }` and UUID `Idempotency-Key` | `202 { call: CallSnapshot }` | Show that attempt, then subscribe to its events. `202` means accepted for processing, not connected. |
| Load/reconnect | `GET /api/v1/calls/:attemptId` | `200 { call: CallSnapshot }` | Replace authoritative state; resume events from `lastEventSequence`. |
| Approve/reject | `POST /api/v1/calls/:attemptId/approvals` with `ApprovalDecision` and UUID `Idempotency-Key` | `200 { call: CallSnapshot }`, or a structured error | Show recorded decision. Approval does not imply speech was played or the business confirmed. |
| Stop | `POST /api/v1/calls/:attemptId/stop` with `{}` | `202 { call: CallSnapshot }` | Show the returned state, usually `ending`; wait for provider termination or reconciliation. Stop is repeatable. |
| View history | `GET /api/v1/history` | `200 { items: HistoryEntry[], nextCursor }` | Render saved outcomes; an empty list is a normal state. |
| Delete conversation | `DELETE /api/v1/calls/:attemptId/conversation` | `200 { attemptId, deleted: true }` | Remove transcript and translation text locally; retain structured booking metadata. |

For a retry of the same Start or approval command, reuse its original idempotency key and body. Never generate a new Start key merely because the response was lost. A new key represents a new command. A transport timeout is a UI connection problem, not proof that the backend rejected the command.

## 3. SSE envelope and payload formats

Subscribe to `GET /api/v1/calls/:attemptId/events`. Every domain message has exactly this envelope:

```text
{
  contractVersion: 1,
  id: UUID,                 // unique event ID
  attemptId: UUID,
  sequence: positive integer,
  snapshotRevision: positive integer,
  occurredAt: ISO timestamp with offset,
  type: event type below,
  payload: payload matching that type
}
```

This block describes a format, not literal JSON. `sequence` increases per attempt; several events may share one `snapshotRevision`. SSE `id` is the sequence as a string, not the envelope's UUID. SSE `event` is `callmate`; `data` is the JSON envelope. Each frame ends with a blank line.

| `type` | Exact payload shape | UI meaning |
| --- | --- | --- |
| `call.status` | `{ callState: CallState }` | Telephone lifecycle changed. |
| `transcript.updated` | `TranscriptMessage` | Insert/update by message `id`; translation and playback can update an existing message. |
| `offer.updated` | `Offer` | Business proposed a particular service/time/price/conditions, with evidence IDs. This is not a booking. |
| `approval.requested` | `ApprovalRequest` | Show the exact offer, reason, plan/offer versions, and expiry; enable decision controls only while valid. |
| `approval.resolved` | `{ approvalId, offer: { offerId, offerVersion }, status }` | Status is `approved`, `rejected`, `expired`, or `invalidated`. Close/disable controls for that approval. |
| `booking.updated` | `{ bookingState: BookingState, outcome: Outcome }` | Booking progress or result changed. Only `outcome.status: "confirmed"` permits a confirmed result/calendar export. |
| `usage.updated` | `{ estimate, settledTotal, status, measuredAt }` | Show unavailable, estimated, partial, or settled USD call costs. |
| `conversation.deleted` | `{ conversationData: "deleted" }` | Immediately clear cached transcript/translation text, then refetch the snapshot. |
| `call.error` | `{ code: ErrorCode, message: string, recoverable: boolean }` | Show a safe error notice. `recoverable` does not authorize retrying a dial or deciding the booking outcome. |

`CallState`, `BookingState`, and all reason/code enums are fixed by the shared schemas. Do not add ad hoc event names such as `booking_success` or `new_message` in an individual scope.

## 4. What the backend sends in each case

Events listed together describe one persisted transition; publish them in the listed order when they apply. Unchanged fields need no repeated event. The fetched snapshot always contains the complete result of the transition.

| Situation | Backend messages and state | UI presentation and action |
| --- | --- | --- |
| Call creation accepted | HTTP `202` snapshot: `callState: creating`, `bookingState: pending`, `outcome: { status: pending }`. | “Starting call.” Open the stream for this attempt. |
| Provider dial begins / phone rings | `call.status` with `dialing`, then `ringing` if reported. | “Calling…” / “Ringing.” Providers may skip an intermediate status. |
| Business answers | `call.status` with `connected`. | “Connected.” No booking success indication. |
| Business speaks | `transcript.updated` with `speaker: business`, Spanish text, `final`, and `translationEn` or `null`. | Show Spanish and available English translation. Mark provisional text; no duplicate rows for updates. |
| Translation arrives later | `transcript.updated` for the same message ID, with `translationEn` filled. | Update the existing row. |
| Assistant prepares/speaks/is interrupted | `transcript.updated` with `speaker: assistant` and actual `playback` state: `withheld`, `generated`, `playing`, `played`, or `interrupted`. | Distinguish prepared text from played speech. Do not claim the whole message was heard after interruption. |
| Complete offer extracted | `offer.updated`, then `booking.updated` with `offer_received` and pending outcome. | Show proposed details without a confirmed badge. Incomplete/ambiguous details remain conversation/clarification, not a fabricated complete offer. |
| Offer fits the approved plan | `booking.updated` with `reading_back`, then `awaiting_business_confirmation` as those steps occur; outcome remains pending. | “Confirming details with the business.” No approval dialog unless the plan requires one. |
| Price/time needs permission, or plan requires approval | `offer.updated` if changed, `approval.requested`, then `booking.updated` with `awaiting_approval` and pending outcome. Snapshot has matching `activeOffer` and `pendingApproval`. | Show exact alternative and differences from approved constraints, reason, deadline, Approve/Reject. Backend withholds acceptance. |
| User approves a valid offer | HTTP `200` snapshot; `approval.resolved` with `approved`, then `booking.updated` with `reading_back` and pending outcome. Snapshot clears `pendingApproval`. | “Approved; confirming with the business.” Approval is not the final booking. |
| User rejects / deadline expires | `approval.resolved` with `rejected` / `expired`; `booking.updated` with `pending` if continuing, or a supported final outcome if ending. Clear `pendingApproval`. | Close controls. Show rejection/expiry and actual conversation progress. Expiry alone does not establish a booking result. |
| Business changes offer while approval is open | Resolve old approval as `invalidated`; `offer.updated` with new version; new `approval.requested` if needed; `booking.updated` to the actual next state. | Old buttons stop working. Replace the offer and require fresh approval when applicable. Never carry approval to changed terms. |
| Business explicitly confirms the authorized appointment | Final business `transcript.updated`, then `booking.updated` with `confirmed` and confirmed outcome containing the exact offer and evidence IDs. | “Appointment confirmed,” exact business-local time, price/name, English summary; enable calendar export. Call may still be connected. |
| No availability / business declines | `booking.updated` with `not_booked`, reason `no_availability` / `business_declined`, and English summary; call lifecycle events follow as applicable. | “No appointment booked,” with explanation. |
| Busy / no answer | `booking.updated` with `not_booked` and reason `busy` / `no_answer`, then `call.status` with `busy` / `no_answer`. | Show the reason. A retry requires deliberate user action. |
| Stop pressed | HTTP `202` snapshot and `call.status: ending` if needed; on provider termination, final booking update if unresolved, then `call.status: ended`. | “Ending call” until termination is known. Preserve an already confirmed booking. Use `user_stopped` only when non-booking is established; ambiguous commitment remains uncertain. |
| Disconnect near acceptance / unclear confirmation | `booking.updated` with `uncertain`, reason `disconnected_near_confirmation` / `ambiguous_confirmation`, English summary; `call.status: ended` if termination is known. | “Booking status uncertain. Check with the business before trying again.” No automatic redial or calendar export. |
| Provider call creation times out ambiguously | `call.error` with safe `PROVIDER_UNAVAILABLE` notice; `booking.updated` with uncertain outcome/reason `creation_unknown`; `call.status: reconciliation_required`. | “Checking whether the call started.” Keep the attempt visible; block a new call while its reservation remains held. |
| Model/voice/provider failure | `call.error`; if ending, `booking.updated` with `not_booked/technical_failure` only when non-booking is established, otherwise uncertain; actual call status follows. | Show error and authoritative result separately. A failure cannot erase an already confirmed booking. |
| Call ends normally | Final booking update if needed, then `call.status: ended`. Terminal snapshot has a non-pending outcome and no pending approval. | Render the stored confirmed/not-booked/uncertain outcome. `ended` itself is not a result. |
| Call costs change | `usage.updated` during/after the call. | Label estimates and partial totals; show “Final cost” only for `settled`. |
| Retained conversation is deleted | `conversation.deleted`; remove transcript-bearing replay data and invalidate affected replay ranges. | Clear text immediately; preserve the structured result. Other connected clients must also clear text. |

If a pending approval exists when a call ends, resolve it as invalidated before final booking/call events. Backend expiry uses its clock; a UI countdown is only an indication and must not fabricate an approval-resolution event.

## 5. Concrete JSON examples

These examples use synthetic IDs and dates. They are independent examples, not a contiguous event log. Payload-only examples belong inside the envelope above; do not send them as standalone SSE data. Do not add the prose labels to the JSON.

### Approval required for a higher price

Full `DomainEvent` JSON, sent as the `data` of an SSE frame with `id: 8` and `event: callmate`. The reviewed maximum was €30; the business offers €35.

```json
{
  "contractVersion": 1,
  "id": "10000000-0000-4000-8000-000000000006",
  "attemptId": "10000000-0000-4000-8000-000000000002",
  "sequence": 8,
  "snapshotRevision": 5,
  "occurredAt": "2026-10-15T10:01:00Z",
  "type": "approval.requested",
  "payload": {
    "id": "10000000-0000-4000-8000-000000000007",
    "attemptId": "10000000-0000-4000-8000-000000000002",
    "plan": { "planId": "10000000-0000-4000-8000-000000000001", "planVersion": 1 },
    "offer": {
      "id": "10000000-0000-4000-8000-000000000003",
      "version": 2,
      "service": "Haircut",
      "bookingName": "Alex Example",
      "appointment": {
        "localDate": "2026-10-20", "localTime": "18:00",
        "timeZone": "Europe/Madrid", "instant": "2026-10-20T16:00:00Z"
      },
      "durationMinutes": null,
      "price": { "amountMinor": 3500, "currency": "EUR" },
      "conditions": { "deposit": "none", "cancellationFee": "none", "paidAddOn": "none" },
      "evidenceMessageIds": ["10000000-0000-4000-8000-000000000004"]
    },
    "reason": "above_price_limit",
    "createdAt": "2026-10-15T10:01:00Z",
    "expiresAt": "2026-10-15T10:01:30Z"
  }
}
```

UI copy: “The haircut costs €35, above your €30 limit. Approve €35 for 20 October at 18:00, Europe/Madrid?” The original maximum comes from the approved plan in the snapshot; the alternative comes from this offer. Do not use the price comparison to authorize anything in the browser.

### UI approves that exact offer

Body of `POST /api/v1/calls/10000000-0000-4000-8000-000000000002/approvals`, with a separately generated UUID `Idempotency-Key` header:

```json
{
  "approvalId": "10000000-0000-4000-8000-000000000007",
  "plan": { "planId": "10000000-0000-4000-8000-000000000001", "planVersion": 1 },
  "offer": { "offerId": "10000000-0000-4000-8000-000000000003", "offerVersion": 2 },
  "decision": "approve"
}
```

Corresponding `approval.resolved` payload after the backend atomically accepts that decision:

```json
{
  "approvalId": "10000000-0000-4000-8000-000000000007",
  "offer": { "offerId": "10000000-0000-4000-8000-000000000003", "offerVersion": 2 },
  "status": "approved"
}
```

### Spanish utterance with English translation

`transcript.updated` payload. Later translation or playback updates reuse the message ID.

```json
{
  "id": "10000000-0000-4000-8000-000000000004",
  "turnId": "10000000-0000-4000-8000-000000000005",
  "speaker": "business",
  "originalText": "El corte cuesta treinta y cinco euros.",
  "language": "es-ES",
  "translationEn": "The haircut costs thirty-five euros.",
  "final": true,
  "playback": "not_applicable",
  "createdAt": "2026-10-15T10:01:00Z"
}
```

### Business confirms after authorized acceptance

`booking.updated` payload. The confirmation ID must reference a finalized business message already persisted in this attempt, establishing confirmation of this exact offer. Schema validity alone cannot establish that meaning.

```json
{
  "bookingState": "confirmed",
  "outcome": {
    "status": "confirmed",
    "offer": {
      "id": "10000000-0000-4000-8000-000000000003",
      "version": 2,
      "service": "Haircut",
      "bookingName": "Alex Example",
      "appointment": {
        "localDate": "2026-10-20", "localTime": "18:00",
        "timeZone": "Europe/Madrid", "instant": "2026-10-20T16:00:00Z"
      },
      "durationMinutes": null,
      "price": { "amountMinor": 3500, "currency": "EUR" },
      "conditions": { "deposit": "none", "cancellationFee": "none", "paidAddOn": "none" },
      "evidenceMessageIds": ["10000000-0000-4000-8000-000000000004"]
    },
    "confirmedAt": "2026-10-15T10:02:00Z",
    "confirmationMessageIds": ["10000000-0000-4000-8000-000000000008"],
    "summaryEn": "Haircut booked for 20 October at 18:00, Europe/Madrid, under Alex Example, for €35."
  }
}
```

### Call disconnects before confirmation is clear

`booking.updated` payload:

```json
{
  "bookingState": "uncertain",
  "outcome": {
    "status": "uncertain",
    "reason": "disconnected_near_confirmation",
    "summaryEn": "The call disconnected near acceptance. Check with the business before trying again."
  }
}
```

### Approval arrives after expiry

HTTP `409` response to the approval command, using `ApiError`. Independently, the event stream reports `approval.resolved` with `status: expired`; the HTTP error alone is not a substitute for updating persisted state.

```json
{
  "error": {
    "code": "APPROVAL_EXPIRED",
    "message": "This approval has expired. Refresh the call to see the current offer.",
    "requestId": "10000000-0000-4000-8000-000000000009",
    "details": []
  }
}
```

## 6. Error rules by case

Every HTTP failure uses `{ error: { code, message, requestId, details } }`. `details` contains field paths and safe explanations for validation errors, otherwise it may be empty. UI actions follow the code, not the wording.

| HTTP / code | UI behavior |
| --- | --- |
| `400 INVALID_REQUEST` | Show field errors where possible; keep entered values for correction. |
| `400 EVENT_CURSOR_INVALID` | Fetch a snapshot and reconnect using its cursor. |
| `404 NOT_FOUND` | Show that the attempt/resource is unavailable; return to history/request flow without dialing. |
| `409 PLAN_VERSION_MISMATCH` | Reload/recreate the review plan and require review again. |
| `409 CALL_ALREADY_ACTIVE` | Do not Start again. Load history/current known attempt and follow its state; the error format does not include an active-attempt ID. |
| `409 IDEMPOTENCY_CONFLICT` | Show a command conflict; do not silently generate another key to bypass it. |
| `409 APPROVAL_STALE` / `APPROVAL_EXPIRED` / `CALL_NOT_ACTIVE` | Disable the old approval controls and refetch the call. |
| `409 MODE_MISMATCH` | Refresh readiness; show the actual mode and require a deliberate compatible command. |
| `409 DATA_NOT_DELETABLE` | Explain that conversation deletion requires a terminal call; refetch state. |
| `503 PROVIDER_NOT_READY` | Show readiness/configuration issue. No automated dial retry. |
| `503 PROVIDER_UNAVAILABLE` | Explain temporary unavailability; retrieve any existing attempt before offering a deliberate retry. |
| `500 INTERNAL_ERROR` | Show safe message/request ID; preserve any known attempt and reconcile before any new Start. |
| HTTP transport timeout or SSE disconnect | Show a separate UI connection warning. Do not change `callState` or `outcome` to failed based on lost browser connectivity. |

An HTTP command failure is a response to that command. A `call.error` is an event about an existing attempt. They share code vocabulary but different shapes; do not wrap an SSE error payload in `{ error: ... }`.

## 7. Snapshot and reconnect rules

For v1, use snapshots as authoritative state and SSE as change notifications. On a new event, refresh `GET /api/v1/calls/:attemptId` and replace the displayed state. Coalesce notifications while a fetch is in flight, fetching again if a received event references a revision newer than the response. This avoids assembling an inconsistent snapshot from several partial events, especially when clearing approvals or offers. A later optimized reducer must preserve the same behavior.

1. Fetch the snapshot, retain its `revision` and `lastEventSequence`, and open SSE from that cursor using `Last-Event-ID`. Use fetch streaming if an initial custom header is needed; native EventSource does not support arbitrary headers.
2. Track the received event sequence separately from the rendered snapshot revision. Ignore duplicate sequences. Discard an older HTTP snapshot response rather than overwriting newer state. A fetched snapshot can already cover several queued events.
3. An event referencing a revision already rendered needs no state refetch. Error notices are separate from snapshot state and should be deduplicated by event ID/sequence. Apply deletion immediately to cached text before resynchronizing.
4. A sequence gap or invalid event requires a fresh snapshot and resubscription. Unsupported protocol versions that persist require a compatibility error and disabled mutation controls until resolved.
5. When replay is unavailable, the backend sends unnumbered SSE `event: reset` with `data: { "reason": "snapshot_required" }`, then closes. This is a stream-control message, not a `DomainEvent`.
6. Heartbeats are SSE comments without IDs. Reconnection never issues Start. Keep stream/reconnect handling available for later usage/deletion updates even after telephone termination.

Browser connection state, request-in-flight indicators, and countdown display are UI state. Telephone state, pending approvals, booking authority, and final outcomes are backend state.

## Development manual-call extension

Backend-started mock calls now use the same persisted attempt GET/Stop/history/deletion/SSE routes. Their snapshot is identified by `kind: "manual_mock"`, with `plan: null`, `mode: "simulator"`, no offer/approval and no booking authority. History entries include the same kind marker. Consumers must branch on this marker before rendering booking-plan fields; existing booking snapshots retain their format. See [the manual-call contract](interfaces.md#9-persisted-manual-mock-calls-development-extension).

For manual `transcript.updated` events, preserve the exact text/locale, render a missing translation as unavailable, and replace a message with the same ID when its playback changes from `withheld` to `generated`. Do not show played/heard or booked: this path has no audio-playback acknowledgment or booking engine. A relay disconnect uses `reconciliation_required`; completion is `not_booked`. SSE replay, deletion resets and sequence handling follow the existing rules. The simple development console continues polling a projection of these persisted records; clients can consume the common SSE endpoint directly.

Manual mock recovery uses the same `call.error`, `call.status` and `booking.updated` events. After restart/relay loss, show `reconciliation_required` as an active attempt with a safe error; keep Start blocked. When a provider-confirmed orphan hangup completes, show `ended` with `not_booked/technical_failure` (or `user_stopped` for explicit Stop). If the provider already ended the call, preserve its terminal meaning. Missing provider records and unknown CallSids remain unresolved; do not treat a page refresh, restart, or error as permission for a fresh Start. Recovery emits no replayed greeting or fabricated transcript. The development projection exposes nullable `sessionId` for correlation; no token/hash is exposed.

Signed mock progress callbacks use the existing lifecycle/SSE event shapes. Duplicate/stale callbacks and events after a terminal result produce no UI revision or SSE event. Higher-sequence regressing progress advances only an internal cursor. A callback can report `connected` before relay setup; this leaves initial text `withheld`. UI SSE sequence remains independent of provider `SequenceNumber`, so clients must not infer a replay gap from missing provider sequence numbers. Stop/recovery states remain active until termination is confirmed, and completed/deleted conversations remain closed across callback replay and restart.

For manual mock deadline expiry, display the existing `call.error` duration/silence message and `call.status=ending`; keep Start blocked until provider-confirmed termination. The final `booking.updated` has `not_booked/technical_failure` and a summary identifying the deadline. Explicit user Stop remains `not_booked/user_stopped`. Repeated Stop does not create extra lifecycle events after completion. Keep Stop usable while Start is in progress, retain the attempt/request ID for cancellation, and do not let a delayed Start response overwrite a completed Stop. Backend controls continue without a browser. See [call controls](docker-development.md#12-call-controls-and-limits).
