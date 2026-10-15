# CallMate Mock ConversationRelay

A standalone local replacement for the supported Twilio Calls REST and ConversationRelay transport. A human uses the browser to answer CallMate's simulated outbound call and act as the business. The emulator opens the outbound WebSocket **to your backend**, sends caller speech as `prompt`, and displays the backend's streamed `text` replies.

There is no AI agent, appointment logic, real phone call, paid speech provider, or external database in this service. The official Twilio SDK is used only by development compatibility tests and is omitted from the runtime image. Browser speech is optional. Text mode needs only Docker and your local backend.

## Start and stop

From this directory:

```sh
docker compose up --build
```

Open **http://localhost:8080/**. Health: http://localhost:8080/healthz.

From the CallMate repository root, the equivalent command is:

```sh
docker compose -f mock-conversation-relay/compose.yaml up --build -d --wait mock-relay
```

The Node process binds `0.0.0.0` inside its container. Docker publishes only `127.0.0.1:8080` on the host. The runtime is read-only, runs as an unprivileged user, and serves both the TypeScript browser client and API. Dependencies/builds/servers stay in Docker.

```sh
docker compose logs -f mock-relay
docker compose down
```

All state is in memory. Restarting deletes sessions. SIGTERM marks active calls failed with `SERVICE_SHUTDOWN`, closes relay/operator sockets, and gives bounded callback delivery a short grace period. Nothing resumes or redials on restart.

## Point CallMate at the emulator

The existing CallMate backend now includes a development relay handler. From the repository root, start both Docker services:

```sh
docker compose up --build -d --wait server
docker compose -f mock-conversation-relay/compose.yaml up --build -d --wait mock-relay
```

The root Compose defaults select `NODE_ENV=development`, `TELEPHONY_PROVIDER=mock`, and `CALLMATE_MODE=simulator`. For the simple two-window flow, open **http://localhost:3000/**, enter an initial message and click **Start conversation**. Follow **Open operator window**, answer, and type a reply. The initial message appears here with a **Listen** button: click it after answering to hear the message using your browser/OS voice. The operator's reply appears on the backend page. Stop on the backend page ends the mock call. See the [backend UI guide](../docs/docker-development.md#9-simple-backend-conversation-ui) for configuration and lifecycle details.

For the independent echo flow, create a call at `localhost:8080` using `ws://host.docker.internal:3001/ws/voice`, answer it, and send text. You receive a development greeting and streamed echo replies in the caller's language (Russian, Spanish, Polish, or English). Type `/end` to test backend hangup, or use **Hang up**. For a changed callback port, update the relay URL accordingly.

This verifies the actual emulator-to-backend transport. Backend-started console calls now use `conversationId` and an opaque, process-local token to attach to a persisted `manual_mock` attempt. They share SQLite transcripts, history, Stop, the active-call reservation and SSE with the scripted simulator. Their snapshots have no booking plan/authority, and completion never confirms a booking. Direct operator-created echo calls remain ephemeral; `taskId` and other custom parameters cannot authorize booking actions. The earlier signed loopback harness remains an independent test tool. Production provider/dialogue integration and robust recovery remain subsequent work. No AI agent runs inside the emulator.

The root backend uses `CALLMATE_MOCK_API_BASE`, `CALLMATE_MOCK_OPERATOR_ORIGIN`, `CALLMATE_MOCK_RELAY_URL`, and `MOCK_ACCOUNT_SID` / `MOCK_API_USERNAME` / `MOCK_API_PASSWORD` from the root `.env.example`. Its Compose defaults connect the separate containers through the host gateway. The `MOCK_TWILIO_*` names below belong only to the reusable adapter example, not the root backend.

For another consuming backend, adapt this example configuration:

```dotenv
NODE_ENV=development
TELEPHONY_PROVIDER=mock
MOCK_TWILIO_API_BASE=http://localhost:8080
MOCK_TWILIO_ACCOUNT_SID=AC00000000000000000000000000000000
MOCK_TWILIO_USERNAME=mock
MOCK_TWILIO_PASSWORD=mock-local-only
```

`src/client/mock-telephony-provider.ts` is a runnable, typed adapter example that uses fetch/form encoding instead of the Twilio SDK. Copy/adapt it into the consuming backend and instantiate it only in development/test with `provider: "mock"`. Its `createCall`, `getCall`, and `hangup` methods talk only to the configured local API base (`localhost`, `127.0.0.1`, `host.docker.internal`, or `mock-relay`); it does not automatically retry ambiguous creates. It never changes DNS or redirects arbitrary Twilio traffic.

