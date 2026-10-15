# CallMate — Mock Twilio ConversationRelay Service

**Software Requirements Specification (SRS)**  
**Language:** English  
**Deliverable:** A working, Dockerized local-development service, generated from this specification  
**Document purpose:** Supply this document to an AI coding agent and have it implement the complete service. This is **not** an implementation plan or a project schedule.

---

## 1. Product definition

Build an autonomous local-development substitute for **Twilio Programmable Voice outbound calls + Twilio ConversationRelay**. Its purpose is to let developers build and test the **CallMate backend** without signing up for Twilio, upgrading a Twilio account, buying a telephone number, configuring ngrok, or placing paid telephone calls.

The service is named **CallMate Mock ConversationRelay** (hereafter **the Emulator**).

The Emulator MUST:

1. Accept a simulated outbound call through either a small Twilio-Calls-compatible REST endpoint or a direct local session-creation API.
2. Present the simulated ringing call in a local browser interface. A developer plays the role of the business receiving the call.
3. When the developer accepts the call, connect **as a WebSocket client** to the CallMate backend's ConversationRelay WebSocket endpoint, just as Twilio ConversationRelay would.
4. Send accurately shaped Twilio-style `setup`, `prompt`, `interrupt`, `dtmf`, and `error` WebSocket messages from the simulated caller to CallMate.
5. Receive Twilio-style `text` messages from CallMate and render their text and optionally speak them aloud with browser speech synthesis.
6. Support browser voice input (where supported) and **always** support reliable manual text input.
7. Expose the simulated call's status, transcript/event log, and transport errors through a local browser interface and developer REST API.
8. Run locally with **one `docker compose up --build` command**, with no outside service or paid API requirement.
9. Preserve a clear boundary: the Emulator reproduces a documented subset of Twilio's integration contract; it does **not** place PSTN calls, run Twilio's actual speech models, or claim full Twilio compatibility.

### 1.1 Exact integration boundary

The Emulator is the **Twilio side** of the following interaction, not the AI-agent service:

```text
CallMate Web UI
       |
       | POST /api/calls (CallMate's API)
       v
CallMate Backend
       |
       | Twilio-compatible outbound Calls REST request
       v
+------------------------------------------------------+
| DOCKERIZED MOCK TWILIO SERVICE                       |
|                                                      |
|  Mock Calls REST API ---> Pending call / ring UI     |
|                                   |                  |
|                           Operator clicks Answer     |
|                                   |                  |
|  Browser: text + mic  <-->  Emulator controller      |
|                                   |                  |
+-----------------------------------|------------------+
                                    |
                                    | Emulator initiates
                                    | outbound WS connection
                                    v
                       CallMate Backend WS endpoint
                       /ws/voice (Twilio protocol)
                                    |
                                    v
                       CallMate Agent (other engineer)
```

**Critical invariant:** The CallMate backend remains the **WebSocket server**. The Emulator is the **WebSocket client** on that connection. Do not invert this direction. The browser has a separate connection to the Emulator for UI control and telemetry; it is not the CallMate ConversationRelay WebSocket peer.

### 1.2 Out of scope

The following are not required and must not be represented as functional:

- Real telephone calls, SIM cards, SIP, PSTN, WebRTC through Twilio, WhatsApp, or Twilio account access.
- Access to Google/Deepgram STT or Twilio/ElevenLabs TTS providers.
- Precise telephone audio codecs, RTP media, recording, or audio timing guarantees.
- Full TwiML interpreter and the complete Twilio Calls REST API.
- Production-scale authentication, billing, call transfer, live conferences, and carrier-specific behavior.
- Automatic dialogue generation, policy evaluation, appointment booking intelligence, or an OpenAI integration inside this service. Those belong to CallMate's agent/backend.

---

## 2. Deployment and technology contract

### 2.1 Required stack

- **Server:** Node.js 22 LTS or newer LTS, TypeScript, an HTTP framework (Fastify or Express), and a standards-compliant WebSocket client/server library (for example `ws`).
- **Browser client:** TypeScript + a minimal browser application (Vite is acceptable). A full design system is unnecessary.
- **State:** in-memory, process-local storage (maps); no external database, Redis, cache, or queue.
- **Validation:** runtime schemas for public HTTP requests and WebSocket JSON payloads (for example Zod or JSON Schema).
- **Tests:** automated unit and integration tests executable inside Docker.
- **Packaging:** a complete Dockerfile, Compose configuration, `.env.example`, `.dockerignore`, and README.

One Docker Compose service is preferred. The browser assets MAY be statically served by the same Node.js process. Do not require the user to run a separate non-Dockerized frontend.

### 2.2 Default local addresses

| Surface | URL (on host machine) | Purpose |
|---|---|---|
| Simulator browser UI | `http://localhost:8080/` | Answer calls; text and voice interaction |
| Emulator management API | `http://localhost:8080/api/...` | Control sessions and view state |
| Twilio-like Calls API | `http://localhost:8080/2010-04-01/...` | Development replacement for Calls resource |
| Health | `http://localhost:8080/healthz` | Container health |
| Browser control WebSocket | `ws://localhost:8080/operator` | UI events, transcription and playback updates |
| CallMate backend relay WebSocket | `ws://host.docker.internal:3001/ws/voice` | Destination the Emulator connects **to** |

