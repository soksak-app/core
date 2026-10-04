// 창 검사 뒤 페이스트보드가 앞과 다를 때 무엇이 다른지 밝히는지 검사한다. 내용은 사용자의 자료이므로 길이와
// sha256 앞부분만 밝힌다.
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
