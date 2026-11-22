// The role requests of the page go to the workspace kinds of the host (docs/spec/agent-roles.md#commands, docs/spec/agent-roles.md#role-status).
import assert from "node:assert/strict";
import { test } from "node:test";
import { HostWorkspaceStore } from "../host-store.js";

function recordingHost() {
  const calls = [];
  return {
    calls,
    on: () => () => {},
    call: async (name, request) => {
      calls.push([name, request]);
      return null;
    },
  };
}

test("a define sends the roleDefine kind with the identifier and the entry of the definition", async () => {
  const host = recordingHost();
  const store = new HostWorkspaceStore(host);
  await store.roleDefine("reviewer", { text: "Review.", ko: "검토한다.", files: ["/a/checklist.md"] });
  assert.deepEqual(host.calls, [["workspace", { kind: "roleDefine", id: "reviewer", entry: { text: "Review.", ko: "검토한다.", files: ["/a/checklist.md"] } }]]);
});

test("a remove sends the roleDefinitionRemove kind with the identifier", async () => {
  const host = recordingHost();
  const store = new HostWorkspaceStore(host);
  await store.roleDefinitionRemove("reviewer");
  assert.deepEqual(host.calls, [["workspace", { kind: "roleDefinitionRemove", id: "reviewer" }]]);
});

test("the role status is read with the rolesStatus kind", async () => {
  const host = recordingHost();
  const store = new HostWorkspaceStore(host);
  await store.rolesStatus();
  assert.deepEqual(host.calls, [["workspace", { kind: "rolesStatus" }]]);
});
