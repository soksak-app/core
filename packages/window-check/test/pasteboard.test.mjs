// Checks that, when the pasteboard after a window check differs from the one before, the report states what differs.
// The content is data of the user, so only the length and the first part of the sha256 are stated.
import assert from "node:assert/strict";
import test from "node:test";
import { pasteboardDifference } from "../pasteboard.mjs";

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