```ts
const provider = new MockTelephonyProvider({
  environment: 'development', provider: 'mock',
  baseUrl: 'http://localhost:8080',
  accountSid: 'AC00000000000000000000000000000000',
  username: 'mock', password: 'mock-local-only',
});
const call = await provider.createCall({
  from: '+48000111222', to: '+48111222333',
  url: 'http://host.docker.internal:3001/twiml',
  statusCallback: 'http://host.docker.internal:3001/twilio/status',
});
```

There are two separate network directions:

- Backend → emulator Calls API: use `http://localhost:8080` when the backend runs on the host. On a shared Docker network, use `http://mock-relay:8080`.
- Emulator → backend TwiML/webhooks/relay: use `http://host.docker.internal:3001/...` / `ws://host.docker.internal:3001/...` for a host backend. Docker Compose includes `host.docker.internal:host-gateway` for Linux. A host backend must bind to an address reachable from Docker, not only its host loopback when that prevents Docker access. Restrict access with your local firewall. If both services share a Docker network, use the backend's service name and explicitly add it to `ALLOWED_BACKEND_HOSTS`.

The emulator sends **`X-CallMate-Mock: true`** plus **`X-Twilio-Signature`** on TwiML fetches, status callbacks, Connect action requests and relay WebSocket handshakes. Signatures use Twilio's HMAC-SHA1 algorithm with the synthetic `MOCK_AUTH_TOKEN`. HTTP POST signs the full destination URL and sorted form fields; HTTP GET signs the URL including all appended query fields, with an empty form. WebSocket upgrades sign the exact configured WS/WSS URL with an empty form. The tests verify these signatures with the official SDK, including query strings and Unicode values.

Configure your development verifier with the same synthetic token and the externally requested URL. Do not reconstruct a different URL from an internal proxy address. The extra mock marker identifies development traffic; it grants no production authentication. The root backend currently keeps its existing development/mock gate and accepts the marker; the standalone compatibility fixtures require valid signatures. This extension supersedes the original specification's unsigned-only mock behavior; no real account credentials are used or published.

Calls Basic auth accepts either the original `MOCK_API_USERNAME:MOCK_API_PASSWORD` pair or the SDK-compatible `MOCK_ACCOUNT_SID:MOCK_AUTH_TOKEN` pair. Both are development credentials. [The SDK compatibility tests](tests/twilio-compatibility.test.mjs) provide a bounded custom HTTP transport that sends the official SDK's Calls requests to the emulator. No global DNS replacement is needed.

These improvements do not yet make the root app switchable to real Twilio through configuration alone: its mock health probe, local-only Calls client and development relay gate remain. A production adapter still needs real SDK transport, signature validation against the public endpoint, credentials, phone-number configuration, durable call correlation and HTTPS/WSS. The emulator verifies protocol behavior against SDK validation, not Twilio infrastructure, carrier behavior, billing, live TTS/STT or production networking. A real-provider integration test is still required.

## Quick manual session

Start your backend relay handler, then click **Create a mock call**, enter its allowlisted WebSocket URL and a task ID, and create the ringing call. Answer it, type a caller utterance, and inspect the replies/diagnostics. The backend must implement the agent; the emulator never invents replies.

Alternatively:

```sh
curl http://localhost:8080/api/sessions \
  -H 'Content-Type: application/json' \
  -d '{"relayWsUrl":"ws://host.docker.internal:3001/ws/voice","customParameters":{"taskId":"test-123"}}'
```

The response includes `id`, `status`, and `operatorUrl`; opening that URL selects the pending call. Answer in the browser or use `POST /api/sessions/{id}/answer` before a browser claims it.

Create through the Calls façade with inline TwiML:

```sh
curl -u mock:mock-local-only \
  http://localhost:8080/2010-04-01/Accounts/AC00000000000000000000000000000000/Calls.json \
  --data-urlencode 'To=+48111222333' \
  --data-urlencode 'From=+48000111222' \
  --data-urlencode 'Twiml=<Response><Connect><ConversationRelay url="ws://host.docker.internal:3001/ws/voice" language="pl-PL"><Parameter name="taskId" value="task-demo-001"/></ConversationRelay></Connect></Response>'
```

## Configuration

