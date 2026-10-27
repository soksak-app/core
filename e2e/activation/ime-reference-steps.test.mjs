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
    async selectInputSource() {},
    async request(name, params) {
      if (name === "diagnostics.input.source") return { current: "com.apple.inputmethod.Korean.2SetKorean" };
      assert.equal(name, "diagnostics.input.reference");
      if (params.action === "wait" || params.action === "wait-document")
        assert.equal(document, params.document);
      return { open: true, focused, inputContextCurrent: true, document, marked: null,
        selected: { location: document.length, length: 0 } };
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
    return params.action === "wait-document" ? { ...state, document: "" } : state;
  };
  await assert.rejects(compareAppKitReference(session, ["k"], "ㅏ", ["ㅏ"]),
    /reference input 1.*unexpected AppKit document/);
});

test("reference keys wait for selected-source readiness on the newly focused client", { timeout: 5000 }, async () => {
  let finishSelection;
  let selectionStarted;
  const started = new Promise((resolve) => { selectionStarted = resolve; });
  const selection = new Promise((resolve) => { finishSelection = resolve; });
  const calls = [];
  let ready = false;
  const session = {
    window: "reference-window",
    cleanup() {},
    selectInputSource(source) {
      calls.push(`select:start:${source}`);
      selectionStarted();
      return selection.then(() => {
        ready = true;
        calls.push(`select:done:${source}`);
      });
    },
    async press(key) {
      assert.equal(ready, true, "the key started before the focused reference adopted its source");
      calls.push(`press:${key}`);
    },
    async presented() { calls.push("presented"); },
    async request(name, params) {
      if (name === "diagnostics.input.source") {
        calls.push("source:read");
        return { current: "com.apple.inputmethod.Korean.2SetKorean" };
      }
      assert.equal(name, "diagnostics.input.reference");
      if (params.action === "wait") assert.equal(ready, true);
      if (params.action === "read") calls.push("reference:read");
      else calls.push(params.action);
      return { open: true, focused: true, inputContextCurrent: ready,
        document: ready ? "ㅎ" : "", marked: null, selected: { location: ready ? 1 : 0, length: 0 } };
    },
  };

  const run = compareAppKitReference(session, ["g"], "ㅎ", ["ㅎ"]);
  await started;
  assert.deepEqual(calls, ["open", "focus", "source:read", "select:start:com.apple.inputmethod.Korean.2SetKorean"]);
  finishSelection();
  await run;
  assert.ok(calls.indexOf("select:done:com.apple.inputmethod.Korean.2SetKorean") < calls.indexOf("press:g"));
});

test("reference steps await a delayed document update while marked text remains", { timeout: 5000 }, async () => {
  let releaseDocument;
  let referenceWaitStarted;
  const waiting = new Promise((resolve) => { referenceWaitStarted = resolve; });
  const calls = [];
  let document = "";
  const state = (marked) => ({ open: true, focused: true, inputContextCurrent: true,
    document, marked, selected: { location: document.length, length: 0 } });
  const session = {
    window: "reference-window",
    cleanup() {},
    async selectInputSource() {},
    async press(key) { calls.push(`press:${key}`); },
    async presented() { calls.push("presented"); },
    async request(name, params) {
      if (name === "diagnostics.input.source") return { current: "com.apple.inputmethod.Korean.2SetKorean" };
      assert.equal(name, "diagnostics.input.reference");
      calls.push(params.action);
      if (params.action === "wait-document") {
        referenceWaitStarted();
        return new Promise((resolve) => {
          releaseDocument = () => {
            document = params.document;
            resolve(state({ location: 0, length: document.length }));
          };
        });
      }
      if (params.action === "wait") return state(null);
      return state(null);
    },
  };

  const run = compareAppKitReference(session, ["g"], "ㅎ", ["ㅎ"]);
  await waiting;
  assert.deepEqual(calls, ["open", "focus", "read", "press:g", "wait-document"]);
  releaseDocument();
  await run;
  assert.ok(calls.indexOf("wait-document") < calls.indexOf("presented"));
  assert.ok(calls.indexOf("presented") < calls.indexOf("wait"));
  assert.deepEqual(calls, ["open", "focus", "read", "press:g", "wait-document", "presented", "wait", "close"]);
});
