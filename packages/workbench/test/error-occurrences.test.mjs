// The occurrences of an error shown as toasts: equal text from two origins shares one toast, each recovery leaves the other origin's error
// open, and a dismissed occurrence reopens after its origin recovers. The error display runs on a notice store of the page clock
// (test/runtime/page-clock.js), so the remaining time moves only by `clock.advance`, not by the run time of the test.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { installExposure } from "../exposure.js";
import { createErrorDisplay } from "../shown-errors.js";
import { beginSettings, onSettingsChange } from "../settings.js";
import { createPageNotices } from "../tab-reports.js";
import { createPageClock } from "./runtime/page-clock.js";

installExposure(JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")));

function fixture(t) {
  const dom = new JSDOM("<body></body>");
  t.after(() => dom.window.close());
  const { document } = dom.window;
  // The settings install their values on the global document of the page.
  Object.assign(globalThis, { window: dom.window, document });
  beginSettings({ common: {}, projects: [] }, null);
  const clock = createPageClock();
  const view = {
    setTimeout: (callback, ms) => {
      const timer = { cancelled: false };
      clock.after(() => { if (!timer.cancelled) callback(); }, ms);
      return timer;
    },
    clearTimeout: (timer) => { timer.cancelled = true; },
  };
  const records = [];
  let display = null;
  const store = createPageNotices({
    view,
    now: clock.now,
    record: (level, line) => { if (level === "error") records.push(line); },
    onChange: () => display?.redraw(),
  });
  // The store follows the common settings as the page store does (tab-reports.js notificationStore).
  t.after(onSettingsChange(() => store.settingsChanged()));
  display = createErrorDisplay(document, store);
  const dismissal = (auto, seconds) => {
    beginSettings({ common: { autoDismissProblemToasts: auto, problemToastDismissSeconds: seconds }, projects: [] }, null);
  };
  return {
    document, clock, store, dismissal,
    show: display.show, clear: display.withdraw, dismiss: display.dismiss, place: display.place, text: display.text,
    open: () => [...document.querySelectorAll("#toasts > .toast")].map((toast) => toast.querySelector(".toast__title").textContent),
    records: () => records,
  };
}

test("equal text from two origins shares a toast and records both occurrences", (t) => {
  const display = fixture(t);
  display.show("failed", " from layout", "layout");
  display.show("failed", " from activity", "activity tab");
  display.show("failed", " from layout", "layout");
  assert.deepEqual(display.open(), ["failed ×2"], "the merged notice reads its occurrence count (docs/spec/notifications.md#toasts)");
  assert.deepEqual(display.records(), ["workbench: failed from layout", "workbench: failed from activity"]);
});

test("recovering either origin leaves another origin's equal error open", (t) => {
  const display = fixture(t);
  for (const [first, second] of [["layout", "activity tab"], ["activity tab", "layout"]]) {
    display.show("failed", "", first);
    display.show("failed", "", second);
    display.clear(second);
    assert.deepEqual(display.open(), ["failed ×2"], `clearing ${second} removed the error of ${first}`);
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
  const display = fixture(t);
  const { document, clock } = display;
  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  document.body.append(dialog);
  display.dismissal(true, 4);
  display.show("failed", "", "layout");
  clock.advance(2000);
  display.show("failed", "", "layout");
  display.place(dialog);
  assert.ok(dialog.querySelector(".toast"));
  clock.advance(1999);
  assert.deepEqual(display.open(), ["failed"]);
  clock.advance(1);
  assert.deepEqual(display.open(), []);
  assert.equal(display.text("layout"), "failed", "the occurrence remains current after the toast expires");
  display.show("failed", "", "layout");
  display.place(document.body);
  assert.deepEqual(display.open(), []);
  assert.deepEqual(display.records(), ["workbench: failed"]);
});

test("a cancelled toast timer leaves a later occurrence of the same text open", (t) => {
  const display = fixture(t);
  const { clock } = display;
  display.dismissal(true, 4);
  display.show("failed", "", "layout");
  clock.advance(1000);
  assert.equal(display.dismiss("failed"), true);
  display.clear("layout");
  display.show("failed", "", "layout");
  clock.advance(3000);
  assert.deepEqual(display.open(), ["failed"]);
  clock.advance(1000);
  assert.deepEqual(display.open(), []);
  assert.deepEqual(display.records(), ["workbench: failed", "workbench: failed"]);
});

test("toasts default to manual stacking and live settings replace or cancel their deadlines", (t) => {
  const display = fixture(t);
  const { clock } = display;
  display.show("earlier", "", "layout");
  display.show("later", "", "activity");
  clock.advance(5000);
  assert.deepEqual(display.open(), ["later", "earlier"], "the default is manual dismissal, newest first");
  assert.equal(display.dismiss("earlier"), true);
  assert.deepEqual(display.open(), ["later"], "one manual close leaves other toasts open");

  display.dismissal(true, 5);
  clock.advance(3000);
  display.dismissal(true, 2);
  clock.advance(1999);
  assert.deepEqual(display.open(), ["later"]);
  clock.advance(1);
  assert.deepEqual(display.open(), []);

  display.clear("activity");
  display.show("later", "", "activity");
  clock.advance(1000);
  display.dismissal(false, 2);
  clock.advance(10000);
  assert.deepEqual(display.open(), ["later"], "turning the switch off cancels an open toast's deadline");
  display.clear("layout");
  display.show("earlier", "", "layout");
  clock.advance(5000);
  assert.deepEqual(display.open(), ["earlier", "later"], "the newest toast is first");
  assert.deepEqual(display.records(), ["workbench: earlier", "workbench: later", "workbench: later", "workbench: earlier"]);
});

test("an error text longer than the title shows its first 120 characters as the title and keeps the whole text in the record", (t) => {
  const display = fixture(t);
  const long = `${"a".repeat(100)}${"b".repeat(40)}`;
  display.show(long, "", "layout");
  const [toast] = display.store.toasts();
  assert.equal(toast.title, `${"a".repeat(100)}${"b".repeat(20)}`, "the title is the first 120 characters of the text");
  assert.equal(display.store.notice(toast.id).text, "b".repeat(20), "the text is the rest of the line");
  assert.deepEqual(display.records(), [`workbench: ${long}`], "the application log keeps the text as it was reported");
});