Copy `.env.example` to `.env` in this directory to override Compose defaults. These are synthetic local credentials; never supply real Twilio credentials.

| Variable | Default / behavior |
| --- | --- |
| `NODE_ENV` | `development`; service refuses production mode. Compose fixes this to development. |
| `PORT` | `8080`, both container port and loopback host port |
| `MOCK_ACCOUNT_SID` | `AC` followed by 32 zeroes |
| `MOCK_API_USERNAME`, `MOCK_API_PASSWORD` | `mock`, `mock-local-only`; original local Calls REST Basic auth |
| `MOCK_AUTH_TOKEN` | `mock-auth-token-local-only`; synthetic outgoing-signature token and SDK-compatible Calls Basic password with `MOCK_ACCOUNT_SID` as username |
| `MOCK_DIAL_DELAY_MS` | `0`; 0–60,000ms in `queued` before dialing, processed by the 500ms sweep; zero preserves immediate ringing |
| `CALLMATE_WS_URL` | `ws://host.docker.internal:3001/ws/voice`, direct-session fallback |
| `CALLMATE_TWIML_URL` | `http://host.docker.internal:3001/twiml`, published in `/api/config` for tooling; use it explicitly as Calls `Url` / direct `url` to fetch TwiML |
| `DEFAULT_LANGUAGE` | `pl-PL`; UI also offers Spanish `es-ES`, Russian `ru-RU`, English `en-US` and session-provided language tags |
| `DEFAULT_FROM`, `DEFAULT_TO` | `+48000000000`, `+48111111111`; fictional display numbers |
| `AUTO_ANSWER` | `false`; explicit direct-session `autoAnswer` overrides it |
| `ENABLE_BROWSER_SPEECH` | `true`; permits browser speech controls; TTS remains opt-in via checkbox |
| `MAX_ACTIVE_CALLS` | `5`, configurable 1–20 |
| `CALL_TIMEOUT_SECONDS` | `300`, maximum total call lifetime (1–3600 seconds) |
| `BACKEND_TIMEOUT_MS` | `2500`, HTTP request/response and WebSocket connection deadline (100–10000ms) |
| `SESSION_RETENTION_MINUTES` | `60` after terminal state (1–1440 minutes) |
| `LOG_LEVEL` | `info`; `silent`, `error`, `warn`, `debug` also supported |
| `ALLOWED_BACKEND_HOSTS` | `host.docker.internal,localhost,127.0.0.1`; exact hostname allowlist |

The default ringing timeout is 30 seconds, capped by maximum call lifetime. Direct `timeout` / Calls `Timeout` may select 1–600 seconds without exceeding the configured lifetime. No-answer ends with `no-answer`; reaching the maximum duration after answer ends with `failed` / `CALL_TIMEOUT`. Cleanup runs every 500ms. Terminal call status never reopens. Rejecting a ringing call produces `busy`. The existing mock Hang up / `Status=completed` operation produces `completed`, including pending calls, for compatibility with the development console; use `Status=canceled` to test Twilio-style pre-answer cancellation. Neither status indicates appointment success.

## REST contract

JSON management endpoints are local, same-origin development APIs. Invalid fields return HTTP 400; invalid transitions/ownership return 409; missing calls return 404. Errors use `{ "error": { "code": "…", "message": "…" } }`. A failed answer returns the session with `status: "failed"` and a structured `lastError`, so failure diagnostics remain inspectable.

| Method | Route | Payload / use |
| --- | --- | --- |
| GET | `/healthz` | Health and mock service identity |
| GET | `/api/config` | Safe public defaults, never API credentials |
| POST | `/api/sessions` | Optional `to`, `from`, `language`, `relayWsUrl`, `customParameters`, `autoAnswer`, `twiml`, `url`, `method`, `timeout`, `statusCallback`, `statusCallbackMethod`, `statusCallbackEvents` |
| GET | `/api/sessions` | `{sessions: [...]}` including timestamps, status and diagnostics |
| GET | `/api/sessions/:id` | Complete session snapshot |
| POST | `/api/sessions/:id/answer` | Ringing only; fetch/parse/connect, then exactly one setup |
| POST | `/api/sessions/:id/reject` | Ringing only → busy |
| POST | `/api/sessions/:id/hangup` | End active call; terminal calls return unchanged status |
| POST | `/api/sessions/:id/utterances` | Connected only: `{text, lang?, last?}`; last defaults true |
| POST | `/api/sessions/:id/interrupt` | Connected only: `{utteranceUntilInterrupt?, durationUntilInterruptMs?}`; defaults `""`, `0` |
| POST | `/api/sessions/:id/dtmf` | Connected only: `{digit: "0"…"9" / "*" / "#"}` |
| GET | `/api/sessions/:id/events` | `{mockGenerated:true, events, droppedEvents}`; redacted chronological events |
| DELETE | `/api/sessions/:id` | Terminal calls only |

