// The notice fields of the tab reports at their limits (docs/spec/notifications.md#notices): a title of 1 to 120 characters, a text of
// 0 to 1024 characters, and no control characters in either.
import assert from "node:assert/strict";
import test from "node:test";
import { checkNotice, checkNoticeDone, checkNoticeProgress, NOTICE_KINDS } from "../tab-notice.js";

test("a notice takes the five kinds and the title and text limits", () => {
  assert.deepEqual(NOTICE_KINDS, ["success", "info", "warning", "error", "progress"]);
  for (const kind of NOTICE_KINDS) assert.deepEqual(checkNotice({ kind, title: "T", text: "" }), { kind, title: "T", text: "" });
  assert.equal(checkNotice({ kind: "info", title: "a".repeat(120), text: "b".repeat(1024) }).title.length, 120);
  assert.throws(() => checkNotice({ kind: "info", title: "a".repeat(121), text: "" }), { message: "a notice title must be 1 to 120 characters without control characters" });
  assert.throws(() => checkNotice({ kind: "info", title: "", text: "" }), { message: "a notice title must be 1 to 120 characters without control characters" });
  assert.throws(() => checkNotice({ kind: "info", title: "T", text: "b".repeat(1025) }), { message: "a notice text must be 0 to 1024 characters without control characters" });
  assert.throws(() => checkNotice({ kind: "info", title: "T\u007f", text: "" }), { message: "a notice title must be 1 to 120 characters without control characters" });
  assert.throws(() => checkNotice({ kind: "info", title: "T", text: "a\u009f" }), { message: "a notice text must be 0 to 1024 characters without control characters" });
  // text is optional: an absent text is no text, and the checked notice carries an empty text.
  assert.deepEqual(checkNotice({ kind: "info", title: "T" }), { kind: "info", title: "T", text: "" });
});

test("a notice keeps the optional action and system and drops nothing else", () => {
  assert.deepEqual(checkNotice({ kind: "warning", title: "T", text: "x", action: { label: "a".repeat(24), command: "probe.run" }, system: false }), {
    kind: "warning", title: "T", text: "x", action: { label: "a".repeat(24), command: "probe.run" }, system: false,
  });
  assert.deepEqual(checkNotice({ kind: "info", title: "T", text: "x", action: { label: "Go", command: "probe.go", params: { n: 1 } } }).action, { label: "Go", command: "probe.go", params: { n: 1 } });
  assert.throws(() => checkNotice({ kind: "info", title: "T", text: "x", action: { label: "a".repeat(25), command: "probe.go" } }), { message: "a notice action label must be 1 to 24 characters" });
  assert.throws(() => checkNotice({ kind: "info", title: "T", text: "x", action: { label: "Go", command: "" } }), { message: "a notice action command must be a non-empty string" });
  assert.throws(() => checkNotice({ kind: "info", title: "T", text: "x", action: { label: "Go", command: "probe.go", extra: 1 } }), { message: "a notice action takes only label, command and params; found extra" });
  assert.throws(() => checkNotice({ kind: "info", title: "T", text: "x", action: "Go" }), { message: "a notice action must be an object" });
  assert.deepEqual(checkNotice({ kind: "info", title: "T", action: { label: "Go", command: "probe.go" } }).action, { label: "Go", command: "probe.go" });
  for (const params of [1, "x", null, [1]]) {
    assert.throws(() => checkNotice({ kind: "info", title: "T", text: "x", action: { label: "Go", command: "probe.go", params } }), { message: "a notice action params must be an object" }, String(params));
  }
  assert.throws(() => checkNotice({ kind: "info", title: "T", text: "x", system: "yes" }), { message: "a notice system must be true or false" });
  assert.throws(() => checkNotice({ kind: "info", title: "T", text: "x", progress: 0.5 }), { message: "a notice takes only kind, title, text, action and system; found progress" });
  assert.throws(() => checkNotice([]), { message: "a notice must be an object" });
});

test("a progress takes an id and a number from 0 to 1, or null while the amount is unknown", () => {
  assert.deepEqual(checkNoticeProgress({ id: "notice-1", progress: 0 }), { id: "notice-1", progress: 0 });
  assert.deepEqual(checkNoticeProgress({ id: "notice-1", progress: 1 }), { id: "notice-1", progress: 1 });
  assert.deepEqual(checkNoticeProgress({ id: "notice-1", progress: null }), { id: "notice-1", progress: null });
  for (const progress of [-0.1, 1.01, Number.NaN, "0.5", undefined]) {
    assert.throws(() => checkNoticeProgress({ id: "notice-1", progress }), { message: "a notice progress must be a number from 0 to 1, or null while the amount is unknown" }, String(progress));
  }
  assert.throws(() => checkNoticeProgress({ id: "", progress: 0.5 }), { message: "a notice id must be a non-empty string" });
  assert.throws(() => checkNoticeProgress({ id: 3, progress: 0.5 }), { message: "a notice id must be a non-empty string" });
  assert.throws(() => checkNoticeProgress({ id: "notice-1", progress: 0.5, kind: "info" }), { message: "a notice progress takes only id and progress; found kind" });
});

test("a finished notice ends as success or error with a title", () => {
  assert.deepEqual(checkNoticeDone({ id: "notice-1", kind: "error", title: "Failed" }), { id: "notice-1", kind: "error", title: "Failed" });
  assert.throws(() => checkNoticeDone({ id: "notice-1", kind: "progress", title: "Failed" }), { message: "a finished notice must be success or error" });
  assert.throws(() => checkNoticeDone({ id: "notice-1", kind: "success", title: "" }), { message: "a notice title must be 1 to 120 characters without control characters" });
  assert.throws(() => checkNoticeDone({ id: "notice-1", kind: "success" }), { message: "a notice title must be 1 to 120 characters without control characters" });
  assert.throws(() => checkNoticeDone({ id: "notice-1", kind: "success", title: "Done", text: "x" }), { message: "a finished notice takes only id, kind and title; found text" });
});
