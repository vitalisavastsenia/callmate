# CallMate technology stack and implementation plan

Status: proposed application stack; the [shared contracts](interfaces.md) package is implemented and its development dependencies are installed. Application/provider integrations are not yet built. Updated and provider documentation checked: 2026-10-15.

## 1. Recommendation

Use **React + TypeScript for a local browser UI, Node.js + Fastify for the local backend, SQLite for local storage, Twilio Programmable Voice + ConversationRelay for calls and speech, and a text LLM API for conversation planning**. A secure tunnel makes the callback listener reachable while the computer is running.

This keeps application hosting and storage on the user's computer. Required external services are Twilio, an LLM provider, and a tunnel provider. No AWS/Azure account, separate speech-provider account, managed database, or container platform is required. Twilio still uses its selected downstream speech providers; it is not an offline system.

## 2. Stack

| Layer | Choice | Reason / boundary |
| --- | --- | --- |
| UI | React, TypeScript, Vite | A small local application does not need server rendering. Build static assets and serve them from the local API process. |
| Styling and forms | Tailwind CSS, accessible components, React Hook Form + Zod | Clear form validation, review cards, live status, and approval controls. Keep the initial UI small. |
| Backend | Current supported Node.js LTS, TypeScript, Fastify, `@fastify/websocket` | HTTP callbacks, persistent WebSocket sessions, local API, and call controller in one process. |
| Browser updates | Server-sent events, with normal HTTP for user actions | Stream statuses/text without putting credentials or Twilio sessions in the browser. Reconnect using a local event cursor. |
| Storage | SQLite via `better-sqlite3`; versioned SQL migrations | One user and one active call need no database server. Store runtime data outside the repository. |
| Telephony | Official `twilio` Node SDK and Programmable Voice Calls API | Outbound dialing, permitted caller ID, status events, hangup, and maximum call duration. |
| Speech | Twilio ConversationRelay | Managed recognition, speech synthesis, and interruption handling, connected to the local app by WSS. |
| Conversation | OpenAI Responses API with strict structured output; Zod validation | Extract offers and propose actions. Application code owns permissions and booking state. Provider can later be replaced through a small adapter. |
| Initial text model | Configurable `gpt-6-luna` candidate | A starting point for the integration spike, not a claim of proven Spanish telephone quality. Pin a supported model/version after evaluation and track usage. |
| Public callbacks | ngrok HTTPS/WSS tunnel to the dedicated callback port | No application deployment required. Confirm the chosen plan supports the needed connection duration and URL behavior. |
| Tests | Vitest, Fastify injection, mocked Twilio/LLM events, Playwright | Validate policy and lifecycle deterministically before spending money on calls. |
| Local diagnostics | Structured, redacted logs and a small status panel | Debug failures without uploading transcripts to an analytics service. |

The shared contracts' package versions and checks are recorded in their manifest, lockfile, and the repository README. Application package versions and start commands will be documented when those components are implemented.