Bind the Node process to `0.0.0.0:8080` **inside the container**. Bind the published Docker port to host loopback (`127.0.0.1:8080:8080`) by default. Include the Compose `extra_hosts` mapping `host.docker.internal:host-gateway` for Linux. Explicitly document that a backend running on the host must bind to an address accessible from Docker; `localhost` **inside the container** is not the host machine.

### 2.3 Configuration variables

Provide these variables and working defaults in `.env.example`:

```dotenv
NODE_ENV=development
PORT=8080
MOCK_ACCOUNT_SID=AC00000000000000000000000000000000
MOCK_API_USERNAME=mock
MOCK_API_PASSWORD=mock-local-only
CALLMATE_WS_URL=ws://host.docker.internal:3001/ws/voice
CALLMATE_TWIML_URL=http://host.docker.internal:3001/twiml
DEFAULT_LANGUAGE=pl-PL
DEFAULT_FROM=+48000000000
DEFAULT_TO=+48111111111
AUTO_ANSWER=false
ENABLE_BROWSER_SPEECH=true
MAX_ACTIVE_CALLS=5
CALL_TIMEOUT_SECONDS=300
SESSION_RETENTION_MINUTES=60
LOG_LEVEL=info
ALLOWED_BACKEND_HOSTS=host.docker.internal,localhost,127.0.0.1
```

`CALLMATE_WS_URL` is a fallback, not a forced override when a valid `<ConversationRelay url>` has been returned in TwiML. The Emulator MUST be able to resolve the relay URL either from inline TwiML, fetched TwiML, or the fallback configuration, in that order.

Secrets such as `MOCK_API_PASSWORD` are **local-development secrets only**. Do not ship the application configured to listen on all host network interfaces or expose the management UI publicly.

---

## 3. Simulated outgoing call lifecycle

### 3.1 States

Each call must have a stable `callSid`, a single `sessionId` when a relay session starts, and one of these values:

```text
queued -> ringing -> in-progress -> completed
          |             |
          v             v
       no-answer       failed
```

More precise lifecycle requirements:

- Creation produces `queued` or `ringing`; normally the call transitions promptly to `ringing` and appears on the operator dashboard.
- **Accept/Answer** transitions to `in-progress`, retrieves/parses TwiML, connects the outbound WebSocket to the CallMate backend, and immediately sends one `setup` event.
- **Reject** transitions to `busy` or `canceled` (use `busy` for a rejected ringing call and document this).
- **Hang up** while in progress closes the relay socket and transitions to `completed`.
- Connection/TwiML failure transitions to `failed`, with a documented structured error, not a fictitious successful conversation.
- If no one answers before a configurable ringing timeout, transition to `no-answer`.
- If the CallMate backend sends the ConversationRelay `end` control message, terminate the relay session cleanly and complete the mocked call while preserving `handoffData`.
- No call may be automatically marked as a successful *appointment booking*. Call status and business outcome are different concepts; only CallMate determines business outcome.
- WebSocket disconnects, browser refreshes, and process termination must not silently convert failures to success.

All transitions must include an ISO-8601 timestamp and be observable from the UI and REST state APIs. Terminal states must be immutable except for explicit test-reset or deletion of the mock record.

### 3.2 Twilio-style identifiers

Generate fresh per-call identifiers with these shapes:

- `callSid`: `CA` plus 32 hexadecimal characters.
- `sessionId`: `VX` plus 32 hexadecimal characters.
- `accountSid`: from `MOCK_ACCOUNT_SID`, beginning with `AC` and followed by 32 hexadecimal characters.

Use distinct IDs for concurrent calls. Allow deterministic IDs through a testing-only injection mechanism to make protocol tests repeatable; do not use deterministic IDs as the default.

### 3.3 Two entry paths

The Emulator MUST support both:

**A. Twilio Calls API compatibility route** — preferred when developing CallMate's real `startCall()` code.

**B. Direct local session API** — preferred for independently testing the agent endpoint before CallMate's Calls API adapter exists.

Both entry paths MUST use the same session lifecycle, operator UI, TwiML resolution, WebSocket logic, and event log.

---

## 4. Twilio Calls REST compatibility facade

Implement a **deliberately limited** subset of the Twilio Programmable Voice Calls resource. This is an HTTP façade, not a full Twilio REST clone.

### 4.1 Create call

```http
POST /2010-04-01/Accounts/{AccountSid}/Calls.json
Content-Type: application/x-www-form-urlencoded
Authorization: Basic <mock credentials>
```

Support form parameters:

| Name | Required | Meaning |
|---|---|---|
| `To` | yes | Fictional destination displayed to the operator |
| `From` | yes | Fictional originating caller ID |
| `Url` | if `Twiml` absent | HTTP(S) TwiML endpoint to fetch on answer |
| `Twiml` | if `Url` absent | Inline TwiML, max 4000 characters |
| `Method` | no | TwiML fetch method `GET` or `POST`, default `POST` |
| `StatusCallback` | no | URL to receive mock Twilio-style status webhooks |
| `StatusCallbackMethod` | no | `GET` or `POST`, default `POST` |
| `StatusCallbackEvent` | no | If supplied, support `initiated`, `ringing`, `answered`, `completed` |
| `Timeout` | no | Operator answer timeout in seconds, bounded by safe configured limits |

If both `Url` and `Twiml` are provided, `Url` takes precedence, as described in Twilio's Create Call documentation. Validate provided account SID against `MOCK_ACCOUNT_SID`. Require mock Basic authentication unless explicitly disabled for isolated unit tests.

Return HTTP `201` with a Twilio-like JSON object including at least:

```json
{
  "sid": "CA0123456789abcdef0123456789abcdef",
  "account_sid": "AC00000000000000000000000000000000",
  "to": "+48111222333",
  "from": "+48000111222",
  "direction": "outbound-api",
  "status": "queued",
  "date_created": "Thu, 15 Oct 2026 12:00:00 +0000",
  "uri": "/2010-04-01/Accounts/AC00000000000000000000000000000000/Calls/CA0123456789abcdef0123456789abcdef.json"
}
```

Dates must be generated at runtime; the concrete values above are examples only. The response must work for the relevant fields used by CallMate's call-starting code. Additional Twilio fields may be included but must be documented and tested.

### 4.2 Retrieve call

```http
GET /2010-04-01/Accounts/{AccountSid}/Calls/{CallSid}.json
```

Respond with current `status`, `sid`, `account_sid`, `from`, `to`, `direction`, start/end timestamps if known, and `duration` if completed. Return consistent mock-Twilio-like errors for 404, invalid input, and authentication failure.

### 4.3 Complete/hang up call

```http
POST /2010-04-01/Accounts/{AccountSid}/Calls/{CallSid}.json
Content-Type: application/x-www-form-urlencoded

Status=completed
```

If the call is active, end it and close the WebSocket cleanly. If terminal, return a stable, documented result (idempotent completion is acceptable and preferred for local testing). Do not implement call forwarding, recording, or TwiML replacement beyond the specified scope.

### 4.4 Status callbacks

When `StatusCallback` is provided, emulate callbacks to the CallMate backend for requested lifecycle events, using HTTP `POST` form-encoded fields by default:

```text
CallSid=CA...
AccountSid=AC...
CallStatus=ringing
From=+48000111222
To=+48111222333
Direction=outbound-api
```

- Deliver `initiated`, `ringing`, `answered`, and `completed` callbacks according to the subscribed `StatusCallbackEvent`s. Ensure the callback `CallStatus` values reflect the simulated state (for example `in-progress` for answered).
- Preserve ordering. Use bounded retries or surface delivery errors; never block the operator UI indefinitely.
- Store callback attempts, HTTP response codes, and last delivery errors in session diagnostics.
- **Do not fabricate a valid `X-Twilio-Signature` header.** Clearly mark callbacks as local mock traffic (for example `X-CallMate-Mock: true`). The CallMate backend must explicitly allow unsigned mock callbacks **only in mock/development mode**.

### 4.5 Twilio Node SDK integration limitation

Implementing a Twilio-like HTTP endpoint does **not** automatically cause `twilioClient.calls.create()` to use it: Twilio's Node helper defaults to Twilio's own host. The required deliverable must include a README example showing either:

- a `TelephonyProvider` adapter that issues the same form-encoded requests to the configured mock base URL, **or**
- a custom Twilio SDK HTTP client that redirects just the intended Calls API requests to the Emulator.

Never suggest changing production DNS or blindly redirecting all Twilio API traffic. The Emulator should work without the Twilio Node package, although the consuming CallMate backend may use it.

---

## 5. TwiML compatibility

### 5.1 Supported subset

On call acceptance, the Emulator must resolve the ConversationRelay WebSocket URL. Support:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect action="http://host.docker.internal:3001/twiml-done">
    <ConversationRelay
      url="ws://host.docker.internal:3001/ws/voice"
      language="pl-PL"
      welcomeGreeting="Dzień dobry. Jestem asystentem AI."
      interruptible="true">
      <Parameter name="taskId" value="task-demo-001"/>
      <Parameter name="customerName" value="Alex"/>
    </ConversationRelay>
  </Connect>
</Response>
```

The parser MUST:

- Read `Response > Connect > ConversationRelay` and its `url`.
- Read `<Parameter name="..." value="..." />` children and expose their values in `setup.customParameters` without replacing or renaming them.
- Read `language` (or equivalent transcription-language setting), `welcomeGreeting`, and `interruptible` when provided.
- Allow optional `ws://` URLs for local use and `wss://` URLs for externally hosted backends.
- Fetch a `Url` with the requested HTTP method, passing mock Twilio-style call fields where appropriate.
- Use a proper XML parser with external-entity and DTD processing disabled, size limits, short timeouts, and URL allowlisting.
- Return a visible mock error on missing/invalid TwiML, unsupported TwiML routes, invalid ConversationRelay `url`, or a WebSocket connection failure. Never silently pick an unrelated endpoint.
- If neither `Url` nor `Twiml` is supplied in the direct local API, use `CALLMATE_WS_URL` and direct API parameters without TwiML fetching.

