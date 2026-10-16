import assert from "node:assert/strict";
import test from "node:test";
import { getEventListeners } from "node:events";
import { buildDialogueInput } from "./support/builders.mjs";
import { FakeModel } from "./support/fake-model.mjs";

test("fake model returns isolated scripted values, including malformed model output", async () => {
  const input = buildDialogueInput();
  const value = { candidate: { action: "invalid_model_action" } };
  const model = new FakeModel([{ kind: "response", value }, { kind: "response", value: "not JSON" }]);
  value.candidate.action = "changed outside the fake";
  assert.deepEqual(await model.generate(input, new AbortController().signal), {
    candidate: { action: "invalid_model_action" },
  });
  assert.equal(await model.generate(input, new AbortController().signal), "not JSON");
  await assert.rejects(model.generate(input, new AbortController().signal), /script exhausted/);
  assert.equal(model.remaining, 0);
});

test("fake model records isolated input copies", async () => {
  const input = buildDialogueInput();
  const original = structuredClone(input);
  const model = new FakeModel([{ kind: "response", value: null }]);
  await model.generate(input, new AbortController().signal);
  input.messages[0].originalText = "mutated input";
  assert.deepEqual(model.requests[0], original);
  const requests = model.requests;
  requests[0].messages[0].originalText = "mutated log";
  assert.deepEqual(model.requests[0], original);
});

test("fake model propagates scripted failures and advances to the next step", async () => {
  const failure = new Error("Synthetic provider failure");
  const model = new FakeModel([{ kind: "error", error: failure }, { kind: "response", value: {} }]);
  await assert.rejects(model.generate(buildDialogueInput(), new AbortController().signal), (error) => error === failure);
  assert.deepEqual(await model.generate(buildDialogueInput(), new AbortController().signal), {});
});

test("pre-aborted requests do not consume the script or enter the request log", async () => {
  const model = new FakeModel([{ kind: "response", value: {} }]);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(model.generate(buildDialogueInput(), controller.signal), { name: "AbortError" });
  assert.equal(model.remaining, 1);
  assert.deepEqual(model.requests, []);
});

test("pending requests are released explicitly, in request order", async () => {
  const model = new FakeModel([{ kind: "pending", value: "first" }, { kind: "pending", value: "second" }]);
  const first = model.generate(buildDialogueInput(), new AbortController().signal);
  const second = model.generate(buildDialogueInput(), new AbortController().signal);
  assert.equal(model.pendingCount, 2);
  assert.equal(model.releaseNext(), true);
  assert.equal(await first, "first");
  assert.equal(model.pendingCount, 1);
  assert.equal(model.releaseNext(), true);
  assert.equal(await second, "second");
  assert.equal(model.releaseNext(), false);
});

test("cancellation removes obsolete pending replies and preserves other requests", async () => {
  const model = new FakeModel([{ kind: "pending", value: "obsolete acceptance" }, { kind: "pending", value: "current reply" }]);
  const controller = new AbortController();
  const obsolete = model.generate(buildDialogueInput(), controller.signal);
  const current = model.generate(buildDialogueInput(), new AbortController().signal);
  const rejected = assert.rejects(obsolete, { name: "AbortError" });
  controller.abort();
  await rejected;
  assert.equal(model.pendingCount, 1);
  assert.equal(model.releaseNext(), true);
  assert.equal(await current, "current reply");
  assert.equal(model.releaseNext(), false);
  assert.equal(model.pendingCount, 0);
});

test("abort reasons propagate and completed replies have no remaining abort listener", async () => {
  const model = new FakeModel([{ kind: "pending", value: {} }, { kind: "pending", value: "completed" }]);
  const cancelled = new AbortController();
  const pending = model.generate(buildDialogueInput(), cancelled.signal);
  assert.equal(getEventListeners(cancelled.signal, "abort").length, 1);
  const reason = new Error("Synthetic timeout");
  const rejection = assert.rejects(pending, (error) => error === reason);
  cancelled.abort(reason);
  await rejection;
  assert.equal(getEventListeners(cancelled.signal, "abort").length, 0);
  const completed = new AbortController();
  const output = model.generate(buildDialogueInput(), completed.signal);
  model.releaseNext();
  assert.equal(await output, "completed");
  assert.equal(getEventListeners(completed.signal, "abort").length, 0);
  completed.abort();
  assert.equal(model.pendingCount, 0);
  assert.equal(model.releaseNext(), false);
});

test("fake model rejects unsupported steps instead of inventing a response", () => {
  assert.throws(() => new FakeModel([{ kind: "unknown" }]), /Unsupported/);
  assert.throws(() => new FakeModel([{ kind: "error", error: "not an Error" }]), /Unsupported/);
});