For the LLM integration, [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs) supports schema-constrained responses; semantic and authorization checks still belong in the app. The [GPT-6 Luna model page](https://developers.openai.com/api/docs/models/gpt-6-luna) is the current model reference. Review [OpenAI data controls](https://developers.openai.com/api/docs/guides/your-data) for the actual account configuration and retention limits before real conversations.

## 3. Which Twilio services to use

| Twilio service | Decision | Role |
| --- | --- | --- |
| Programmable Voice | Required | Make and control the actual phone call. ConversationRelay alone does not dial the business. |
| ConversationRelay | Recommended | Turn speech into text and approved reply text into speech, avoiding a custom audio pipeline. |
| Phone number / caller ID | Required configuration | Use a permitted voice-capable origin number. Availability and verification must be checked for Spain and the account. |
| Media Streams | Alternative, not the default | Useful for a raw-audio/realtime-model experiment later; adds codec, playback, and interruption work. Its lower stream price is not the complete speech-stack cost. |
| Studio | Not needed initially | The local state machine already controls this single workflow. |
| Functions/Assets | Not the persistent dialogue backend | Optional for small TwiML/fallback handlers later; the design still requires a persistent WSS app endpoint. |
| Voice JavaScript SDK / conferences | Later | Needed if the user should listen or join through the browser. Live text does not require them. |
| Recording / Conversation Intelligence | Disabled initially | No recording or paid analytics is needed to book a personal appointment. |
| SMS / WhatsApp | Later | Not required for calling a business or showing the result locally. |

The [ConversationRelay TwiML reference](https://www.twilio.com/docs/voice/twiml/connect/conversationrelay) exposes language, recognition, synthesis, and interruption settings. Start with Spanish explicitly configured; avoid automatic language switching until the basic call succeeds.

Prefer Twilio-managed Deepgram recognition and an ElevenLabs Spanish-capable voice, selected from Twilio's supported inventory and verified with a test call. Neither needs a separate application integration in this design. Do not hardcode a guessed voice ID or assume every model/voice combination supports Spanish. See [Twilio voice configuration](https://www.twilio.com/docs/voice/conversationrelay/voice-configuration).

ConversationRelay's protocol supports sending keypad digits. Keep IVR navigation optional until the direct human-answering use case works. The [Media Streams overview](https://www.twilio.com/docs/voice/media-streams) describes the alternative's different capabilities and limits.

## 4. Twilio setup and personal operation

Before implementation testing:

1. Create/use the user's Twilio account and enable ConversationRelay under the applicable AI/ML terms. The [onboarding guide](https://www.twilio.com/docs/voice/conversationrelay/onboarding) describes its setup.
2. Confirm the account can place real outbound calls to Spain; trial restrictions may limit destinations or add trial prompts. An arbitrary barbershop should not be assumed callable from a trial account.
3. Select a permitted caller ID and confirm any number-verification or local-document requirements. [Spain voice guidelines](https://www.twilio.com/en-us/guidelines/es/voice) currently specify a Twilio number for domestic calling and list origin restrictions. Do not assume a verified personal mobile number is interchangeable with a compliant Spanish Twilio origin.
4. Set a callback policy for inbound calls to the Twilio number. The MVP does not answer them as an assistant. Share the user's actual callback number only with prior approval.
5. Configure the local environment, chosen Spanish voice, and public callback base URL. Keep keys out of the browser and repository.
6. Start the app and tunnel; verify readiness. Use a consenting test endpoint first, then a supervised real appointment call.
7. Keep the computer awake throughout the call. Shut down the tunnel when it is not needed.

## 5. Cost model

The [Twilio Spain pricing page](https://www.twilio.com/en-us/voice/pricing/es), checked on 2026-10-15, lists ConversationRelay at **$0.07/min**, Spanish local outbound calls at **$0.0178/min**, mobile calls from EEA at **$0.0486/min**, other listed Spanish mobile calls at **$0.18/min**, and local number rental at **$5.50/month**. Actual applicable rates depend on destination and origin; confirm them before dialing.

```text
Monthly cost ≈ number rental
             + outbound billed minutes × applicable destination/origin rate
             + ConversationRelay billed minutes × relay rate
             + LLM usage
             + any tunnel plan, taxes, and optional features
```

Illustration: twenty four-minute local-number calls, assuming 80 billed minutes for each service, cost about **$12.52/month before LLM usage, taxes, and any tunnel charges**: $5.50 + 80 × ($0.0178 + $0.07). This is an example, not an account quote or a guaranteed bill. Do not apply the landline rate to mobile/special-service destinations; reconcile provider usage and rounding separately.

For personal use, reducing setup and maintenance is more valuable initially than optimizing a few cents per minute. Implement a maximum duration per call, one-call concurrency, destination restrictions, and a daily estimated spending allowance. Keep the allowance separate from the user's haircut budget. Avoid automatic retries and optional recording/analytics charges.

## 6. Alternatives and tradeoffs

| Option | Benefit | Cost / reason to defer |
| --- | --- | --- |
| ConversationRelay + text LLM | Minimal custom speech infrastructure; inspect text before speaking. | Relay usage charge; selected speech providers process audio; internet required. Recommended first. |
| Twilio Media Streams + realtime speech model | More direct speech interaction and audio control. | Implement the audio bridge and validate booking authority carefully; measure total cost and latency rather than assuming cheaper. |
| ConversationRelay + local LLM through Ollama | Can remove text-LLM API usage and keep model inference local. | Requires suitable hardware and separate Spanish quality/latency evaluation. Twilio speech still remains external. |
| Small personal server later | Calls can work while the laptop sleeps. | Hosting and authentication become additional responsibilities. Not needed to validate the core personal workflow. |

Do not add Redis, Kubernetes, a hosted Postgres database, an agent framework, or a multi-user account system to the initial implementation. A typed controller and a few provider adapters are sufficient for the described scope.

## 7. Implementation milestones

| Stage | Deliverable | Exit condition |
| --- | --- | --- |
| 1. Local UI and simulator | Request/review/live/result screens, SQLite, state machine, and simulated Spanish dialogue. | Booking rules, timezone handling, approval expiry, and duplicate Start are verified without dialing. |
| 2. Twilio connectivity spike | Outbound call to a consenting test number, signed callbacks, WSS ConversationRelay, Spanish greeting, and Stop. | Voice compatibility, latency, duration limit, and safe relay termination measured; secrets remain local. |
| 3. Controlled conversation | LLM candidate actions, policy checks, Spanish templates, interruption handling, and English text. | Scripted out-of-policy offers never become spoken acceptance; partial/late events cannot bypass checks. |
| 4. Booking result | Explicit business confirmation, uncertain outcomes, history, `.ics`, retention, and cost display. | Failure, restart, timeout, and ambiguous-confirmation scenarios behave as specified. |
| 5. Supervised personal pilot | A few real barbershop calls initiated by the user. | Review actual outcomes, recognition mistakes, response delays, and bills before expanding scope. |

Keep ordinary development tests offline. Paid/provider tests and real calls are deliberate separate actions. No fixed delivery dates or implementation estimates are asserted before the connectivity spike.
