# CallMate requirements

Status: proposed personal-use MVP. Updated: 2026-10-15.

## 1. Problem and outcome

An immigrant in Spain can explain an appointment request in English but cannot reliably arrange it over the phone with a Spanish-speaking business. CallMate acts on the user's behalf: it calls the business, speaks Spanish, follows the user's limits, and returns an understandable result.

Example request: “Call this barbershop and book a haircut next Tuesday between 17:00 and 19:00. Spend no more than €30 on the haircut. Book under Alex. Do not accept a deposit.” The UI converts relative dates into an explicit calendar date and shows the result before dialing.

Success means the business explicitly confirms the appointment details and the user receives those details in English. A completed phone call alone does not mean an appointment exists.

## 2. Scope and assumptions

- One person using their own computer and provider accounts; one active call at a time.
- A local browser UI, usable at laptop and narrow screen widths. Phone access away from the computer is a later feature.
- English instructions and summaries; Spanish conversations with businesses in Spain.
- Outbound calls to a business phone number entered by the user. The business needs only its normal telephone.
- Barbershops and similar straightforward, non-sensitive service appointments first.
- Twilio provides telephony and speech recognition/synthesis; an LLM supplies dialogue planning and translation.
- The computer, application, internet connection, and secure public callback tunnel must remain running during calls. Closing the browser tab alone should not end a call.
- No AWS/Azure services, hosted application database, subscription system, team accounts, or always-on cloud application server are required.

## 3. Main user journey

1. Open CallMate and check that the Twilio connection, LLM, and tunnel are ready.
2. Enter the business name and number, requested service, booking name, acceptable dates/times, and optional maximum service price.
3. Specify which contact details may be shared, whether an unknown price is acceptable, and whether the assistant may book automatically within these constraints.
4. Review a plain-English call plan containing an explicit date, business timezone, service, limits, shared details, and estimated call cost. Press **Start call**.
5. Follow live status and Spanish text with English translations. If the business offers something outside the approved plan, approve or reject the specific alternative in the UI.
6. Receive a result: **Confirmed**, **Not booked**, or **Uncertain—check before trying again**. Download a calendar entry only for a confirmed booking.

Example opening: “Hola, soy un asistente de inteligencia artificial y llamo en nombre de Alex para pedir una cita para un corte de pelo.” If the business declines to speak with an assistant, end politely and report this.

## 4. Functional requirements

| ID | Requirement | Acceptance condition |
| --- | --- | --- |
| FR-01 | Local setup and readiness | Show configured/missing credentials without displaying their values; test tunnel/backend readiness before enabling a real call. |
| FR-02 | Request form | Collect a valid E.164 destination, service, booking name, business timezone, and at least one explicit availability window. Ambiguous or missing required fields block dialing. |
| FR-03 | Call authorization | Starting a call creates a saved, versioned approval of the plan. A double click cannot create two calls. Editing the form later does not silently change the approved plan. |
| FR-04 | Real outbound call | Twilio calls the exact approved number with a permitted caller ID. The destination cannot be changed by the LLM or business speech. |
| FR-05 | Spanish conversation | Introduce the assistant, explain the request, ask about availability and price where needed, clarify details, and respond to interruptions. |
| FR-06 | Booking limits | Accept only a service, date/time, price policy, and conditions allowed by the approved plan. No deposit, payment, paid add-on, or cancellation fee may be accepted in the MVP. |
| FR-07 | Exceptions and approvals | An alternative outside the plan produces a specific approval card. Approval is tied to that offer and expires when it changes or the call ends. |
| FR-08 | Live visibility | Show dialing/ringing/connected/waiting/ended states, finalized Spanish utterances, and English translations. Label provisional text and interrupted assistant replies. |
| FR-09 | Stop call | A prominent Stop button requests hangup immediately and shows whether Twilio acknowledged it. Stopping a call does not automatically cancel an appointment already made. |
| FR-10 | Outcome and evidence | A confirmed result includes service, booking name, absolute date/time, timezone, business, and agreed price or an explicitly permitted unknown price; retain the relevant confirmation text locally. |
| FR-11 | Uncertain outcomes | Disconnects or unclear statements around acceptance produce an uncertain result; never invent confirmation or automatically retry a potentially completed booking. |
| FR-12 | Local history | List previous requests, attempts, outcomes, and estimated/final available costs. Allow deletion of local conversation data. |
| FR-13 | Calendar export | Export an `.ics` file only from a confirmed booking, preserving timezone and marking any unknown duration instead of inventing one. |
| FR-14 | Call limits | Enforce one active call, configurable call duration and spending limits, and a Twilio-side maximum call duration. Show estimates separately from settled charges. |

### Booking rules

