// The toast bar runs for the remaining time at its first draw; a redraw with a lower remaining time writes no width, so a time that
// passes never shrinks the bar (docs/spec/notifications.md#toasts). The toast watchers are notified only when the shown toasts change,
// and the time that passes changes no toast (docs/spec/notifications.md#toasts). The clock is the page clock of the store (pageClock).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { installExposure } from "../exposure.js";
import { beginSettings } from "../settings.js";
import { errorToasts } from "../shown-errors.js";
import { notificationStore, onTabReports, onToastChange, pageClock } from "../tab-reports.js";
import { createPageClock } from "./runtime/page-clock.js";

installExposure(JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")));

function fixture(t) {
  const dom = new JSDOM("<body></body>");
  t.after(() => dom.window.close());
  const { document } = dom.window;
  Object.assign(globalThis, { window: dom.window, document });
  beginSettings({ common: { toastStyle: "card" }, projects: [] }, null);
  const clock = createPageClock();
  const realNow = pageClock.now;
  pageClock.now = clock.now;
  t.after(() => { pageClock.now = realNow; });
  const store = notificationStore();
  store.clearAll();
  if (store.status().open) store.toggle();
  store.setFilter("all");
  store.setList(false);
  errorToasts(document);
  const counts = { entries: 0, toasts: 0 };
  const stops = [onTabReports(() => { counts.entries += 1; }), onToastChange(() => { counts.toasts += 1; })];
  t.after(() => stops.forEach((stop) => stop()));
  return { document, store, clock, counts };
}

const barOf = (document, title) => {
  const toast = [...document.querySelectorAll("#toasts > .toast")].find((node) => node.querySelector(".toast__title").textContent === title);
  return toast?.querySelector(".toast__bar") ?? null;
};

test("a lower remaining time at a later redraw writes no bar width, so the bar keeps its first duration", (t) => {
  const { document, store, clock } = fixture(t);
  store.show({ kind: "success", title: "first saved" });
  const first = barOf(document, "first saved").style.animationDuration;
  assert.equal(first, "4000ms");
  clock.advance(1000);
  store.show({ kind: "success", title: "second saved" });
  assert.equal(barOf(document, "first saved").style.animationDuration, first, "the bar of the first toast keeps its first width");
  assert.equal(barOf(document, "second saved").style.animationDuration, "4000ms", "the new toast runs for its own remaining time");
});

test("time that passes notifies no toast watcher, and a change that keeps the toasts notifies the entry watchers only", (t) => {
  const { store, clock, counts } = fixture(t);
  store.show({ kind: "success", title: "saved" });
  const before = { ...counts };
  clock.advance(1000);
  assert.deepEqual(counts, before, "the time that passes changes no watcher");
  store.toggle();
  assert.equal(counts.toasts, before.toasts, "opening the center keeps the toasts and notifies no toast watcher");
  assert.equal(counts.entries, before.entries + 1, "opening the center notifies the entry watchers");
});
