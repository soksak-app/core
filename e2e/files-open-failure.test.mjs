import assert from "node:assert/strict";
import test from "node:test";

import { hasOpenFailureRow, nodeByPath, openFailureRow, treeNodes, waitAcceptedTreeSection, waitTreeSnapshot } from "./files-open-failure.mjs";

test("the Files tree node lookup finds a nested path in its declared snapshot", () => {
  const snapshot = { value: { elements: [{ kind: "tree", key: "files", nodes: [
    { key: "folder", params: { path: "folder" }, children: [
      { key: "file", params: { path: "folder/note.zzz" }, selected: true },
    ] },
  ] }] } };
  assert.equal(nodeByPath(snapshot, "folder/note.zzz").selected, true);
  assert.equal(nodeByPath(snapshot, "missing"), null);
});

test("the Files tree baseline waits for a current accepted snapshot", async () => {
  const pending = [{ sidebar: "left", sections: [{ id: "files.tree", source: { id: "files", surface: null },
    subscription: "pending", mounted: false, acceptedSeq: null, text: "" }] }];
  const accepted = [{ sidebar: "left", sections: [{ id: "files.tree", source: { id: "files", surface: null },
    subscription: "ready", mounted: true, acceptedSeq: 8, text: "project" }] }];
  let notifications = 0;
  const s = {
    async get(name) {
      assert.equal(name, "core.sidebars");
      return pending;
    },
    async until(name, predicate) {
      assert.equal(name, "core.sidebars");
      notifications += 1;
      assert.equal(predicate(pending), false, "a pending source was accepted as a sequence baseline");
      notifications += 1;
      assert.equal(predicate(accepted), true, "the accepted source was not recognized");
      return accepted;
    },
  };

  const result = await waitAcceptedTreeSection(s, "Files tree source did not accept a snapshot");
  assert.equal(notifications, 2, "the baseline did not wait through the pending notification");
  assert.equal(result.section.acceptedSeq, 8);
  assert.equal(result.section.source.id, "files");
});

test("the Files tree readiness failure includes the last observed sidebar payload", async () => {
  const pending = [{ sidebar: "left", sections: [{ id: "files.tree", source: { id: "files", surface: null },
    subscription: "pending", mounted: false, acceptedSeq: null, text: "" }] }];
  const s = {
    async get(name) {
      assert.equal(name, "core.sidebars");
      return pending;
    },
    async until(name, predicate) {
      assert.equal(name, "core.sidebars");
      assert.equal(predicate(pending), false);
      throw new Error("status wait timed out");
    },
  };

  await assert.rejects(waitAcceptedTreeSection(s, "Files tree source did not accept a snapshot"),
    /last core\.sidebars=.*subscription.*pending.*acceptedSeq.*null/);
});

test("file-open failure check reads the declared tree snapshot, not removed status values", async () => {
  let sequence = 3;
  let triggered = false;
  const reads = [];
  const section = { id: "files.tree", acceptedSeq: sequence,
    text: "note.zzz 열 수 없음: no plugin opens folder/note.zzz" };
  const tree = { version: sequence, value: { elements: [{ kind: "tree", key: "files", nodes: [
    { key: "file", label: "note.zzz", params: { path: "folder/note.zzz" }, selected: true },
    { key: "failure", label: "열 수 없음: no plugin opens folder/note.zzz" },
  ] }] } };
  const s = {
    async get(name) {
      reads.push(name);
      if (name === "core.sidebars") return [{ sidebar: "left", sections: [section] }];
      if (name === "files.tree") return tree;
      if (name === "core.page.error") return null;
      throw new Error(`unexpected status ${name}`);
    },
    async until(name, predicate) {
      reads.push(name);
      if (name === "core.sidebars") {
        sequence += 1;
        section.acceptedSeq = sequence;
        tree.version = sequence;
        const value = [{ sidebar: "left", sections: [section] }];
        if (predicate(value)) return value;
      }
      throw new Error(`unexpected wait ${name}`);
    },
  };
  await openFailureRow(s, "folder/note.zzz", sequence, async () => { triggered = true; });
  assert.equal(triggered, true, "the native Enter action did not run");
  assert.equal(hasOpenFailureRow(tree), true, "the snapshot omitted the message row");
  assert.ok(reads.includes("files.tree"), "the check did not read the declared tree snapshot");
  assert.ok(reads.includes("core.sidebars"), "the check did not inspect the rendered tree section");
  assert.ok(!reads.includes("files.selection"), "the check read an undeclared selection status");
  assert.ok(!reads.includes("files.open"), "the check read the open command as a status");
});

test("file-open failure check waits for a newer snapshot to clear the message row", async () => {
  let sequence = 4;
  const section = { id: "files.tree", acceptedSeq: sequence, text: "other.zzz" };
  const snapshot = { version: sequence, value: { elements: [{ kind: "tree", key: "files", nodes: [
    { key: "other", label: "other.zzz", params: { path: "folder/other.zzz" }, selected: true },
  ] }] } };
  let waits = 0;
  const s = {
    async until(name, predicate) {
      assert.equal(name, "core.sidebars");
      waits += 1;
      sequence += 1;
      section.acceptedSeq = sequence;
      snapshot.version = sequence;
      const value = [{ sidebar: "left", sections: [section] }];
      assert.equal(predicate(value), true);
      return value;
    },
    async get(name) {
      assert.equal(name, "files.tree");
      return snapshot;
    },
  };
  const cleared = await waitTreeSnapshot(s, 3,
    (value, current) => current.acceptedSeq > 3 && !hasOpenFailureRow(value) &&
      treeNodes(value).some((node) => node.params?.path === "folder/other.zzz" && node.selected),
    "selecting another path did not clear the message row");
  assert.equal(cleared.sequence, 5);
  assert.equal(waits, 1);
});