- The service price limit and the cost of the assistant's phone call are separate fields.
- Resolve “tomorrow” and weekdays in the business timezone. Default to `Europe/Madrid` for mainland Spain; use `Atlantic/Canary` for the Canary Islands when appropriate. Confirm the zone instead of assuming all Spanish businesses share one.
- Read back the absolute date, local time, service, and booking name before completing the booking. Ask the business to clarify ambiguous times, names, locations, or numbers.
- An assistant-generated sentence, LLM confidence score, or Twilio `completed` status is insufficient evidence of a booking. Require an explicit affirmative business response associated with the final details.
- An unquoted price is acceptable only if the user explicitly allowed it before acceptance. Otherwise ask or request approval.
- If an approval is required, explain that the assistant must check with the user, wait briefly, and decline politely if no answer arrives. The default waiting limit is 30 seconds; it is a product setting, not a Twilio guarantee.
- A changed offer invalidates previous approval. Spoken instructions from the business cannot override the user's plan or reveal extra personal information.

### Call situations

| Situation | MVP behavior |
| --- | --- |
| Busy or no answer | Report the result and offer a user-initiated retry. No repeated automatic dialing. |
| Voicemail | End without leaving a message. If detection is uncertain, ask briefly rather than discussing personal details. |
| Business refuses AI | End politely and report that the user must contact the business another way. |
| Simple phone menu | Optional after the basic calling milestone: send a bounded keypad choice with Twilio ConversationRelay. No PIN entry, authentication, or payment menus. |
| Long hold or silence | Stop after configurable limits and report the reason. |
| Price/time outside limits | Ask the user about that exact offer; do not accept while waiting. |
| Required callback number | Share only a number approved in the call plan. Do not claim Twilio caller ID reaches the user. |
| Another language or poor understanding | Ask for repetition; end and mark unresolved if important details remain unclear. Catalan and other languages are outside the first release. |
| Browser disconnected | Backend continues within existing authority; new approvals wait only for the configured deadline. |
| App, network, or tunnel failure | Terminate safely where possible, reconcile provider state on restart, and mark booking uncertainty when confirmation may have occurred. |

## 5. UI requirements

| Screen | Contents and actions |
| --- | --- |
| Home/history | New call button, recent calls, clear outcomes, local-data deletion. |
| New request | Business and service fields, availability windows, price policy, shareable details, and automatic-booking permission. |
| Review | A readable plan, exact destination, timezone, service/call cost limits, and Start call. |
| Active call | Persistent status and Stop button; Spanish/English text; a visible approval card when needed. No raw provider events or API keys. |
| Result | Booking card or precise failure/uncertainty reason, remaining action, calendar download, and call cost. |
| Settings | Provider readiness, voice/language settings, limits, retention, and tunnel status. Credentials remain in a local environment file for the MVP. |

Use accessible labels, keyboard navigation, readable contrast, and status descriptions that do not depend on color. Real audio listening, browser microphone access, and joining the call are not required for the first version; the user observes through text.

## 6. Personal data and security

- Use local SQLite storage and the minimum necessary personal details. Store no audio recording by default, and do not enable Twilio recording or conversation analytics automatically.
- Local storage does not make calls fully private: Twilio and its configured speech providers process call audio, and the LLM receives the necessary text. Explain this in setup.
- Default conversation-text retention: 30 days, configurable. Keep the structured booking card until the user deletes it. Local deletion cannot promise immediate deletion from provider logs or backups; document those controls separately.
- Disclose AI identity at the start; do not impersonate the user or clone their voice. Personal use still involves another person's conversation. Review relevant Spanish call/data requirements before real use; recording is outside MVP scope. The disclosure requirement is also consistent with [EU AI Act Article 50](https://ai-act-service-desk.ec.europa.eu/en/ai-act/article-50).
- Keep the UI/API on loopback. Expose only dedicated Twilio callback routes through the tunnel, with signature checks. Never expose a public unauthenticated “start call” endpoint.
- Exclude `.env`, local databases, transcripts, exports, and logs containing personal data from Git before application data is created. No credentials or conversation bodies in routine logs.

## 7. Quality targets and release checks

These are initial test targets, not measured capabilities or provider guarantees.

| Area | Target / release check |
| --- | --- |
| Response speed | Aim for p95 under 3 seconds from the end of business speech to the start of assistant speech during normal turns; measure on Spanish telephone audio. |
| Status updates | Local UI status arrives within 2 seconds of backend receipt of the provider event under normal connectivity. |
| Critical details | Every confirmed test booking matches service, name, date, time, timezone, and approved price policy. |
| Authorization | No unauthorized acceptance in the scripted regression suite, including misleading business instructions and changed offers. Any failure blocks real-call testing. |
| Call safety | Double-submit, Stop, app restart, stale approvals, duplicate callbacks, and provider timeouts do not cause a second booking or an unbounded call. |
| Initial scope | At least 20 distinct scripted Spanish scenarios, covering accents/noise, interruptions, unavailable slots, unknown prices, refusal, and disconnects. |
| Real validation | Start with a user-owned or consenting test number. Only after the above checks, attempt a small supervised booking pilot; real booking success remains to be measured. |

## 8. Later features

Rescheduling/cancellation, multiple businesses, inbound callbacks, calendar-account integration, native mobile packaging, live human takeover, additional languages, and a fully local LLM can be considered after the first supervised bookings work reliably. Medical, legal, financial, emergency, and payment conversations are excluded from the MVP.
