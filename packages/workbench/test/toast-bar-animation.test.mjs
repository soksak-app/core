// The bar of a shown toast runs a CSS animation whose duration is the remaining time at its first draw (docs/spec/notifications.md#toasts).
// A later redraw writes the same style, so the drawn HTML carries no timer-driven width. The test gives the store the clock of the page
// (test/runtime/page-clock.js), so the remaining time moves only by `clock.advance`, not by the run time of the test.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { registry } from "../exposure.js";
import { createPageClock } from "./runtime/page-clock.js";
import { createNotices } from "../notices.js";
import { mountNoticeView } from "../notice-view.js";

// The core declaration, which the toasts and the center bind.
registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);

// The store keeps its timers on the clock of the page: a timer runs when its instant is reached, and a cancelled timer does not run.
function pageStore() {
  const clock = createPageClock();
  const view = {
    setTimeout: (callback, ms) => {
      const timer = { cancelled: false };
      clock.after(() => { if (!timer.cancelled) callback(); }, ms);
      return timer;
    },
    clearTimeout: (timer) => { timer.cancelled = true; },
  };
  const settingValues = { autoDismissProblemToasts: false, problemToastDismissSeconds: 5, quietToasts: false, noticeCenterStyle: "popover" };
  let changes = 0;
  const store = createNotices({
    settings: (key) => settingValues[key], view, log: () => {}, onChange: () => { changes += 1; }, now: clock.now,
  });
  return { clock, store, changes: () => changes };
}

test("a redraw after time passed keeps the bar of a shown toast as it was first drawn", () => {
  const dom = new JSDOM("<body></body>");
  const { document } = dom.window;
  const { clock, store } = pageStore();
  const view = mountNoticeView(document, store);
  const bar = (title) => [...document.querySelectorAll("#toasts .toast")]
    .find((toast) => toast.querySelector(".toast__title").textContent === title)
    .querySelector(".toast__bar").getAttribute("style");

  store.show({ kind: "info", title: "first" });
  view.redraw();
  const drawn = bar("first");
  assert.match(drawn, /animation-duration: 4000ms/, "the bar runs for the remaining time of the first draw");
  clock.advance(1000);
  assert.equal(store.toasts()[0].remaining, 3000, "the page clock moved the remaining time of the toast");
  store.show({ kind: "info", title: "second" });
  view.redraw();
  assert.equal(bar("first"), drawn, "the redraw writes the duration of the first draw, not the remaining time");
  // The drawn copy of the bar carries its duration only, so a store change sends the same copy to the overlay (docs/spec/notifications.md#toasts).
  assert.doesNotMatch(bar("first"), /width/, "the bar has no width that a timer changes");
});

test("an advance of the page clock that expires no toast notifies no change of the store", () => {
  const { clock, store, changes } = pageStore();
  store.show({ kind: "info", title: "ticking" });
  const before = changes();
  clock.advance(1000);
  assert.equal(store.toasts().length, 1, "the toast is still shown");
  assert.equal(changes(), before, "the bar runs on its own and no change is announced");
});
