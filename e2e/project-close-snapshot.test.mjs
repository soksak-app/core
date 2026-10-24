import assert from "node:assert/strict";
import test from "node:test";

import { getClosedProjectSnapshot } from "./project-close-snapshot.mjs";

test("a closed-project status is read through one plugin-host snapshot pull", async () => {
  const snapshot = { version: 12, value: { elements: [{ kind: "status-line", key: "project", text: "프로젝트 없음" }] } };
  const calls = [];
  const s = {
    async get(name) {
      calls.push(["get", name]);
      return snapshot;
    },
    async until(name) {
      calls.push(["until", name]);
      throw new Error("plugin host files does not serve status.watch");
    },
  };

  const result = await getClosedProjectSnapshot(s, "files.tree", 11,
    (value) => value.elements[0]?.text === "프로젝트 없음", "files.tree did not publish its no-project snapshot");
  assert.equal(result, snapshot);
  assert.deepEqual(calls, [["get", "files.tree"]]);
});

test("a closed-project status pull rejects a stale or unexpected snapshot", async () => {
  const s = { async get() { return { version: 11, value: { elements: [] } }; } };
  await assert.rejects(getClosedProjectSnapshot(s, "files.tree", 11,
    (value) => value.elements[0]?.text === "프로젝트 없음", "files.tree did not publish its no-project snapshot"),
  /newer snapshot/);
});
