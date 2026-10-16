# Offline Twilio protocol mock

This mock tests the Calls REST, webhook, TwiML, and ConversationRelay boundaries over real local HTTP and WebSocket connections. It uses the official Twilio Node SDK for request serialization, resource deserialization, signature generation/validation, and TwiML generation.

It is a separate adapter harness. The existing private API/SSE simulator still uses its scripted fake adapters. Starting a call through `/api/v1/calls` does not use this mock. Neither this harness nor the simulator can call a real phone number.

## Run in Docker

Run all checks, including the protocol tests:

```sh
docker compose --profile checks run --build --rm checks
```

Run the standalone protocol walkthrough:

```sh
docker compose --profile checks run --build --rm checks npm run demo:twilio-mock --workspace @callmate/server
```

The walkthrough starts two ephemeral listeners on `127.0.0.1` **inside the container**, exchanges a scripted Spanish prompt and authorized response, ends the relay session, queries the call, prints a summary, and exits. No host ports, credentials, `.env`, tunnel, Twilio account, database, or model are needed. The Compose checks service has external networking disabled; the demo works over container loopback.

Expected summary fields include:

```json
{
  "mode": "offline-twilio-protocol-demo",
  "callStates": ["dialing", "ringing", "connected", "ended"],
  "relayReceived": ["text", "end"],
  "realPhoneCall": false,
  "bookingConfirmed": false
}
```

## Components and supported formats

| Component | Responsibility |
| --- | --- |
| `apps/server/src/twilio/mock.ts` | Twilio-side Calls REST server, signed callback delivery, TwiML parsing, WebSocket client, scripted provider events |
| `apps/server/src/twilio/mock-adapter.ts` | Application-side `TelephonyPort` probe, authenticated callback/upgrade listener, session correlation, permit-gated text submission |
| `apps/server/src/twilio/protocol.ts` | Provider wire schemas and explicit mapping to shared call states |
| `apps/server/src/twilio/local-http.ts` | Loopback-only transport helpers and synthetic test identity |
| `apps/server/test/twilio.test.mjs` | Network contract tests, including independently constructed malformed frames |

The mock supports this subset:

- `POST /2010-04-01/Accounts/{AccountSid}/Calls.json`, authenticated with HTTP Basic auth, returns HTTP 201 and a snake_case call resource. Requests use `application/x-www-form-urlencoded`; `StatusCallbackEvent` subscriptions use repeated fields. The adapter sends `To`, `From`, `Url`, `Method`, `StatusCallback`, `StatusCallbackMethod`, `StatusCallbackEvent`, `TimeLimit`, `Timeout`, and `Record=false`.
- `GET /2010-04-01/Accounts/{AccountSid}/Calls/{CallSid}.json` returns HTTP 200 with the current resource. SDK consumers receive its normal camelCase fields and parsed dates. Mock dates use RFC 2822-compatible UTC strings; unknown duration/price values are null. Mock values are not billing estimates.
- Updating a call uses POST to the same resource. Stop queries first, sends `Status=canceled` for queued/ringing calls, and sends `Status=completed` for a connected call. Cancellation while queued emits no status callback.
- REST errors use `code`, `message`, `more_info`, and `status`. Tests cover authentication (20003), missing destination (21201), invalid destination (21211), and missing resource (20404). Unsupported mock options fail with a local diagnostic in a Twilio-shaped envelope; this does not reproduce every Twilio error or validation rule.
- Status callbacks are signed form POSTs with `AccountSid`, `CallSid`, `From`, `To`, `CallStatus`, `CallbackSource`, `SequenceNumber`, and `Timestamp`. `answered` subscriptions produce `CallStatus=in-progress`. Terminal results, including busy/no-answer/failed/canceled, use the `completed` subscription. Sequence numbers start at zero; duplicate/stale deliveries do not regress application state, and terminal calls cannot reopen.
- The signed Voice callback receives SDK-generated `<Response><Connect action="…"><ConversationRelay url="…" language="es-ES"><Parameter name="attemptId" value="…"/></ConversationRelay></Connect></Response>` TwiML. The mock parses the actual XML to find the relay URL, action URL, and custom parameters.
- The initial WebSocket upgrade carries `X-Twilio-Signature`. The mock sends documented `setup`, `prompt`, `dtmf`, `interrupt`, and `error` shapes. Setup must match the registered account, call, attempt, and phone numbers. Only `prompt` messages with `last=true` produce finalized business utterances; partial prompts remain observations.
- Application output supports `text` and `end`. Text uses `token`, `last`, `lang`, `interruptible`, and `preemptible`; token whitespace is preserved. `handoffData` is a string, including when it contains JSON. Malformed output receives an `error` message; ten consecutive malformed messages close the WebSocket with code 1007. A valid frame resets that counter.
- Ending a session sends a signed `<Connect action>` form callback with `SessionId`, `SessionStatus`, `SessionDuration`, and optional `HandoffData`. The adapter checks the session and returns `<Hangup/>`; the mock then completes the call. Caller hangup is also supported.