Do not attempt to implement all TwiML nodes. `<Say>`, `<Dial>`, `<Gather>`, `<Play>`, and other elements need not execute. Unexpected required TwiML structures must produce a clearly labelled `UNSUPPORTED_TWIML` error.

### 5.2 Greeting behavior

If `welcomeGreeting` is present, show it immediately after acceptance and read it using browser TTS if enabled. This is a **simulated platform greeting**, not a `text` event sent by the backend. The backend still receives the `setup` message.

---

## 6. ConversationRelay WebSocket compatibility

The Emulator MUST open one outbound WebSocket connection to the CallMate backend per accepted call. The protocol should match the supported portion of the **Twilio ConversationRelay JSON event contract**.

### 6.1 Emulator -> CallMate: `setup`

Send exactly once as the first application-level WebSocket message, immediately after connection establishment:

```json
{
  "type": "setup",
  "sessionId": "VX0123456789abcdef0123456789abcdef",
  "accountSid": "AC00000000000000000000000000000000",
  "parentCallSid": "",
  "callSid": "CA0123456789abcdef0123456789abcdef",
  "from": "+48000111222",
  "to": "+48111222333",
  "forwardedFrom": "",
  "callType": "PSTN",
  "callerName": "",
  "direction": "outbound-api",
  "callStatus": "IN_PROGRESS",
  "customParameters": {
    "taskId": "task-demo-001"
  }
}
```

The `callStatus` field is a best-effort mock metadata value; avoid coupling CallMate tests to its exact mock capitalization. All other named fields MUST be present with reasonable mock values. `setup.customParameters` must round-trip exactly from TwiML or the direct session configuration.

### 6.2 Emulator -> CallMate: `prompt`

When the browser user submits a transcript (typed or speech-recognized), send:

```json
{
  "type": "prompt",
  "voicePrompt": "Dzień dobry, mamy termin jutro po siedemnastej.",
  "lang": "pl-PL",
  "last": true
}
```

- Default to sending **final** prompts with `last: true`.
- Preserve Polish diacritics and UTF-8 text without translation.
- Permit optional test mode for sending intermediate prompts with `last: false`, but do not send partial events by default.
- One browser submission equals one final caller turn unless an explicit partial-transcript simulation is selected.
- Queue or reject prompts deterministically if the backend connection is not ready; never discard silently.

### 6.3 Emulator -> CallMate: `interrupt`

The operator UI must provide a manual **Interrupt AI** button. If speech synthesis is ongoing, stop it and send:

```json
{
  "type": "interrupt",
  "utteranceUntilInterrupt": "Dzień dobry, chciałbym",
  "durationUntilInterruptMs": 650
}
```

Both fields must exist with correct types. Measure elapsed playback time in milliseconds. The `utteranceUntilInterrupt` value may be a best-effort approximation of the audible portion; do **not** claim character-accurate playback tracking. Document browser limitations. Also make this event injectable from automated tests without physical speech.

### 6.4 Emulator -> CallMate: `dtmf`

The UI should have a basic keypad to generate:

```json
{"type":"dtmf","digit":"1"}
```

Accept one character from `0`-`9`, `*`, or `#` in this UI path. This is signalling simulation only; no physical DTMF tones are required.

### 6.5 Emulator -> CallMate: `error`

On an invalid backend message, send an event with the documented basic shape, when the socket is still usable:

```json
{
  "type": "error",
  "description": "Invalid message received: missing token"
}
```

Increment a per-session malformed-message counter; after 10 consecutive invalid backend messages, close the socket with WebSocket code `1007` and a useful reason. Valid messages reset the counter. Make sure diagnostics distinguish backend-protocol errors from browser speech errors and network errors.

### 6.6 CallMate -> Emulator: `text`

Accept and validate:

```json
{
  "type": "text",
  "token": "Dzień dobry! ",
  "last": false,
  "lang": "pl-PL",
  "interruptible": true,
  "preemptible": false
}
```

Followed by:

```json
{
  "type": "text",
  "token": "Czy macie wolny termin na jutro?",
  "last": true
}
```

Requirements:

- `token` must be a string, including an empty string if the backend sends it; do not trim individual tokens or insert spaces.
- `last` defaults to `false` when absent.
- Accumulate tokens for the current speech turn and display live output as tokens arrive.
- When `last: true` arrives, finalize the utterance and read it through `speechSynthesis`, if enabled and supported.
- A strict compatibility mode must support several tokens per turn, not just a single completed text message.
- Preserve per-turn ordering and avoid mixing output across sessions.
- Respect `lang` where possible, falling back to the session's language.
- Support `interruptible` and `preemptible` as best-effort browser playback controls; expose approximation/limitations in the docs.
- If Web Speech voices are unavailable, **show all text anyway** and mark audio unavailable; do not fail the conversation.
- Do not speak partial tokens on every event in a way that repeatedly restarts TTS. Buffer until `last: true` at minimum; incremental sentence-level speaking is optional.

