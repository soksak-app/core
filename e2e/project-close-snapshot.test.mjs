import assert from "node:assert/strict";
import test from "node:test";

import { getClosedProjectSnapshot } from "./project-close-snapshot.mjs";

test("a closed-project pull waits through a stale accepted snapshot for the exact current source", async () => {
  const source = { id: "plugin:files", surface: null, generation: 8 };
  const accepted = [
    { plugin: "files", status: "tree", surface: null, generation: 8, seq: 12 },
    { plugin: "files", status: "tree", surface: null, generation: 8, seq: 13 },
  ];
  const values = [
    { version: 12, value: { elements: [{ kind: "tree", key: "files" }] } },
    { version: 13, value: { elements: [{ kind: "status-line", key: "project", text: "프로젝트 없음" }] } },
  ];
  const calls = [];
  let published = 0;
  const s = {
    async until(name, predicate) {
      calls.push(["until", name]);
      assert.equal(name, "core.plugin.snapshots");
      const row = accepted[published++];
      assert.ok(predicate([row]), "the delayed ingress did not satisfy the source watermark predicate");
    },
    async get(name) {
      calls.push(["get", name]);
      if (name === "core.plugin.snapshots") return [accepted[published - 1]];
      assert.equal(name, "files.tree");
      return values.shift();
    },
  };

  const result = await getClosedProjectSnapshot(s, "files.tree", source, 11,
    (value) => value.elements[0]?.text === "프로젝트 없음", "files.tree did not publish its no-project snapshot");
  assert.deepEqual(result, { version: 13, value: { elements: [{ kind: "status-line", key: "project", text: "프로젝트 없음" }] } });
  assert.deepEqual(calls, [
    ["until", "core.plugin.snapshots"], ["get", "core.plugin.snapshots"], ["get", "files.tree"],
    ["until", "core.plugin.snapshots"], ["get", "core.plugin.snapshots"], ["get", "files.tree"],
  ]);
});

test("a closed-project pull ignores watermarks from another source generation", async () => {
  const source = { id: "plugin:files", surface: null, generation: 8 };
  const foreign = { plugin: "files", status: "tree", surface: null, generation: 7, seq: 99 };
  const s = {
    async until(name, predicate) {
      assert.equal(name, "core.plugin.snapshots");
      assert.equal(predicate([foreign]), false, "a retired generation satisfied the source watermark predicate");
      throw new Error("no current-source publication");
    },
    async get() { throw new Error("a pull ran without a current-source publication"); },
  };
  await assert.rejects(getClosedProjectSnapshot(s, "files.tree", source, 11,
    () => true, "files.tree did not publish its no-project snapshot"), /no current-source publication/);
});

test("a closed-project pull rejects a source id that does not match the plugin host contract", async () => {
  let requested = false;
  const s = {
    async until() { requested = true; },
    async get() { requested = true; },
  };
  await assert.rejects(getClosedProjectSnapshot(s, "files.tree",
    { id: "files", surface: null, generation: 8 }, 11, () => true, "unused"),
  /has plugin-host source files, expected plugin:files/);
  assert.equal(requested, false, "an invalid source id started a wait or pull");
});