Browser ownership locks also protect management mutations. Unowned calls can be controlled through REST; when a browser owns a call, competing controls receive 409. Its operator commands use the separate WS channel. Backend-authenticated Calls REST completion always takes priority over an operator lock.

Calls façade routes use the configured account SID and either supported Basic credential pair:

- `POST /2010-04-01/Accounts/:accountSid/Calls.json`: form fields `To`, `From`, either `Url` or `Twiml`, optional `Method`, `StatusCallback`, `StatusCallbackMethod`, repeated `StatusCallbackEvent`, `Timeout`. A whitespace-separated event list is also accepted for local examples. `Url` wins if both sources are provided. HTTP 201 returns the current queued or ringing resource, depending on the configured dial delay. Unsupported fields/updates are rejected.
- `GET /2010-04-01/Accounts/:accountSid/Calls/:callSid.json`: snake_case resource with SID/account/from/to/direction/status, runtime RFC 2822 dates, start/end, duration, URI, `api_version`, and null price fields. Duration is a string after successful completion; unsuccessful/ongoing calls have null duration/end time, and unknown dates are null.
- POST to the same call resource with `Status=completed`: idempotent mock hangup.
- POST with `Status=canceled`: cancel a queued or ringing call; already terminal calls remain unchanged. Canceling an answered call returns 400. Queue cancellation sends no status callbacks and never starts dialing. Ringing cancellation produces the subscribed `completed` event with `CallStatus=canceled`.
- This subset does not support call forwarding, recordings or TwiML replacement.
- Errors are Twilio-shaped `{code,message,more_info,status}`: auth uses 20003, missing resources 20404, unsupported/invalid requests 20001 with a mock-specific diagnostic. This is not Twilio's full validation/error catalogue.

Callbacks run serially per call with a configurable per-request deadline (2.5s by default), no retries, response size limits, and no redirects. Failure appears in `callbacks` and `lastError`, never blocks controls, and does not redial. Subscriptions default to `completed`; `answered` sends `CallStatus=in-progress`. Callbacks include account/call/from/to/direction, sequence starting at zero, RFC 2822 timestamp, callback source, and terminal duration. `<Connect action>` is called with session details after relay end. For backend `end`, the call remains `in-progress` while this response is fetched and interpreted; see the continuation subset below. Action responses after an already terminal caller hangup/failure are recorded without resuming the call. All requests are explicitly marked local mock traffic.

## TwiML and WebSocket contract

Selection order is Calls/direct `url` → inline `twiml` → direct `relayWsUrl` → configured fallback. A failed/malformed explicit TwiML source fails the call; it never silently falls back. Supported XML is exactly `Response > Connect > ConversationRelay` with `Parameter` children. XML is size-bounded and validated; DTD/entity declarations are rejected. Built-in XML escapes round-trip. Parameters retain names/values. Supported attributes include `url`, `language`, `transcriptionLanguage`, `ttsLanguage`, `welcomeGreeting`, `interruptible`, and Connect `action`/`method`. Other TwiML verbs produce `UNSUPPORTED_TWIML`.

The emulator is the relay **client**, one socket per call. It sends a complete `setup` first, then operator `prompt`, `dtmf`, `interrupt`, and protocol `error` events. Partial prompts are available only through explicit test input. Unicode text, including Polish, Spanish accents and Russian Cyrillic, is preserved without translation. Unconnected input returns 409.

Backend messages:

- `text`: string `token` (empty allowed), optional `last` default false, `lang`, `interruptible`, `preemptible`. Tokens concatenate exactly. Final utterances may be spoken in the browser; partial tokens are displayed without restarting TTS.
- `end`: optional **string** `handoffData`, preserved exactly. Ends the relay socket and returns control to the Connect action, with `SessionStatus=ended`, `CallStatus=in-progress`, session duration and optional `HandoffData`. It does not itself complete a call when an action is pending. With no action, the supported initial TwiML has no remaining instructions, so the call completes. No outbound `end` or caller prompt is synthesized. Normal caller hangup uses socket closure and status callbacks.
- `language`: `ttsLanguage` and/or `transcriptionLanguage` updates future defaults and UI controls.
- `sendDigits`: validated digit string is recorded as a visible raw event; no tones are produced.
- `play`: validated request is recorded with `UNSUPPORTED_MEDIA_PLAYBACK`; media URLs are never fetched.
- Invalid/unknown messages send protocol `error`. Valid frames reset the counter; ten consecutive invalid frames close 1007. Unexpected socket closure, even close 1000 without `end`, is a failure, never a successful booking. No automatic relay reconnect occurs.

### Queue and Connect continuation checks

Set `MOCK_DIAL_DELAY_MS=1000` in the emulator's `.env` and recreate its Docker service to expose the queued state through Calls GET/create responses. `initiated` fires when dialing starts, followed by `ringing`; `Timeout` starts then. Maximum call lifetime includes queue time. Queued calls occupy the active-call limit. The normal operator Answer controls appear when ringing starts; cancel a queued call through the Calls API. Reset the delay to zero for the original immediate-ringing workflow. Terminal calls never resume.

For backend `end`, the Connect action's XML response supports an empty `<Response/>`, `<Hangup/>`, and up to 20 `<Pause length="1..60"/>` / Hangup instructions. For example, `<Response><Pause length="2"/><Hangup/></Response>` keeps the call active with a disconnected relay for two seconds, then completes it. Completion callbacks fire only after continuation finishes. A pending continuation is bounded by the call lifetime and can be ended by Hang up / Calls completion. Late action responses cannot reopen a terminal call; actions are delivered once without automatic retry.

Unsupported or malformed action TwiML fails the call with an explicit diagnostic. This is not a full TwiML interpreter: new Connect sessions, Dial/transfer, Say/Gather/Redirect, media execution and sibling instructions after the initial Connect are not implemented. Initial TwiML still requires exactly the Response/Connect/ConversationRelay structure above. The original mock completed on every relay `end`; callers with an action now must return supported continuation XML. Returning `<Response><Hangup/></Response>` preserves immediate completion after the action.

## Browser control channel and speech

The UI connects only to `/operator`, never directly to the backend. Server messages are `snapshot` (`operatorId`, safe config, sessions), `session`, `deleted`, `ack` (`requestId`, `callSid`), and `error` (`requestId`, `code`, `message`). Commands are `{type,callSid,requestId,...}`: `claim`, `release`, `answer`, `reject`, `hangup`; `utterance`/`interrupt`/`dtmf` with `payload`; `language` with `language`; and `speech-status` with a bounded speech diagnostic code/message. Runtime schemas validate commands.

One operator connection controls each call. Other tabs can observe but cannot control it. Release controls before switching operators. A refresh closes the browser channel and releases the lock; calls/relay sockets continue until explicit hangup or timeout. Reconnection reloads a snapshot, never resends setup/answer or replays old AI speech. Closing the browser cancels its local speech and releases ownership; it deliberately does not hang up a potentially live backend conversation. Session deadlines provide unattended cleanup.

Both the new-call and active-call language selectors offer Polski (`pl-PL`), Español (`es-ES`), Русский (`ru-RU`), and English (`en-US`). Select a language before creating a call, or change it during a connected call. The selected locale is used for caller prompts and microphone recognition; AI reply speech uses the backend message/TTS language. Set `DEFAULT_LANGUAGE=ru-RU` or `DEFAULT_LANGUAGE=es-ES` to change the initial selection (the default remains `pl-PL`). Russian and Spanish microphone/audio availability depends on browser recognition support and installed voices; typed text works regardless. The operator UI remains in English.

Text is always authoritative. The microphone requests permission only on Start, emits final recognition results, and handles unsupported/denied/ended recognition with a text fallback. Recognition pauses during AI synthesis to reduce feedback; browser behavior varies. Browser STT **may contact a browser vendor's service**. Offline STT/privacy is not promised; automated tests stub speech APIs and never use paid services.

Audio is opt-in. After answering a call, click **Listen** beside any finalized backend message, including the initial message from the backend UI. This plays that exact text once without enabling automatic speech, redialing, or sending another caller prompt. **Stop audio** cancels local playback. Partial messages and caller text have no Listen button; playback is available only to the controlling tab while connected.