### 6.7 CallMate -> Emulator: `end`

Receive:

```json
{
  "type": "end",
  "handoffData": "{\"reasonCode\":\"completed\"}"
}
```

`handoffData` is an **optional string**, not an arbitrary JSON object. Preserve its exact string. Close the relay gracefully; record the reason and emit the call lifecycle completion event. No automatic handoff to a real person is required.

### 6.8 Additional protocol message types

For the following, implement the listed minimum response instead of silently ignoring messages:

| Backend message | Required Emulator behavior |
|---|---|
| `language` | Update session STT/TTS language when supported; update UI; retain configured language otherwise |
| `sendDigits` | Validate string; record an outbound DTMF action visibly, without physical dial tones |
| `play` | Record requested playback and display an `UNSUPPORTED_MEDIA_PLAYBACK` marker; optionally play allowlisted URLs, but external media playback is not mandatory |
| Unknown type | Return the `error` event, increment malformed counter, keep session open until threshold |

**Important:** `end` is a message sent **from CallMate to the relay**, not a standard caller-to-CallMate event. The caller hang-up is primarily represented by socket closure and call lifecycle status callbacks.

### 6.9 Transport behavior

- Connect to exactly the WS URL selected from TwiML/direct configuration.
- Use one socket per accepted call and isolate buffers/state by session ID.
- Provide configurable connection timeout and max call duration.
- Treat unexpected WebSocket closure as a failed/ended session; do not automatically reconnect and pretend the same Twilio session continued. A new call creates a new session.
- On user hang-up, cancel any browser synthesis and close the outbound socket.
- On backend `end`, close without generating a synthetic `prompt` or `end` message.
- Never route event payloads for one call to another call.
- Keep request/response and state logs that permit verifying protocol exchange without recording raw microphone audio.

---

## 7. Operator browser interface (fake call recipient)

The UI is for a human developer pretending to be the salon/barbershop/clinic that CallMate called. It is **not** CallMate's customer-facing UI.

### 7.1 Screens and controls

**A. Pending calls**

- Display each waiting mock call: call SID, `From`, `To`, current state, creation time, and task ID if available.
- **Answer** and **Reject** buttons.
- Refresh automatically without reloading; show a meaningful empty state.

**B. Active conversation**

- Show live connection state (`connecting`, `connected`, `disconnected`, `failed`).
- Show a readable, timestamped conversation transcript that distinguishes **Operator / Caller speech** and **CallMate AI reply**.
- A text box with **Send caller utterance**. This is the authoritative baseline input method and MUST always work.
- **Start microphone** and **Stop microphone** buttons using browser speech recognition if supported.
- Language selector, default `pl-PL`, with `es-ES` and `en-US` available.
- Browser TTS enable/disable, volume control where supported, and voice selector populated from available OS/browser voices.
- **Interrupt AI**, DTMF keypad, and **Hang up** controls.
- Display protocol/connection errors instead of crashing.

**C. Developer diagnostics**

- Separate raw WebSocket event inspector with direction, timestamp, type, session, and pretty-printed payload.
- The exact WS destination selected for the call.
- The current connection state, last error, last close code/reason, and session age.
- A control to copy the most recent event log as JSON; redact credentials.

### 7.2 Browser speech behavior

Speech recognition must use native `SpeechRecognition` or `webkitSpeechRecognition` when available; no third-party API key may be required. Browser TTS uses `speechSynthesis` and `SpeechSynthesisUtterance`.

Requirements:

- The UI must work when recognition is unavailable, denied, blocked, or inaccurate, by falling back to text entry.
- Browser microphone permission is requested only after an explicit user action.
- Recognition errors, `onend` events, and repeated start/stop actions must be handled without unhandled exceptions.
- Prevent the browser from transcribing its own synthesized AI voice where practical (pause microphone recognition during TTS); manual interrupt remains available.
- Polish is the default, not the only language.
- Browser STT can use browser/vendor-hosted services. The Emulator makes **no promise** of offline STT or privacy guarantees from the browser vendor. Text-only mode works locally without external speech services.
- `localhost` must work as a secure context for microphone use in browsers that support it. Do not require HTTPS/ngrok for local use.

### 7.3 Operator control channel

Use a separate internal browser-to-Emulator connection (e.g. `ws://localhost:8080/operator`) or HTTP/SSE equivalent for UI updates and submitting utterances. Document its events. **Do not expose that internal control protocol to CallMate as if it were Twilio's protocol.**

The browser should never need to open a WS connection directly to the CallMate backend or know its API keys.

---

## 8. Direct development REST API

Provide a simple, non-Twilio management API for manual and automated tests.

### 8.1 Create local session

```http
POST /api/sessions
Content-Type: application/json
```

```json
{
  "to": "+48111222333",
  "from": "+48000111222",
  "language": "pl-PL",
  "relayWsUrl": "ws://host.docker.internal:3001/ws/voice",
  "customParameters": {
    "taskId": "test-123"
  },
  "autoAnswer": false
}
```

