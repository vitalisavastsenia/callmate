# Synthetic dialogue fixtures

These files are offline, synthetic conversations owned by Engineer 3. Never dial
fixture numbers or use these files as live-call configuration. The common plan
comes from `@callmate/contracts/fixtures`: Alex Example requests a haircut on
20 October 2026 between 17:00 and 19:00 in Europe/Madrid, with a €30 limit and no
permission to accept an unknown price. No real personal data is included.

## Initial cases

| Local fixture ID | Expected behavior |
| --- | --- |
| `dialogue-within-plan-confirmation` | Propose the €25 offer, then record explicit business confirmation after a scripted authorized acceptance. |
| `dialogue-no-availability` | End without booking when no slot is available. |
| `dialogue-business-refusal` | End when the business refuses to speak with an AI assistant. |
| `dialogue-missing-price` | Clarify price; do not propose acceptance. |
| `dialogue-ambiguous-time` | Clarify the time; do not infer an appointment. |

These IDs are local to dialogue development. Engineer 2 owns shared scenario IDs
and simulator behavior; agree a mapping before server integration.

The additional [evaluation catalog](evaluation/scenarios.json) contains 32 named
Spanish cases with authored English translations and expected policy/outcome
results. It is a separate format from the five full conversation files; the
evaluation runner expands it using validated shared builders. See the
[evaluation guide](../../packages/dialogue/evaluation/README.md) for all cases,
methods, commands, and live-audio limitations.

## File format

Each JSON file contains:

- `formatVersion`: fixture format version, currently `1`; independent of the app
  protocol version.
- `id` and `description`: stable local identifier and English explanation.
- `messages`: complete `TranscriptMessage` objects in chronological order.
  Business utterances are final with `not_applicable` playback. Scripted assistant
  speech is explicitly marked `played`; translations start as `null`.
- `turns`: a finalized business `triggerMessageId`, the controller-supplied
  `bookingState` and `activeOffer`, expected `candidate`, and expected
  `translationEn`. Turn versions are assigned consecutively by the loader.
- `expectedOutcome`: a shared `Outcome` value. `pending` means the fixture stops
  at clarification, not that the telephone call has ended.

`packages/dialogue/test/support/conversations.mjs` validates shared shapes and
references. Each turn receives only messages up to its trigger. Expected outputs
are authored test expectations, not actual model or policy execution results.
The confirmed case assumes the controller authorized the scripted acceptance;
the fixture itself neither grants authority nor creates a playback permit.

The loader also validates the expected outcome as a simulator snapshot with the
full transcript. UUIDs and times are fixed. Absolute appointment times include
an IANA zone and matching instant; unknown prices and duration must remain `null`.

## Running checks

After root dependency installation, from the repository root:

```sh
npm run build --workspace @callmate/contracts
npm --prefix packages/dialogue run typecheck
npm --prefix packages/dialogue test
npm --prefix packages/dialogue run evaluate
```

The initial conversations are replayed through the real `DialoguePort`
implementation with scripted model proposals and a fixture-only identity lookup.
They are not the full acceptance suite or a live-model quality evaluation.
Package tests also cover approval expiry/rejection, changed offers, policy
decisions, and disconnect uncertainty. Dialogue cancellation, deadlines, and late
provider responses are tested at the port boundary, including providers that ignore
abort. Spanish telephone quality and fluent-speaker evaluation remain outstanding.
