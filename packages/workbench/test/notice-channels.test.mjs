// The notice store has two channels of watchers (docs/spec/notifications.md#toasts): the toast watchers, which the toast bar and the
// overlay use, are notified only when the shown toasts change; the entry watchers, which the center, the bell and the notices file use,
// are notified on every change of an entry.
import assert from "node:assert/strict";
import { test } from "node:test";
import { notificationStore, onTabReports, onToastChange } from "../tab-reports.js";

function counting() {
  const counts = { entries: 0, toasts: 0 };
  const stops = [onTabReports(() => { counts.entries += 1; }), onToastChange(() => { counts.toasts += 1; })];
  return { counts, stop: () => stops.forEach((stop) => stop()) };
}

test("opening the center notifies the entry watchers and no toast watcher", () => {
  const store = notificationStore();
  store.clearAll();
  const { counts, stop } = counting();
  store.toggle();
  stop();
  store.toggle();
  assert.deepEqual(counts, { entries: 1, toasts: 0 });
});

test("a new toast notifies both channels", () => {
  const store = notificationStore();
  store.clearAll();
  const { counts, stop } = counting();
  store.show({ kind: "info", title: "new toast" });
  stop();
  assert.deepEqual(counts, { entries: 1, toasts: 1 });
});

test("reading an entry whose toast is gone notifies the entry watchers and no toast watcher", () => {
  const store = notificationStore();
  store.clearAll();
  const id = store.show({ kind: "info", title: "read me" });
  store.close(id);
  const { counts, stop } = counting();
  store.read(id);
  stop();
  assert.deepEqual(counts, { entries: 1, toasts: 0 });
});

test("closing a shown toast notifies both channels", () => {
  const store = notificationStore();
  store.clearAll();
  const id = store.show({ kind: "info", title: "close me" });
  const { counts, stop } = counting();
  store.close(id);
  stop();
  assert.deepEqual(counts, { entries: 1, toasts: 1 });
});