Return HTTP `201`:

```json
{
  "id": "CA0123456789abcdef0123456789abcdef",
  "status": "ringing",
  "operatorUrl": "http://localhost:8080/?callId=CA0123456789abcdef0123456789abcdef"
}
```

The browser URL must open directly to the corresponding pending call. `relayWsUrl` is a deliberate direct-API override, not a required field for calls created through the Twilio REST facade.

### 8.2 Additional routes

| Method | Path | Behavior |
|---|---|---|
| `GET` | `/healthz` | `200` and service health |
| `GET` | `/api/sessions` | List sessions with statuses and timestamps |
| `GET` | `/api/sessions/:id` | Details, destination, errors, session metadata |
| `POST` | `/api/sessions/:id/answer` | Accept pending call and connect to CallMate |
| `POST` | `/api/sessions/:id/reject` | Decline ringing call |
| `POST` | `/api/sessions/:id/hangup` | End active call |
| `POST` | `/api/sessions/:id/utterances` | Inject a final caller transcript (`text`, optional `lang`) |
| `POST` | `/api/sessions/:id/interrupt` | Inject `interrupt` event using optional supplied transcript/time |
| `POST` | `/api/sessions/:id/dtmf` | Inject a DTMF digit |
| `GET` | `/api/sessions/:id/events` | Chronological JSON event log |
| `DELETE` | `/api/sessions/:id` | Delete terminal test record; return error for active call |

Mutating calls with invalid state transitions must return `409 Conflict` and a structured error. Unknown sessions return `404`. Invalid payloads return `400`/`422`. Explicitly document which route can be used before and after the call is answered.

**Example caller text injection:**

```bash
curl -X POST http://localhost:8080/api/sessions/CA0123456789abcdef0123456789abcdef/utterances \
  -H 'Content-Type: application/json' \
  -d '{"text":"Mamy wolny termin jutro o 17:30.","lang":"pl-PL"}'
```

This must cause a Twilio-style `prompt` to be sent over the **outgoing relay WebSocket** to CallMate; it must not bypass the relay and call the agent module directly.

---

## 9. Error handling, session isolation, and observability

### 9.1 Error responses

REST errors must be machine-readable:

```json
{
  "error": {
    "code": "BACKEND_WS_CONNECT_FAILED",
    "message": "Cannot connect to the configured CallMate WebSocket endpoint",
    "details": {
      "target": "ws://host.docker.internal:3001/ws/voice"
    }
  }
}
```

At minimum recognize:

- `INVALID_REQUEST`
- `UNAUTHORIZED_MOCK_API`
- `CALL_NOT_FOUND`
- `INVALID_CALL_STATE`
- `TWIML_FETCH_FAILED`
- `INVALID_TWIML`
- `UNSUPPORTED_TWIML`
- `BACKEND_WS_CONNECT_FAILED`
- `BACKEND_WS_DISCONNECTED`
- `INVALID_RELAY_MESSAGE`
- `BROWSER_STT_UNAVAILABLE`
- `UNSUPPORTED_MEDIA_PLAYBACK`
- `CALL_TIMEOUT`

### 9.2 Session isolation

Support `MAX_ACTIVE_CALLS` simultaneous calls, each with independent WebSocket socket, ID, output token buffer, language, speech flags, logs, and lifecycle. Concurrent browser operator tabs must not corrupt each other. Either allow one clearly designated operator controlling a call or implement deterministic multi-tab locking; document the choice.

### 9.3 Logging

Log structured events for:

- REST calls and call state transitions
- TwiML fetch and selected relay target
- Relay WebSocket connection, setup, prompt, text, interrupt, DTMF, end, and close
- Operator answer/reject/hangup
- Status callback attempts and failures
- Validation errors, timeouts, and cleanup

Never log auth secrets or raw microphone recordings. Allow JSON event-log export for reproducible test cases. The export must clearly mark messages as **mock-generated**.

### 9.4 Lifecycle cleanup

Stop browser speech playback and close sockets at call end. Enforce maximum duration, bounded log size, request-body size, session retention, and removal of expired terminal sessions. Define graceful shutdown behavior for `SIGTERM` so `docker compose down` does not strand process resources.

---

## 10. Local-only security requirements

Even for a mock service, implement safe defaults:

- Publish the Docker UI/API on `127.0.0.1` only, not publicly.
- Never require or store real Twilio tokens, paid provider credentials, or customer secrets.
- Use Basic Auth for the Twilio-style REST route with local mock credentials.
- Validate and allowlist HTTP `Url`, status-callback destinations, and WebSocket hostnames to prevent SSRF; reject arbitrary internet targets by default.
- Parse XML with DTD/external entities disabled.
- Limit input size, transcript length, session length, active sessions, and WebSocket message size.
- Refuse CORS access from untrusted origins; browser UI must work from the local served origin.
- Do not forge Twilio production authentication/signature headers. Include `X-CallMate-Mock: true` on mock status webhooks.
- CallMate must have an explicit `TELEPHONY_PROVIDER=mock` (or equivalent) path so that development-only unsigned mock webhook/WS handling cannot accidentally be enabled in production.
- The Emulator must not initiate real PSTN calls under any circumstances.