Enable **Auto-play backend messages** above the transcript before answering to hear new messages automatically. Turning it on after a message arrives does not replay old messages; use Listen for those. Refresh remains silent until you explicitly request playback. Volume and Voice remain under **Speech & keypad**. It uses available browser/OS voices and the message/session language; the default chooses a matching language voice when available, and an explicit Voice selection overrides it. If voices or synthesis are unavailable, text remains visible. Only the controlling tab speaks the selected call, buffered until `last=true`. Current `interruptible=false` prevents the manual speech interrupt; current `preemptible=true` allows the next completed speech turn to cancel it. These are browser approximations, not Twilio audio timing guarantees. Interrupt's heard-text prefix uses optional browser word-boundary positions and elapsed playback time; it is not character-accurate. Manual protocol interrupt is available with empty text/zero duration when no audio is playing. No playback-completed ACK is sent to the backend.

## Limits and troubleshooting

All outbound HTTP/WS destinations must match the configured host allowlist; credentials in URLs and sensitive query keys are refused, redirects are disabled, and backend responses are limited to 16KiB. HTTP/WS commands are limited to 32KiB, transcript/token inputs to 8,000 characters, assembled speech turns to 32,768 characters, and inline TwiML to 4,000 characters. Each call retains at most 200 redacted events, 100 transcript entries, and 50 callback diagnostics; exported events report dropped history. The service retains at most 200 sessions and 20 browser connections. Slow operator/back-end buffers are bounded. No raw microphone audio is stored. Structured logs go to stdout and omit credentials and event bodies.

Untrusted Host/Origin/cross-site requests are rejected; no CORS access is granted. Use `localhost` or `127.0.0.1`, or `mock-relay` from a shared Docker network. The UI/API is not production authentication: keep its published port local and do not put it behind a public proxy.

- **Answer changes the call to Failed:** rebuild/start the root backend with the development/mock/simulator settings above, and use its `/ws/voice` URL when creating a new call. An older backend image, disabled mock gate, or wrong URL returns HTTP 404; a missing marker or browser Origin returns 403. Failed calls cannot be answered again. The call view displays the failure reason and destination without opening diagnostics; HTTP upgrade rejection includes the status code. Other connection failures require checking listener binding, Docker reachability/firewall, and acceptance of explicitly marked development traffic.
- **Docker cannot reach the host:** use `host.docker.internal`, check host listener binding/firewall, and use the included Linux host-gateway mapping. Container `localhost` is the container itself.
- **Host rejected:** add the backend's exact service hostname to `ALLOWED_BACKEND_HOSTS`; arbitrary internet destinations are denied by default.
- **409 controls locked:** release the call in the other browser tab or close that tab. Refreshing does not duplicate the relay connection.
- **No microphone/audio:** use typed input; select an available voice and explicitly enable speech. Recognition is browser-dependent; localhost is a secure context in supporting browsers.
- **Port 8080 taken:** set `PORT` in `.env` and recreate the container.
- **Logs disappear after restart:** expected; storage is process-local. Export event JSON before stopping.

## Checks

From this directory, run the complete suite inside a disposable container:

```sh
docker compose --profile checks run --build --rm checks
```

The checks container has **external networking disabled**. Tests use loopback HTTP/WS backend fixtures, never an agent or a paid API. REST/lifecycle/protocol tests exercise real sockets; SDK compatibility tests exercise create/fetch/complete/cancel, SDK-deserialized resources and errors, signed GET/POST callbacks and WS upgrades, token mismatches, queued cancellation, action continuations and late responses; browser tests execute the TypeScript UI/speech controller against a DOM with stubbed speech APIs. The full operator-flow test also sends browser commands through real operator/relay sockets to a fixture backend. Tests inject clock/ID factories through `Controller(config, {now, makeId})`; HTTP clients cannot select deterministic IDs. Normal IDs use cryptographic randomness. Those tests do not establish actual device/browser STT quality. For manual acceptance, use the operator with your backend, test text and optional speech, interrupt/hangup, refresh, and inspect the diagnostics.

Normative format references: [ConversationRelay messages](https://www.twilio.com/docs/voice/conversationrelay/websocket-messages), [ConversationRelay TwiML](https://www.twilio.com/docs/voice/twiml/connect/conversationrelay), [Calls resource](https://www.twilio.com/docs/voice/api/call-resource), [SpeechRecognition](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition), [SpeechSynthesis](https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesis). This is a development emulator for a documented subset, not an official Twilio implementation.
