// The notice store calls the notices kinds of the workspace operation of the native host (docs/spec/native-host.md#project-and-settings-operations).
import assert from "node:assert/strict";
import test from "node:test";
import { HostWorkspaceStore } from "../host-store.js";

test("the notice calls send the notices and noticesPut kinds of the workspace operation", async () => {
  const calls = [];
  const host = { call: async (name, request) => { calls.push({ name, request }); return null; }, on: () => () => {} };
  const store = new HostWorkspaceStore(host);
  await store.notices();
  await store.noticesPut([{ id: "n1", kind: "info", title: "Built" }]);
  assert.deepEqual(calls, [
    { name: "workspace", request: { kind: "notices" } },
    { name: "workspace", request: { kind: "noticesPut", notices: [{ id: "n1", kind: "info", title: "Built" }] } },
  ]);
});
