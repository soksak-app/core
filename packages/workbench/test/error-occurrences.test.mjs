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
  const { show, withdraw, dismiss, place, text, setAutoDismiss } = errorToasts(document);
  const log = t.mock.method(rawConsole, "error", () => {});
  return {
    document, show, clear: withdraw, dismiss, place, text, setAutoDismiss,
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

test("a toast expires after four seconds across repaint and movement into a dialog", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const display = fixture(t);
  const { document } = display;
  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  document.body.append(dialog);
  display.setAutoDismiss(true, 4);
  display.show("failed", "", "layout");
  t.mock.timers.tick(2000);
  display.show("failed", "", "layout");
  display.place(dialog);
  assert.ok(dialog.querySelector(".error-toast"));
  t.mock.timers.tick(1999);
  assert.deepEqual(display.open(), ["failed"]);
  t.mock.timers.tick(1);
  assert.deepEqual(display.open(), []);
  assert.equal(display.text("layout"), "failed", "the occurrence remains current after the toast expires");
  display.show("failed", "", "layout");
  display.place(document.body);
  assert.deepEqual(display.open(), []);
  assert.deepEqual(display.records(), ["workbench: failed"]);
});

test("a cancelled toast timer leaves a later occurrence of the same text open", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const display = fixture(t);
  display.setAutoDismiss(true, 4);
  display.show("failed", "", "layout");
  t.mock.timers.tick(1000);
  assert.equal(display.dismiss("failed"), true);
  display.clear("layout");
  display.show("failed", "", "layout");
  t.mock.timers.tick(3000);
  assert.deepEqual(display.open(), ["failed"]);
  t.mock.timers.tick(1000);
  assert.deepEqual(display.open(), []);
  assert.deepEqual(display.records(), ["workbench: failed", "workbench: failed"]);
});

test("toasts default to manual stacking and live settings replace or cancel their deadlines", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const display = fixture(t);
  display.show("earlier", "", "layout");
  display.show("later", "", "activity");
  t.mock.timers.tick(5000);
  assert.deepEqual(display.open(), ["earlier", "later"], "the default is manual dismissal");
  assert.equal(display.dismiss("earlier"), true);
  assert.deepEqual(display.open(), ["later"], "one manual close leaves other toasts open");

  display.setAutoDismiss(true, 5);
  t.mock.timers.tick(3000);
  display.setAutoDismiss(true, 2);
  t.mock.timers.tick(1999);
  assert.deepEqual(display.open(), ["later"]);
  t.mock.timers.tick(1);
  assert.deepEqual(display.open(), []);

  display.clear("activity");
  display.show("later", "", "activity");
  t.mock.timers.tick(1000);
  display.setAutoDismiss(false, 2);
  t.mock.timers.tick(10000);
  assert.deepEqual(display.open(), ["later"], "turning the switch off cancels an open toast's deadline");
  display.clear("layout");
  display.show("earlier", "", "layout");
  t.mock.timers.tick(5000);
  assert.deepEqual(display.open(), ["later", "earlier"]);
  assert.deepEqual(display.records(), ["workbench: earlier", "workbench: later", "workbench: later", "workbench: earlier"]);
});
