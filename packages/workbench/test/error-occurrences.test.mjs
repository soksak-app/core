import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { installExposure } from "../exposure.js";
import { rawConsole } from "../page-log.js";
import { errorToasts } from "../shown-errors.js";

installExposure(JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")));

function fixture(t) {
  const dom = new JSDOM("<body></body>");
  t.after(() => dom.window.close());
  const { document } = dom.window;
  const { show, withdraw, dismiss } = errorToasts(document);
  const log = t.mock.method(rawConsole, "error", () => {});
  return {
    show, clear: withdraw, dismiss,
    open: () => [...document.querySelectorAll("#errorToasts > .error-toast")].map((toast) => toast.dataset.text),
    records: () => log.mock.calls.map(({ arguments: [line] }) => line),
  };
}

test("equal text from two origins shares a toast and records both occurrences", (t) => {
  const display = fixture(t);
  display.show("failed", " from layout", "layout");
  display.show("failed", " from activity", "activity tab");
  display.show("failed", " from layout", "layout");
  assert.deepEqual(display.open(), ["failed"]);
  assert.deepEqual(display.records(), ["workbench: failed from layout", "workbench: failed from activity"]);
});

test("recovering either origin leaves another origin's equal error open", (t) => {
  const display = fixture(t);
  for (const [first, second] of [["layout", "activity tab"], ["activity tab", "layout"]]) {
    display.show("failed", "", first);
    display.show("failed", "", second);
    display.clear(second);
    assert.deepEqual(display.open(), ["failed"], `clearing ${second} removed the error of ${first}`);
    display.clear(first);
    assert.deepEqual(display.open(), []);
  }
});

test("a dismissed occurrence stays closed on repaint and can reopen after recovery", (t) => {
  const display = fixture(t);
  display.show("failed", " from layout", "layout");
  display.show("failed", " from activity", "activity tab");
  assert.equal(display.dismiss("failed"), true);
  display.show("failed", " from layout", "layout");
  display.show("failed", " from activity", "activity tab");
  assert.deepEqual(display.open(), []);
  assert.deepEqual(display.records(), ["workbench: failed from layout", "workbench: failed from activity"]);

  display.clear("activity tab");
  display.show("failed", " after activity recovered", "activity tab");
  assert.deepEqual(display.open(), ["failed"]);
  assert.deepEqual(display.records(), [
    "workbench: failed from layout", "workbench: failed from activity", "workbench: failed after activity recovered",
  ]);
});
