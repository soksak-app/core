// Checks that, when the pasteboard after a window check differs from the one before, the report states what differs.
// The content is data of the user, so only the length and the first part of the sha256 are stated.
import assert from "node:assert/strict";
import test from "node:test";
import { pasteboardDifference, restoreFailure } from "../pasteboard.mjs";

const text = (value) => Buffer.from(value).toString("base64");

test("the same items in another type order are no difference", () => {
  const before = [{ "public.utf8-plain-text": text("a"), "public.utf16-plain-text": text("b") }];
  const after = [{ "public.utf16-plain-text": text("b"), "public.utf8-plain-text": text("a") }];
  assert.equal(pasteboardDifference(before, after), null);
});

test("a changed value names the item, the type and both lengths and digests", () => {
  const difference = pasteboardDifference([{ "public.utf8-plain-text": text("before") }], [{ "public.utf8-plain-text": text("after!") }]);
  assert.match(difference, /^item 1 public\.utf8-plain-text: 6 bytes sha256 [0-9a-f]{12} instead of 6 bytes sha256 [0-9a-f]{12}$/);
  assert.ok(!difference.includes("before") && !difference.includes("after!"));
});

test("a missing or added type and another item count are named", () => {
  assert.equal(pasteboardDifference([{ a: text("x"), b: text("y") }], [{ a: text("x") }]), "item 1 b: absent instead of 1 bytes sha256 a1fce4363854");
  assert.equal(pasteboardDifference([{ a: text("x") }], []), "0 items instead of 1");
});

test("a write of another process after the restore is named with both change counts instead of a difference", () => {
  const saved = [{ a: text("x") }];
  assert.equal(restoreFailure(saved, 7, { changeCount: 8, items: [{ a: text("other") }] }),
    "another process wrote the pasteboard after the restore (change count 7 after the restore, 8 at the comparison)");
});

test("a restore that the comparison reads unchanged states the first difference, and an equal one is no failure", () => {
  assert.equal(restoreFailure([{ a: text("x") }], 7, { changeCount: 7, items: [] }), "0 items instead of 1");
  assert.equal(restoreFailure([{ a: text("x") }], 7, { changeCount: 7, items: [{ a: text("x") }] }), null);
});
