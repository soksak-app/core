import assert from "node:assert/strict";
import test from "node:test";

import { runReferenceSteps, compareAppKitReference } from "./ime-reference-steps.mjs";

test("the next AppKit reference key waits for the prior presentation checkpoint", { timeout: 5000 }, async () => {
  let releasePresentation;
  let reachedPresentation;
  let reachedSecondKey;
  const presentationGate = new Promise((resolve) => { releasePresentation = resolve; });
  const presentationStarted = new Promise((resolve) => { reachedPresentation = resolve; });
  const secondKeyStarted = new Promise((resolve) => { reachedSecondKey = resolve; });
  const calls = [];

  const run = runReferenceSteps(["k", "k"], {
    async press(key, index) {
      calls.push(`press:${index}`);
      if (index === 1) reachedSecondKey();
    },
    async read(key, index) {
      calls.push(`read:${index}`);
      return { key, index };
    },
    async verify(state, key, index) {
      assert.deepEqual(state, { key, index });
      calls.push(`verify:${index}`);
    },
    async presented(key, index) {
      calls.push(`presented:${index}`);
      if (index === 0) {
        reachedPresentation();
        await presentationGate;
      }
    },
  });

  const first = await Promise.race([
    presentationStarted.then(() => "presentation"),
    secondKeyStarted.then(() => "second-key"),
    run.then(() => "finished"),
  ]);
  assert.equal(first, "presentation", "the second key started before the first key's presentation checkpoint");
  assert.deepEqual(calls, ["press:0", "read:0", "verify:0", "presented:0"]);

  releasePresentation();
  await run;
  assert.deepEqual(calls, ["press:0", "read:0", "verify:0", "presented:0",
    "press:1", "read:1", "verify:1", "presented:1"]);
});

function referenceSession({ focused = true } = {}) {
  let pending = false;
  let document = "";
  const checkpoints = [];
  return {
    window: "reference-window",
    checkpoints,
    cleanup() {},
    async press() {
      assert.equal(pending, false, "the next key arrived before the prior reference presentation");
      document += "ㅏ";
      pending = true;
    },
    async presented() { pending = false; checkpoints.push(document); },
    async request(name, params) {
      assert.equal(name, "diagnostics.input.reference");
      if (params.action === "wait") assert.equal(document, params.document);
      return { open: true, focused, document, marked: null, selected: { location: document.length, length: 0 } };
    },
  };
}

test("lifecycle reference input finishes each presentation before the next key", { timeout: 5000 }, async () => {
  const session = referenceSession();
  await compareAppKitReference(session, ["k", "k"], "ㅏㅏ", ["ㅏ", "ㅏㅏ"]);
  assert.deepEqual(session.checkpoints, ["ㅏ", "ㅏㅏ"]);
});

test("lifecycle reference input rejects lost reference focus before sending another key", { timeout: 5000 }, async () => {
  const session = referenceSession({ focused: false });
  await assert.rejects(compareAppKitReference(session, ["k"], "ㅏ", ["ㅏ"]), /reference.*focus/);
});

test("lifecycle reference input rejects a stale intermediate document before the next key", { timeout: 5000 }, async () => {
  const session = referenceSession();
  const request = session.request;
  session.request = async (name, params) => {
    const state = await request(name, params);
    return params.action === "read" ? { ...state, document: "" } : state;
  };
  await assert.rejects(compareAppKitReference(session, ["k"], "ㅏ", ["ㅏ"]),
    /reference input 1.*unexpected AppKit document/);
});
