import assert from "node:assert/strict";
import test from "node:test";
import { createLinkBridge } from "../links.js";

test("the link bridge sends one linkOpen call and passes the host rejection through", async () => {
  const calls = [];
  const bridge = createLinkBridge((name, payload) => { calls.push([name, payload]); return null; });
  await bridge.open("https://example.test");
  assert.deepEqual(calls, [["linkOpen", { url: "https://example.test" }]]);
  await assert.rejects(bridge.open(""), /link URL must be a non-empty string/);
  await assert.rejects(bridge.open(7), /link URL must be a non-empty string/);
  assert.equal(calls.length, 1);
  const rejecting = createLinkBridge(() => Promise.reject(new Error('link URL scheme "file" is not opened')));
  await assert.rejects(rejecting.open("file:///etc/hosts"), /is not opened/);
});
