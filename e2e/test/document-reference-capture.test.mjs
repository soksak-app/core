// Protocol ownership only. The opaque replies below contain no raster, decoded
// identity or semantic proof; real reference acquisition must validate those.
import assert from "node:assert/strict";
import test from "node:test";
import * as documents from "../document-frame-identity.mjs";

const target = Object.freeze({ surface: "editor-fixture", document: "", requestId: 7 });
function fixture({ requestError, stopError } = {}) {
  const calls = [], cleanups = [];
  const observed = Object.freeze({ requestId: 7, directory: "/declared/native-artifacts" });
  const host = Object.freeze({ opaqueHostReply: true });
  const capture = Object.freeze({ frames: "/declared/recording", count: 1, limited: false });
  const session = {
    async record(options) {
      calls.push(["record", options]);
      return { frames: capture.frames, async stop(options) { calls.push(["stop", options]); if (stopError) throw stopError; return capture; } };
    },
    cleanup(work) { cleanups.push(work); },
    async request(method, params) { calls.push(["request", method, params]); if (requestError) throw requestError; return observed; },
    trackRecording(directory) { calls.push(["track", directory]); },
    async get(name) { calls.push(["get", name]); return host; },
    async presented() { calls.push(["presented"]); return { displayed: 41 }; },
  };
  return { session, calls, cleanups, observed, host, capture };
}
function capture(session) {
  assert.equal(typeof documents.captureDocumentReference, "function", "the public document reference capture owner is unavailable");
  return documents.captureDocumentReference(session, target);
}

test("document reference capture records actual public wire replies without inventing semantic or frame proof", async () => {
  const f = fixture();
  const packet = await capture(f.session);
  assert.equal(packet.observed, f.observed);
  assert.equal(packet.host, f.host);
  assert.equal(packet.capture, f.capture);
  assert.deepEqual(f.calls, [
    ["record", { frameIdentity: true }],
    ["request", "diagnostics.capture.document-reference", target],
    ["track", f.observed.directory],
    ["get", "host.window"],
    ["presented"],
    ["stop", { after: 41 }],
  ]);
  assert.equal(Object.hasOwn(packet, "verified"), false, "wire collection alone must not become a pixel-content proof");
  for (const cleanup of f.cleanups) await cleanup();
  assert.equal(f.calls.filter(([name]) => name === "stop").length, 1);
});

test("document reference capture stops its recording when the native provider request fails", async () => {
  const failure = new Error("actual native provider failed");
  const f = fixture({ requestError: failure });
  await assert.rejects(() => capture(f.session), error => error === failure);
  for (const cleanup of f.cleanups) await cleanup();
  assert.deepEqual(f.calls.filter(([name]) => name === "stop"), [["stop", { after: 0 }]]);
});

test("document reference capture preserves both provider and recording-cleanup failures", async () => {
  const requestError = new Error("actual native provider failed"), stopError = new Error("recording finish failed");
  const f = fixture({ requestError, stopError });
  await assert.rejects(() => capture(f.session), error => error instanceof AggregateError
    && error.errors.includes(requestError) && error.errors.includes(stopError));
  assert.equal(f.calls.filter(([name]) => name === "stop").length, 1);
});

test("document reference capture never retries a failed normal recording stop or labels it verified", async () => {
  const stopError = new Error("recording finish failed");
  const f = fixture({ stopError });
  await assert.rejects(() => capture(f.session), error => error === stopError);
  for (const cleanup of f.cleanups) await cleanup();
  assert.equal(f.calls.filter(([name]) => name === "stop").length, 1);
});
