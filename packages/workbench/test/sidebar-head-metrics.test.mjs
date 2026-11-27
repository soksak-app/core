// The head of a window sidebar uses the header metrics of a card: the padding and the gap of `.chrome` (docs/spec/external-sidebars.md#sidebar-head-and-edge).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("../app.css", import.meta.url), "utf8");
// The rule that starts a line with the selector, so a descendant rule of the same class name is not read.
const rule = (selector) => {
  const match = new RegExp(`^${selector.replace(/[.]/g, "\\.")}\\{[^}]*\\}`, "m").exec(css);
  assert.notEqual(match, null, `${selector} has a rule`);
  return match[0];
};

test("the window sidebar head takes the padding and the gap of the card header", () => {
  const chrome = rule(".chrome");
  const head = rule(".sidebar-head");
  assert.match(chrome, /padding:0 var\(--card-head-pad\)/);
  assert.match(chrome, /gap:var\(--card-head-gap\)/);
  assert.match(head, /padding:0 var\(--card-head-pad\)/, "the head pads with the card header padding");
  assert.match(head, /gap:var\(--card-head-gap\)/, "the head gaps with the card header gap");
});