---

## 11. Docker packaging contract

The repository delivered by the AI coding agent MUST include:

```text
mock-conversation-relay/
├── Dockerfile
├── compose.yaml
├── .dockerignore
├── .env.example
├── package.json
├── tsconfig.json
├── src/
│   ├── server/             # REST facade, state, TwiML, relay client
│   ├── protocol/           # Twilio-style message types and validators
│   └── web/                # Operator UI, browser STT/TTS
├── tests/
│   ├── protocol/
│   ├── rest/
│   └── integration/
└── README.md
```

A different internal tree is acceptable if functionality and separation of responsibilities remain the same.

**Required one-command start:**

```bash
docker compose up --build
```

Expected behavior:

- Service is reachable at `http://localhost:8080`.
- `/healthz` returns success.
- Container can access a CallMate backend on the host via `host.docker.internal` (including Linux Compose mapping).
- There is no mandatory external network dependency after images and dependencies have been installed; text-mode tests work fully locally.
- Builds are reproducible, the container restarts cleanly, logs go to stdout/stderr, and `docker compose down` stops the service.
- Supply `docker compose exec <service> npm test` (or equivalent) for protocol/REST/integration tests.

The README must document **only usage, configuration, API contracts, limitations, and troubleshooting**. A project calendar, implementation phases, and effort estimates are not required.

---

## 12. Required automated and manual acceptance tests

Deliver tests as runnable code, not only written descriptions. Every test below must have a deterministic pass/fail assertion. Tests may use a tiny local fixture WebSocket server representing CallMate's agent endpoint; **do not implement an AI agent**.

### 12.1 REST and lifecycle

1. `POST` to Twilio-style Calls endpoint with `Twiml` returns a valid `CA...` SID and shows a pending call in the UI/API.
2. The mock can fetch a CallMate TwiML URL and extract the correct `<ConversationRelay url>` and `<Parameter>` values.
3. Answering connects to the fake backend WebSocket and sends **one `setup` event first**.
4. `GET` Calls resource exposes `ringing`, `in-progress`, and `completed` as the call progresses.
5. Rejecting a ringing call never opens the relay WebSocket.
6. Hanging up terminates the WS and call; call status cannot become `booked` or any other business outcome.
7. Status callbacks are sent in order when configured and are visibly marked as mock callbacks.
8. Invalid TwiML or failed WebSocket connection produces a visible `failed` state, not a false success.

### 12.2 ConversationRelay protocol

9. A Polish caller utterance with diacritics is forwarded as a `prompt` event with `lang: "pl-PL"` and `last: true`.
10. The fake backend can respond with several `text` token events, finished by `last: true`; the UI displays the concatenated original text **without lost spaces**.
11. `setup.customParameters.taskId` matches the original TwiML `<Parameter>` or local session request exactly.
12. `interrupt` event includes both documented fields and cancels current browser playback when applicable.
13. `dtmf` button sends the correct single-digit `dtmf` event.
14. Backend `end` with JSON-encoded **string** `handoffData` ends the call and stores that exact string.
15. Unknown backend messages cause an `error` event; 10 consecutive invalid messages close with code `1007`.
16. Session language changes update future UI synthesis language, where supported.
17. Unexpected backend socket closure produces a failure/ended transport state and does not reconnect the same session invisibly.

### 12.3 Browser and isolation

18. Text input and transcript display work even when microphone or TTS support is absent.
19. A supported browser can generate a Polish-language voice `prompt` using Web Speech API; if recognition is unavailable, the UI gives a clear fallback message.
20. Two concurrent calls do not cross-deliver messages or leak text between transcripts.
21. Refreshing the operator UI does not create duplicate `setup` events or duplicate backend connections.
22. Closing the browser or stopping the container performs documented cleanup.
23. Running the acceptance suite does **not** contact Twilio, OpenAI, paid STT/TTS vendors, or real telephone numbers.

### 12.4 End-to-end manual acceptance scenario

Given a running CallMate backend WebSocket endpoint and an operator browser:

1. Configure CallMate's telephony provider as `mock` and point its mock Calls API base URL to `http://localhost:8080` (or `http://mock-relay:8080` from another Docker service).
2. Create a CallMate task: book a haircut after 17:00, with maximum price €25.
3. CallMate creates an outbound mock call through the Twilio-compatible REST route; the browser shows it as ringing.
4. Operator clicks **Answer**. The emulator opens the outbound WS to CallMate and sends a `setup` message with the correct `taskId`.
5. CallMate sends an AI `text` response; the operator sees/hears it.
6. Operator types or says: `Mamy termin o 18:00, ale kosztuje 35 euro.`
7. The Emulator forwards exactly that Polish caller turn as `prompt`.
8. CallMate's **own agent** evaluates the user constraint and replies; the Emulator simply displays/plays the reply.
9. Operator hangs up; mock Calls status and the CallMate backend's status handling reflect the session end.

