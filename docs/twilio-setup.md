# Twilio account and configuration runbook

Owner: Engineer 2, with the account owner completing identity verification, billing, purchases, and acceptance of terms. Provider documentation checked: 2026-10-15.

This is the detailed setup for delivery-plan tasks **BE-00** and **BE-03**. Complete account setup before the live connectivity spike; it can run alongside local simulator development. The baseline is Programmable Voice + ConversationRelay. This runbook contains instructions only; no account, purchase, credential, tunnel, or call has been created by adding it.

## 1. Create the account

1. Open [Twilio signup](https://www.twilio.com/try-twilio) and create the account under the personal user's control.
2. Verify the email address and personal phone number, then answer the project/use-case questions accurately: a personal outbound appointment assistant using Voice.
3. Open the [Twilio Console](https://console.twilio.com/) and select the account that will own CallMate's number, credentials, permissions, and charges. Keep all later configuration in this same account.
4. Enable account two-factor authentication. If Engineer 2 needs Console access, use a separate invited identity with the permissions needed for setup rather than sharing the owner's login.

Expected result: the owner can sign in, identify the selected account, and open Voice configuration. See [Twilio account onboarding](https://www.twilio.com/docs/usage/tutorials/how-to-use-your-free-trial-account).

## 2. Decide trial versus paid testing

The current [Voice trial documentation](https://www.twilio.com/docs/usage/trials/try-out-voice) permits calls only to verified numbers and within the account's country. It also lists `<ConversationRelay>` and `<Stream>` as blocked trial features. **Plan for a paid account for the CallMate voice integration; a successful basic trial call does not prove ConversationRelay readiness.** A Poland-based trial must not be assumed able to call Spain.

1. For a basic trial demonstration, open **Communications → Voice → Overview → Try out Voice**, add/verify your own recipient number, and follow the guided call flow.
2. Before ConversationRelay testing, the owner selects **Upgrade** in the Console and completes the displayed billing and account-verification steps. Confirm the account is upgraded and has usable balance/billing.
3. Review number rental, outbound destination rates, and ConversationRelay usage in [Twilio Spain pricing](https://www.twilio.com/en-us/voice/pricing/es). Set the intended personal spending allowance and review available billing notifications. Alerts and automatic recharge are not a hard application spend cap.

Only place a guided demonstration call deliberately to a consenting recipient. Trial entitlements and restrictions must be checked against the actual account if its Console differs from the documented flow.

## 3. Obtain a suitable calling number

1. Read the [Spain Voice guidelines](https://www.twilio.com/en-us/guidelines/es/voice) before selecting the origin. They specify a Twilio number for domestic calling and restrictions on origin number types; do not assume verifying a personal mobile number makes it suitable as CallMate's caller ID.
2. In the new Console, open **Communications → Numbers & senders → Phone Numbers → Set up a new phone number**. In the legacy Console, use **Phone Numbers → Manage → Buy a number**.
3. Search for a number suitable for calling Spanish businesses, with **Voice** capability. SMS is not required. Confirm number availability, monthly charge, and origin/use-case eligibility before the owner purchases it. See [number setup](https://www.twilio.com/docs/numbers-and-senders/add-numbers-and-senders).
4. Complete any regulatory bundle/address requirements shown for the chosen number. For Spanish numbers, review the requirements for **Individuals**, including identity, fiscal identification, and address evidence for the selected number type. Submit documents through Twilio; never put them in this repository. See [Spain number requirements](https://www.twilio.com/en-us/guidelines/es/regulatory) and [bundle setup](https://www.twilio.com/docs/phone-numbers/regulatory/getting-started).
5. Confirm provisioning/compliance is complete and the number is usable. Keep its E.164 value in private configuration as `TWILIO_FROM_NUMBER`.

The Spain requirements distinguish personal, customer-care, and commercial uses. The current regulatory page also lists an upcoming 2026-10-17 restriction for commercial outbound calls. Do not automatically classify a personal appointment request as telemarketing or choose a commercial-only number; resolve applicability with Twilio when selecting the number.

Expected result: one provisioned, eligible Voice origin for the actual use case. If required documents or suitable numbers are unavailable, record that blocker and continue simulator work rather than substituting a guessed caller ID.

## 4. Enable outbound calling to Spain

1. As an account Owner or Administrator, open **Voice → Settings → Geo permissions**; the new Console may place Voice under **Communications**.
2. Find **Spain** and enable the required **Low-Risk** destination ranges. Keep high-risk ranges disabled for this MVP and disable other destinations that the account does not need.
3. Save, then use **Phone Number Permission Check** on that page for the exact consenting test destination.
4. If using a subaccount, check permissions in that subaccount and any inheritance from its parent.

Expected result: the selected destination is allowed at the Twilio account level. The backend must still enforce the approved destination and its own restrictions. See [Voice geographic permissions](https://www.twilio.com/docs/sip-trunking/voice-dialing-geographic-permissions).

## 5. Enable ConversationRelay

1. In the new Console, open **Communications → Voice → Settings → Privacy & Security**. In the legacy Console, open **Voice → Settings → General**.
2. The account owner reads and accepts the **Predictive and Generative AI/ML Features Addendum**, then saves the setting.
3. Record that the setting is enabled in the selected account. Do not enable recording or Conversation Intelligence as part of this step; those are outside the CallMate baseline.

Expected result: the account is configured to use ConversationRelay, subject to paid-account eligibility and the live connectivity test. The official [ConversationRelay onboarding guide](https://www.twilio.com/docs/voice/conversationrelay/onboarding) provides both Console layouts.

## 6. Prepare backend credentials

1. Find the selected account's **Account SID** and **Auth Token** on its Console account page or credentials section. Store them privately. Use the live account's credentials for real integration; test credentials do not establish a real phone call.
2. New Console: **Settings → Account settings → API keys & auth tokens → Create API key**. Legacy: **Admin → Account management → Keys & credentials → API keys & tokens**.
3. Name the key `callmate-local-dev`. Choose a region consistent with the chosen Voice setup and REST endpoint. For the initial spike, a **Standard** key avoids account-administration access; it still has broad resource permissions. A Restricted key can replace it after the required operations are verified.
4. Store the key SID and secret securely when shown. The application should use API-key credentials for supported REST operations; **webhook signature validation still requires the account Auth Token**, not the API-key secret. See [API-key creation](https://www.twilio.com/docs/iam/api-keys/keys-in-console), [API authentication](https://www.twilio.com/docs/usage/requests-to-twilio), and [webhook security](https://www.twilio.com/docs/usage/webhooks/webhooks-security).

The server scaffold implements its own container/runtime configuration; Engineer 2 must add provider configuration and explicit Compose injection with the adapters. The following provider names are proposed and are not yet consumed or forwarded by the scaffold:

| Name | Value/source | Where used |
| --- | --- | --- |
| `TWILIO_ACCOUNT_SID` | Selected live account SID | REST account and callback ownership checks. |
| `TWILIO_API_KEY_SID` | API key SID | REST authentication username. |
| `TWILIO_API_KEY_SECRET` | Secret displayed at key creation | REST authentication secret. |
| `TWILIO_AUTH_TOKEN` | Selected account Auth Token | HTTP/WSS signature validation. |
| `TWILIO_FROM_NUMBER` | Provisioned E.164 calling number | Outbound `From`. |
| `TWILIO_PUBLIC_BASE_URL` | Current HTTPS tunnel origin | Public callback URLs and signature validation. |

Keep actual values in ignored local environment configuration or a local secret store. Commit only placeholders in a future `.env.example`. No provider credentials belong in browser configuration, shared fixtures, screenshots, or setup notes.

## 7. Connect the local callback listener

The backend scaffold starts with `docker compose up --build -d --wait zeus-llama`; see [Docker development](docker-development.md). Its callback listener currently rejects all routes. This phase additionally requires the Twilio HTTP/WSS adapters and signature/session validation.

1. Implement the provider routes on the dedicated callback listener, published by Docker on host `127.0.0.1:3001`. Keep the UI/private API on its separate listener. Inside the container both listeners bind `0.0.0.0`; Compose limits host exposure to loopback.
2. Set up an ngrok account/local agent using the official [local tunnel instructions](https://ngrok.com/docs/start). Forward only the callback listener and confirm HTTPS and WebSocket support for the selected setup.
3. Store the actual public HTTPS origin in `TWILIO_PUBLIC_BASE_URL`. For illustration only, `https://callmate-tunnel.example` gives these routes:

| Public route | Configuration location | Purpose |
| --- | --- | --- |
| `POST https://callmate-tunnel.example/twilio/voice` | Outbound Calls API `url`, method `POST` | Return the call's ConversationRelay TwiML. |
| `POST https://callmate-tunnel.example/twilio/status` | Outbound Calls API `statusCallback`, method `POST` | Receive call lifecycle notifications. |
| `wss://callmate-tunnel.example/twilio/relay` | Returned `<ConversationRelay>` TwiML `url` | Bidirectional text/control session. |
| `POST https://callmate-tunnel.example/twilio/relay-ended` | Returned `<Connect>` TwiML `action`, method `POST` | Handle relay ending and return a safe hangup/fallback. |

4. Validate signed HTTP requests and the initial WSS handshake with the SDK, account Auth Token, correct external URL, and appropriate request representation. Reject unexpected account/call/session IDs and unsigned requests before accepting a session. See [signature validation](https://www.twilio.com/docs/usage/webhooks/webhooks-security).
5. When the public URL changes, update local configuration before the next call. Never expose `/api/v1`, the UI, history, or settings through this tunnel.

The `.example` host is a placeholder, not a working callback. Do not paste it into the Console expecting a call to connect.

## 8. Distinguish Console settings from per-call settings

For this outbound app, Engineer 2 supplies callback URLs when creating each call using the [Calls API](https://www.twilio.com/docs/voice/api/call-resource). Changing the purchased number's **incoming call** webhook alone does not configure those outbound calls.

| Setting | Where Engineer 2 configures it |
| --- | --- |
| Approved business/test destination | Calls API `to`; comes from the server-approved plan. |
| Provisioned origin | Calls API `from`; comes from private backend configuration. |
| Voice/status URLs | Calls API request, using the routes above. Request lifecycle events `initiated`, `ringing`, `answered`, and `completed`. |
| Duration limit | Calls API `timeLimit`, bounded by the approved plan and the 600-second MVP cap; backend also enforces its local deadline. |
| Spanish recognition and synthesis | Returned ConversationRelay TwiML, explicitly selecting `es-ES` and a currently supported provider/model/voice combination. Use the [voice configuration guide](https://www.twilio.com/docs/voice/conversationrelay/voice-configuration); do not guess a voice ID. |
| Introduction and reply text | Application response/policy layer; disclose the AI assistant and send only authorized Spanish replies. |
| Recording/analytics | Leave disabled in application requests and optional account integrations. |
| Inbound calls to the origin number | Number's incoming-Voice configuration: deliberately reject/end or provide a clear non-assistant response. No forwarding or automatic appointment handling in the MVP. |

A TwiML App is an optional alternative to direct per-call Voice URLs. If using one, create it at **Builder tools → TwiML host & config → TwiML apps** (legacy: **Voice → Manage → TwiML Apps**), set its Voice URL/method, and deliberately use its Application SID in the call creation flow. The baseline above uses direct URLs; do not configure an unused TwiML App and assume it controls the call. See [ConversationRelay onboarding](https://www.twilio.com/docs/voice/conversationrelay/onboarding).

## 9. Verify the first real connection

After the backend has the listed routes and signature validation, Engineer 2 runs one deliberate call to the owner's or another consenting test number. This is a paid/provider test, separate from offline checks.

1. Confirm account, Voice origin, Spain permissions, live configuration, callback tunnel, and AI/ML terms readiness.
2. Start a single short attempt. Verify the right phone rings and the configured caller ID is presented.
3. Hear the Spanish AI introduction, say a Spanish reply, and confirm the signed WSS session delivers its recognized text to the local server.
4. Send a controlled Spanish reply; verify playback and interruption behavior.
5. Press Stop and verify provider termination. Separately verify duration caps and safe relay-disconnect behavior using deliberate test cases.
6. Inspect Console Voice logs/call details and Debugger for callback, authentication, and TwiML errors. Confirm no recording was created and review available charges, including relay usage separately from phone connectivity.
7. Keep an English record of pass/fail outcomes and remaining blockers. Keep test phone numbers, credential values, and conversation bodies outside Git.

This proves transport and speech connectivity. The booking PoC still requires the shared UI, controller, and Engineer 3's conversation/policy module to work together.

## 10. Setup completion and common blockers

| Check/blocker | Required result or next action |
| --- | --- |
| Account setup | Email/phone verified; selected account and owner known; paid eligibility for ConversationRelay confirmed. |
| Number/compliance | Eligible Voice number provisioned; required bundle/address approvals complete. |
| Geographic permissions | Exact test destination passes the permission check; account/subaccount settings match. |
| Credentials | Local key/account/region consistent; account Auth Token available for validation; no values published. |
| Relay terms | AI/ML terms accepted in the same account used by the call. |
| No ringing | Check trial/paid status, balance, destination permissions, caller-ID eligibility, and provider error details before retrying. |
| Rings but relay fails | Check paid feature access, AI/ML setting, Voice TwiML, public URL/WSS reachability, signatures, and supported voice settings. |
| Signature failure | Check account Auth Token, exact public URL, method/body representation, and tunnel URL changes; keep validation enabled. |
| No backend/tunnel yet | Account setup can be complete, but mark connectivity unverified and continue BE-01/BE-03 implementation. |
| Handoff | Engineer 2 records setup/check results and startup instructions. Share configuration names and readiness, never secrets. |