## Application-side safety and observations

`MockTwilioAdapter` implements the shared `TelephonyPort` without changing the UI message contract. Its callback routes exist only on its own temporary listener. The main server's callback listener remains closed to provider requests.

`LoopbackTwilioClient` allows only Calls create/fetch/update paths for the synthetic account. It rewrites the SDK request destination to a numeric loopback origin, disables redirects/proxies, and refuses external mock URLs. Callback destinations and relay destinations must also be numeric loopback URLs. Both sides use a plainly synthetic test auth token; never replace it with a real credential.

HTTP signatures are checked with the SDK against the configured URL and **all** received form fields before schema parsing, including unknown future parameters. Forwarded Host headers do not choose the validation URL. Callback account/call/number correlation and WebSocket setup correlation are separate checks.

The probe defaults to denying text. A caller must supply a permit-consumption function to authorize `sendAuthorizedText`. The probe also checks schema, attempt, plan/version, expiry, session state, and one-use permit ID. The consuming backend remains responsible for current turn/offer/policy authorization. The standalone demo grants only synthetic output.

A successful socket send proves submission only. ConversationRelay does not document a generic playback-completed acknowledgment, so this adapter never emits one and never marks a booking confirmed. Interruptions report the provider's `utteranceUntilInterrupt`; they do not prove full playback. Transport loss blocks further output and does not automatically redial, reconnect, or infer that the PSTN call has ended. Stop blocks output immediately even when the REST result is unknown.

## Limits and next integration work

This is an independently runnable protocol harness, not the completed live Twilio adapter or an official Twilio emulator. Its state is in memory. Provider progress is controlled explicitly by tests/demo; it does not execute `TimeLimit`/`Timeout`, speech recognition, synthesis, phone routing, cost ceilings, or booking policy. Recording, media streams, inbound calls, API-key auth, pagination, callback retry scheduling, TLS, debugger events, all error codes, and ConversationRelay `play`/`sendDigits`/`language` output are outside this subset.

The local transport intentionally uses `http://` and `ws://`, signing the configured local URLs. Live Twilio requires public HTTPS/WSS URLs. Live validation must verify the exact public signature URL through the chosen proxy/tunnel and actual ConversationRelay handshake; a self-signed local exchange cannot establish that behavior.

Before connecting this boundary to the main app, Engineer 2 still needs durable attempt/call/session correlation, handling callbacks that arrive before the REST response, create-result reconciliation, restart recovery, deadlines/cost enforcement, and normalized events feeding the controller's transactional snapshots/SSE. Those tasks must preserve Engineer 3's policy/permit boundary and the existing UI contracts. Then perform the real connectivity checks in the [Twilio setup runbook](twilio-setup.md), including Spanish speech, interruption behavior, Stop, and billing limits.

## Official sources

The supported formats were checked against these Twilio references on 15 October 2026. The schemas are a supported subset rather than copies of Twilio's complete specification. Synthetic values are generated locally; no captured customer traffic is used.

- [Call resource: create, fetch, update, callback subscriptions and parameters](https://www.twilio.com/docs/voice/api/call-resource)
- [ConversationRelay WebSocket messages](https://www.twilio.com/docs/voice/conversationrelay/websocket-messages)
- [ConversationRelay TwiML and Connect action callbacks](https://www.twilio.com/docs/voice/twiml/connect/conversationrelay)
- [Webhook security and SDK signature validation](https://www.twilio.com/docs/usage/webhooks/webhooks-security)
- [ConversationRelay onboarding and signed WebSocket upgrade](https://www.twilio.com/docs/voice/conversationrelay/onboarding)
- [Official Twilio Node SDK](https://github.com/twilio/twilio-node)