**Acceptance criterion:** This path uses **no real Twilio account and no public server**. All simulated transport flows through the same ConversationRelay-compatible WebSocket handler that CallMate intends to use with real Twilio, except for explicit mock authentication and transport-base-URL configuration.

---

## 13. Integration examples for the CallMate backend

### 13.1 Configuration switch

The recommended development switch is:

```dotenv
TELEPHONY_PROVIDER=mock
MOCK_TWILIO_API_BASE=http://localhost:8080
MOCK_TWILIO_ACCOUNT_SID=AC00000000000000000000000000000000
MOCK_TWILIO_USERNAME=mock
MOCK_TWILIO_PASSWORD=mock-local-only
```

When the CallMate backend itself runs in Docker on the same Compose network, use its **Compose service name** instead of `localhost`. When the Emulator runs in Docker and CallMate runs on the host, use `host.docker.internal` for callbacks and the ConversationRelay WebSocket target. These are two different network directions.

### 13.2 Calls API example (Node.js)

This example shows how CallMate can swap the provider **without** importing the Twilio SDK into the Emulator:

```ts
const accountSid = process.env.MOCK_TWILIO_ACCOUNT_SID!;
const base = process.env.MOCK_TWILIO_API_BASE!;
const auth = Buffer.from(
  `${process.env.MOCK_TWILIO_USERNAME}:${process.env.MOCK_TWILIO_PASSWORD}`
).toString('base64');

const body = new URLSearchParams({
  To: '+48111222333',
  From: '+48000111222',
  Url: 'http://host.docker.internal:3001/twiml',
  StatusCallback: 'http://host.docker.internal:3001/twilio/status',
  StatusCallbackEvent: 'initiated ringing answered completed',
});

const response = await fetch(
  `${base}/2010-04-01/Accounts/${accountSid}/Calls.json`,
  {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  },
);
if (!response.ok) throw new Error(await response.text());
const mockCall = await response.json();
console.log(mockCall.sid);
```

Note: the default CallMate `Url` above is appropriate only if the CallMate backend is reachable through that URL **from the Emulator container**. The actual endpoint may differ.

### 13.3 Agent WS protocol example (backend fixture)

The backend should already implement a WebSocket server that can receive `setup` and `prompt` and send `text`. A minimal *fixture contract* for tests is:

```ts
// On connection: expect { type: 'setup', ... } first.
// On { type: 'prompt', voicePrompt, last: true }:
ws.send(JSON.stringify({
  type: 'text',
  token: 'Dziękuję. Czy jest tańsza opcja?',
  last: true,
}));
```

This is not part of the Emulator runtime and must not be substituted for CallMate's actual agent implementation.

---

## 14. Definition of Done

The delivered project is considered complete **only when** all of the following hold:

- `docker compose up --build` starts the Emulator and the browser UI at `localhost:8080` without Twilio credentials.
- A simulated outbound call can be created through the Twilio-like Calls API and manually answered in the browser.
- On acceptance, the Emulator opens the **outgoing** WebSocket to CallMate's ConversationRelay endpoint, sends the complete `setup` message first, then sends caller `prompt` events.
- The browser shows streamed `text` replies and can speak them with browser TTS when available.
- Text input works reliably without STT/TTS/browser permissions.
- Call lifecycle, DTMF, interruption, end/close, and errors are observable and validated.
- The required direct API and Twilio-like REST facade work as specified.
- Sessions remain isolated, security defaults are local-only, and there is no dependence on paid infrastructure.
- The repository includes automated tests covering the acceptance criteria and all tests pass.
- README explains how to point **CallMate** at the Emulator and how to later switch to actual Twilio, including clearly stated protocol limitations and the need to test the real provider separately.
- **Do not deliver only pseudocode, an architecture diagram, or a project plan. Deliver complete runnable code, a Docker configuration, tests, and the local UI.**

---

## 15. Compatibility references

Use these sources as normative references for field names and event direction. If documentation has changed by implementation time, prefer Twilio's current contract, document any deviations explicitly, and keep the supported subset precise.

1. Twilio ConversationRelay WebSocket message reference: https://www.twilio.com/docs/voice/conversationrelay/websocket-messages
2. TwiML `<ConversationRelay>` and `<Parameter>` reference: https://www.twilio.com/docs/voice/twiml/connect/conversationrelay
3. Twilio Calls API (`Create`, `Retrieve`, `Update`): https://www.twilio.com/docs/voice/api/call-resource
4. Twilio Node custom HTTP client guidance (only if needed by consuming backend): https://github.com/twilio/twilio-node/blob/main/advanced-examples/custom-http-client.md
5. Browser SpeechRecognition: https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition
6. Browser SpeechSynthesis: https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesis

**Honest compatibility statement:** This product is a developer emulator for a *documented subset* of Twilio ConversationRelay and Twilio's Calls API. It cannot validate real Twilio signatures, actual telecommunications, speech recognition quality, carrier statuses, live TTS provider quirks, or production network behavior. Real Twilio integration still requires a separate integration test when available.
