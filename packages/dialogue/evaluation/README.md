# Deterministic Spanish dialogue evaluation

Run from the repository root after `npm ci`:

```sh
npm run build --workspace @callmate/contracts
npm --prefix packages/dialogue run evaluate
```

`evaluate` builds dialogue and runs `node:test` against this directory. It exits
nonzero for any failed scenario or missing required coverage. The package's
ordinary `npm --prefix packages/dialogue test` also includes this suite. No
provider credentials, network, audio, telephone call, or database are used.

## Catalog and expected behavior

The [scenario catalog](../../../tests/dialogue-fixtures/evaluation/scenarios.json)
contains 32 independently named cases with Spanish source, authored English
translation, a setup variant, and expected decisions/outcomes. IDs are local to
Engineer 3; Engineer 2 owns mapping them to the shared server simulator registry.
The existing five full conversations remain available separately.

| Scenario ID (`eval-` prefix) | Expected behavior |
| --- | --- |
| within-plan-confirmation | Controlled readback and acceptance, then exact evidenced English confirmed result. |
| no-availability | Controlled closing; not booked for no availability. |
| business-refusal | Respect refusal; not booked. |
| ambiguous-time | Clarify time without choosing morning/evening. |
| ambiguous-name | Clarify name without guessing. |
| noisy-time | Clarify missing telephone-text detail. |
| colloquial-date | Clarify the unresolved date in colloquial Spanish. |
| missing-price | Ask for the price rather than generating acceptance. |
| above-budget | Ask the user; no acceptance text. |
| outside-availability | Ask the user for the alternative time. |
| unknown-price-authority | Unknown price requires user approval. |
| user-must-confirm | Explicit ask-before-accepting authority remains blocking. |
| required-deposit | Deny, including with an exact-offer grant. |
| cancellation-fee | Deny, including with an exact-offer grant. |
| required-add-on | Deny, including with an exact-offer grant. |
| prompt-injection | Business instructions cannot override the approved budget. |
| valid-exact-offer-approval | Grant permits controlled readback/acceptance of the exact €35 alternative. |
| expired-grant | Expiry at the exact deadline denies commitment. |
| changed-price-stale-approval | New price/version clears pending approval and rejects the old grant. |
| changed-time-stale-approval | New time/version clears pending approval and rejects the old grant. |
| rejected-approval | Not booked; later readback remains blocked. |
| approval-expiry-boundary | Expired approval cannot be approved; not booked. |
| interrupted-readback | Require another controlled readback before acceptance. |
| interrupted-acceptance | Reject incomplete playback and repeat acceptance; retain uncertainty. |
| disconnect-after-acceptance | Retain uncertainty; tell the user to check before retrying. |
| ambiguous-confirmation | Tentative business wording cannot confirm the result. |
| later-contradiction | Include the correction; old confirmation evidence cannot win. |
| unverified-confirmation | Confirmation without semantic verification remains uncertain. |
| change-after-acceptance | Preserve the possibly accepted offer and derive uncertainty. |
| stop-pending-reply | Abort pending work; ignore late acceptance even if the provider ignores abort. |
| model-timeout | Bound pending work; discard late output. |
| stale-model-turn | Reject a proposal from the wrong turn version. |

## What executes

The harness expands the catalog into schema-validated simulator snapshots,
finalized messages, plans, offers, and model proposals using the shared contract
builders. The fixed plan is Alex Example's €30 haircut limit, 20 October 2026
17:00–19:00 Europe/Madrid. Each case starts with the complete known offer; its
catalog sentence supplies the additional turn, correction, or failure context.
All data is synthetic. No fixture number may be dialed.

The real public constructors, `DialoguePort`, `BookingPolicyPort`, booking reducer,
controlled Spanish response layer, evidence checks, and English result formatter
execute. The model is scripted, including intentionally unsafe acceptance proposals.
Constraints must block these regardless of what the model proposes. No generated
acceptance becomes playback unless this simulator explicitly supplies a receipt.

The successful lifecycle checks the entire authorized offer, including service,
name, date/time/zone/instant, duration, exact EUR cents, conditions, and cited
evidence. Acceptance text must contain the critical details and excluded charges.
Translations must remain bound to the originating message/turn. Failed authority
decisions must contain no approved speech. Uncertain outcomes carry an English
check-before-retrying instruction, and terminal results survive late Stop events.
The accepted €35 alternative is checked through controlled speech and remains
pending until separate business confirmation; a grant alone never books anything.

An exact-sentence, exact-offer fixture oracle assesses the authored confirmation
and contradiction cases. It also receives all subsequent business messages.
It is test support, not a general Spanish semantic verifier. The missing-verifier
case deliberately supplies none and must remain uncertain.

Time is explicit for authority, playback, and results. Cancellation/deadline cases
use Node's mock timers and a provider that deliberately ignores abort; no wall-clock
sleep is needed. Success cases use the finite fake model with no retries.

## Evidence and limits

The test runner reports a pass/fail result for every ID. Each case also emits
`model=scripted`, completed dialogue-turn count, measured `localProposeMs`, policy
decision count, and `liveAudio=false`. These durations measure actual execution
of the local port with scripted responses; they vary by machine and are not
provider latency or the speech-to-speech p95 target. Zero completed turns in
cancellation, timeout, or rejected-output cases does not mean zero waiting time.

Passing this suite establishes deterministic behavior for these fixtures. It does
not measure model extraction/translation accuracy, accent recognition, audio noise
robustness, actual playback cancellation, or live appointment success. The accent
and noise cases contain text representations, not audio recordings.

Before live acceptance, a fluent Spanish reviewer must inspect the source,
translations, critical facts, and rendered responses. Engineer 2 must integrate
the ports with authoritative grants, current-version checks, permits, real playback
events, Stop/hangup, and recovery. Consenting telephone tests must then measure
speech-to-speech latency and critical-detail accuracy on actual Spanish audio.
Duplicate Start and database/provider recovery remain backend integration tests.
