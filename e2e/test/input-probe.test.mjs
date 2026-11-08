// Checks the pure parts of the input fixture helpers (e2e/input-probe.mjs): the card that a probe tab joins, the regions and
// documents of host.window that hold the keyboard, the text that the input transactions of an image region typed, and the
// delivery of each transaction to the sidecar of the raster probe.
import assert from "node:assert/strict";
import test from "node:test";

import { assertReceivedUnchanged, documentFocused, focusedCard, imageFocused, inputDocument, insertedText, presentsTransaction,
  readyRasterProbe, transactionMatchesKey, typedText } from "../input-probe.mjs";

test("the document of input transactions folds commits, deletions and the last preedit as a plain text client", { timeout: 5000 }, () => {
  const transactions = [
    { actions: [{ type: "insert", text: "ddd" }], preedit: { text: "" } },
    { actions: [], preedit: { text: "ㅏ" } },
    { actions: [{ type: "insert", text: "ㅏ" }], preedit: { text: "ㅏ" } },
    { actions: [{ type: "insert", text: "ㅏ" }, { type: "key", key: "Backspace" }], preedit: { text: "" } },
    { actions: [{ type: "command", selector: "deleteBackward:" }, { type: "insert", text: " " }], preedit: { text: "한" } },
  ];
  assert.equal(inputDocument(transactions), "ddd 한");
  assert.equal(inputDocument([]), "");
  assert.equal(insertedText(transactions), "dddㅏㅏ ");
});

test("a transaction acknowledges a vowel key, a Backspace and a Space by its actions or its preedit", { timeout: 5000 }, () => {
  const preedit = (text) => ({ text });
  assert.equal(transactionMatchesKey({ actions: [], preedit: preedit("ㅏ") }, "k"), true);
  assert.equal(transactionMatchesKey({ actions: [{ type: "insert", text: "ㅏ" }], preedit: preedit("ㅏ") }, "k"), true);
  assert.equal(transactionMatchesKey({ actions: [{ type: "key", key: "Backspace" }], preedit: preedit("") }, "k"), false);
  assert.equal(transactionMatchesKey({ actions: [{ type: "command", selector: "deleteBackward:" }], preedit: preedit("") }, "Backspace"), true);
  assert.equal(transactionMatchesKey({ actions: [{ type: "insert", text: "ㅏ " }], preedit: preedit("") }, "Space"), true);
  assert.throws(() => transactionMatchesKey({ actions: [], preedit: preedit("") }, "q"), /no receipt rule for the key "q"/);
});

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

test("an image region presents a transaction from the frame that the sidecar drew after it, in the same generation and raster", { timeout: 5000 }, () => {
  const entry = { sequence: 4, frame: { generation: 2, raster: 3, sequence: 9 } };
  const region = (presented) => ({ surface: "tab-1", name: "raster", presented });
  assert.equal(presentsTransaction(region({ generation: 2, raster: 3, sequence: 9 }), entry), true);
  assert.equal(presentsTransaction(region({ generation: 2, raster: 3, sequence: 12 }), entry), true, "a later frame shows the state after it too");
  assert.equal(presentsTransaction(region({ generation: 2, raster: 3, sequence: 8 }), entry), false, "an earlier frame does not");
  assert.equal(presentsTransaction(region({ generation: 1, raster: 3, sequence: 20 }), entry), false, "another generation does not");
  assert.equal(presentsTransaction(region({ generation: 2, raster: 4, sequence: 20 }), entry), false, "another raster does not");
  assert.equal(presentsTransaction(region(null), entry), false, "a region that presented nothing does not");
  assert.equal(presentsTransaction(undefined, entry), false, "a missing region does not");
  assert.equal(presentsTransaction(region({ generation: 2, raster: 3, sequence: 9 }), { sequence: 4, frame: null }), false,
    "a transaction without its frame is not presented");
});

test("a raster probe that a check makes ready draws its image regions covered before the wait for its first frame", { timeout: 5000 }, async () => {
  // A check window opens behind other windows, and a covered image region draws no raster, so every wait for the first frame of
  // a raster probe turns the covered drawing on first (rasterReady in e2e/raster-probe.mjs, docs/spec/hosts.md#launch-activation).
  const calls = [];
  const s = {
    registered: async (surface, entries) => { calls.push(["registered", surface, entries]); },
    request: async (method, params) => { calls.push(["request", method, params]); return null; },
    until: async (name, accept) => {
      calls.push(["until", name]);
      const value = name === "rasterprobe.session" ? { session: "s1", connected: true }
        : name === "rasterprobe.frame" ? { generation: 1, raster: 1, sequence: 1 }
          : { regions: [{ surface: "tab-1", name: "raster", visible: true, frame: { width: 10 } }] };
      assert.ok(accept(value));
      return value;
    },
    cleanup: () => {},
  };
  await readyRasterProbe(s, "tab-1");
  const covered = calls.findIndex(([kind, method, params]) => kind === "request" && method === "diagnostics.window.draw-covered" &&
    params?.draw === true);
  const frame = calls.findIndex(([kind, name]) => kind === "until" && name === "rasterprobe.frame");
  assert.ok(covered >= 0 && covered < frame, `the window draws covered before the frame wait: ${JSON.stringify(calls)}`);
});
