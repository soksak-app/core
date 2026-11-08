// Checks the pure parts of the input fixture helpers (e2e/input-probe.mjs): the card that a probe tab joins, the regions and
// documents of host.window that hold the keyboard, the text that the input transactions of an image region typed, and the
// delivery of each transaction to the sidecar of the raster probe.
import assert from "node:assert/strict";
import test from "node:test";

import { assertReceivedUnchanged, documentFocused, focusedCard, imageFocused, typedText } from "../input-probe.mjs";

test("a probe tab joins the focused card, else the first card that holds tabs", { timeout: 5000 }, () => {
  const fixed = { id: "c0", fixed: true, tabs: [{ id: "t0" }] };
  assert.equal(focusedCard({ cards: [fixed, { id: "c1", tabs: [] }, { id: "c2", focused: true, tabs: [] }] }).id, "c2");
  assert.equal(focusedCard({ cards: [fixed, { id: "c1", tabs: [] }, { id: "c2", tabs: [{ id: "t2" }] }] }).id, "c2");
  assert.throws(() => focusedCard({ cards: [fixed] }), /the layout has no card for an input probe tab/);
});

test("host.window names the document region and the image region of a surface that hold the keyboard", { timeout: 5000 }, () => {
  const window = {
    documents: [{ surface: "a", focused: false }, { surface: "b", focused: true }],
    regions: [{ surface: "a", name: "raster", focused: true }, { surface: "b", name: "other", focused: true }],
  };
  assert.deepEqual([documentFocused(window, "a"), documentFocused(window, "b")], [false, true]);
  assert.deepEqual([imageFocused(window, "a"), imageFocused(window, "b")], [true, false]);
});

test("the typed text of input transactions joins inserts, character keys and newlines in order", { timeout: 5000 }, () => {
  const transactions = [
    { actions: [{ type: "key", key: "Char", text: "e" }, { type: "insert", text: "ch" }] },
    { actions: [{ type: "key", key: "Backspace" }, { type: "insert", text: "o " }] },
    { actions: [{ type: "key", key: "Enter" }, { type: "command", selector: "insertNewline:" }, { type: "focus", focused: true }] },
  ];
  assert.equal(typedText(transactions), "echo \n\n");
});

test("each transaction must reach the sidecar once and unchanged, and an empty log fails", { timeout: 5000 }, () => {
  const entry = { sequence: 3, cids: ["n.1"], actions: [{ type: "insert", text: "한" }], preedit: { text: "" }, errors: [] };
  const received = { operation: "input", preedit: { text: "" }, actions: [{ type: "insert", text: "한" }], sequence: 3 };
  assert.doesNotThrow(() => assertReceivedUnchanged([{ ...entry, received }], "case"));
  assert.throws(() => assertReceivedUnchanged([], "case"), /case: the image region reported no input transaction/);
  assert.throws(() => assertReceivedUnchanged([{ ...entry, received: null }], "case"), /did not receive transaction 3 unchanged/);
  assert.throws(() => assertReceivedUnchanged([{ ...entry, received: { ...received, actions: [] } }], "case"),
    /did not receive transaction 3 unchanged/);
  assert.throws(() => assertReceivedUnchanged([{ ...entry, errors: [{ reason: "late" }], received }], "case"),
    /transaction 3 failed/);
});
