// The notice store (docs/spec/notifications.md): places, merging, redraws of origins, pauses, withdrawal, groups and the log lines.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createNotices } from "../notices.js";

// Settings of the store, read by the store at each use; a test changes them through the object.
function fixture(overrides = {}) {
  const settingValues = { autoDismissProblemToasts: false, problemToastDismissSeconds: 5, quietToasts: false, noticeCenterStyle: "popover", ...overrides };
  const logs = [];
  let changes = 0;
  const store = createNotices({
    settings: (key) => settingValues[key],
    view: globalThis,
    log: (level, line) => logs.push([level, line]),
    onChange: () => { changes += 1; },
  });
  return { store, logs, settingValues, changes: () => changes };
}

test("an error is a notice of its origin: a redraw of the same text opens nothing and logs nothing", () => {
  const { store, logs } = fixture();
  const first = store.show({ kind: "error", title: "registry failed", text: "registry failed", origin: "home" });
  const again = store.show({ kind: "error", title: "registry failed", text: "registry failed", origin: "home" });
  assert.equal(again, first);
  assert.equal(store.toasts().length, 1);
  assert.deepEqual(logs, [["error", "workbench: registry failed"]]);
  store.withdrawOrigin("home");
  assert.equal(store.toasts().length, 0);
});

test("a closed occurrence stays closed on redraw, and the next occurrence of a changed origin opens a toast and a center entry", () => {
  const { store } = fixture();
  const id = store.show({ kind: "error", title: "a", text: "a", origin: "tab-1" });
  store.close(id);
  store.show({ kind: "error", title: "a", text: "a", origin: "tab-1" });
  assert.equal(store.toasts().length, 0, "the redraw of the closed occurrence leaves it closed");
  store.show({ kind: "error", title: "b", text: "b", origin: "tab-1" });
  assert.equal(store.toasts().length, 1);
  assert.equal(store.status().entries.length, 2, "the new occurrence adds a center entry; the closed one stays");
});

test("an occurrence with the kind and title of a shown notice merges into it and takes the newest text", () => {
  const { store, logs } = fixture();
  const id = store.show({ kind: "warning", title: "disk full", text: "first" });
  const merged = store.show({ kind: "warning", title: "disk full", text: "second" });
  assert.equal(merged, id);
  const [toast] = store.toasts();
  assert.equal(toast.title, "disk full ×2");
  assert.equal(toast.count, 2);
  assert.equal(store.status().entries[0].text, "second");
  assert.deepEqual(logs.map(([, line]) => line), ["notice warning: workbench: disk full", "notice warning: workbench: disk full ×2"]);
});

test("a success notice shows as a toast for four seconds and reports its remaining time", () => {
  const { store } = fixture();
  store.show({ kind: "success", title: "saved" });
  const [toast] = store.toasts();
  assert.ok(toast.remaining <= 4000 && toast.remaining > 3000, `remaining ${toast.remaining}`);
});

test("the timer of a shown notice pauses while it is held and resumes with the time left", async () => {
  const { store } = fixture();
  const id = store.show({ kind: "info", title: "ready" });
  await new Promise((resolve) => setTimeout(resolve, 150));
  store.hold(id, true);
  const held = store.toasts()[0].remaining;
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(store.toasts()[0].remaining, held, "the remaining time does not run while held");
  store.hold(id, false);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.ok(store.toasts()[0].remaining < held, "the remaining time runs again after the release");
  store.close(id);
});

test("a warning or error toast stays open until closed unless the setting asks for the delay", async () => {
  const { store, settingValues } = fixture();
  store.show({ kind: "error", title: "stuck", text: "stuck" });
  assert.equal(store.toasts()[0].remaining, null);
  settingValues.autoDismissProblemToasts = true;
  settingValues.problemToastDismissSeconds = 1;
  store.settingsChanged();
  assert.ok(store.toasts()[0].remaining <= 1000 && store.toasts()[0].remaining > 0);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(store.toasts().length, 0, "the delay closes the toast");
  assert.equal(store.status().entries.length, 1, "the entry stays");
});

test("quiet toasts show only errors as toasts, and an open center shows no new toast", () => {
  const { store, settingValues } = fixture({ quietToasts: true });
  store.show({ kind: "info", title: "quiet info" });
  store.show({ kind: "error", title: "loud" });
  assert.deepEqual(store.toasts().map((t) => t.title), ["loud"]);
  settingValues.quietToasts = false;
  store.toggle();
  store.show({ kind: "error", title: "center only" });
  assert.deepEqual(store.toasts().map((t) => t.title), ["loud"]);
  assert.equal(store.status().open, true);
});

test("a card notice has a status line; a warning of a card without the focus also shows a toast", () => {
  const { store } = fixture();
  const source = { kind: "card", card: "c1", tab: "t1", plugin: "p" };
  const info = store.show({ kind: "info", title: "built", source });
  assert.equal(store.lineOf("c1")?.id, info);
  assert.equal(store.toasts().length, 0, "an information notice of a card does not toast");
  const warn = store.show({ kind: "warning", title: "waits", source });
  assert.equal(store.lineOf("c1")?.id, warn, "the newest shown notice of the card is on its line");
  assert.equal(store.toasts().map((t) => t.id).includes(warn), true);
  store.focusCard("c1");
  assert.equal(store.status().entries.every((e) => e.read), true, "focusing a card marks its notices read");
});

test("the progress of a notice updates until done, and done ends it as success", () => {
  const { store } = fixture();
  const id = store.show({ kind: "progress", title: "build", progress: null });
  store.progress(id, 0.5);
  assert.equal(store.status().entries[0].progress, 0.5);
  assert.equal(store.toasts()[0].remaining, null, "a progress notice has no timer");
  store.done(id, "success", "build done");
  assert.equal(store.status().entries[0].kind, "success");
  assert.equal(store.status().entries[0].title, "build done");
  assert.ok(store.toasts()[0].remaining > 0, "the success notice has its four seconds");
});

test("withdrawing a tab removes its notices from the places and keeps the entries read", () => {
  const { store } = fixture();
  store.show({ kind: "error", title: "tab broke", source: { kind: "card", card: "c1", tab: "t1", plugin: "p" } });
  store.withdrawTab("t1");
  assert.equal(store.toasts().length, 0);
  assert.equal(store.lineOf("c1"), null);
  assert.equal(store.status().entries[0].read, true);
});

test("the center filters, marks read, clears groups and keeps progress entries", () => {
  const { store } = fixture();
  store.show({ kind: "info", title: "one" });
  store.show({ kind: "error", title: "two" });
  const progressId = store.show({ kind: "progress", title: "three", progress: null });
  store.setFilter("problems");
  assert.throws(() => store.setFilter("nope"), RangeError);
  store.readAll();
  assert.equal(store.status().unread, 0);
  store.clear("today");
  assert.deepEqual(store.status().entries.map((e) => e.id), [progressId], "clearing today keeps the running progress");
  assert.throws(() => store.clear("bogus"), RangeError);
});

test("an error entry stays in the center until cleared, and an info entry expires after seven days", () => {
  const { store } = fixture();
  store.show({ kind: "error", title: "keep" });
  store.show({ kind: "info", title: "old" });
  const old = store.records().find((n) => n.base === "old");
  old.at -= 8 * 24 * 60 * 60 * 1000;
  store.toggle();
  assert.deepEqual(store.status().entries.map((e) => e.title), ["keep"]);
});

test("core.notices reports the entries with their time, kind and the problem flag", () => {
  const { store } = fixture();
  store.show({ kind: "warning", title: "w" });
  const status = store.status();
  assert.equal(status.problems, true);
  assert.equal(status.unread, 1);
  assert.match(status.entries[0].at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
  assert.equal("group" in status.entries[0], false);
});

test("a notice rejects an invalid title, a bad action count and a progress on a finished kind", () => {
  const { store } = fixture();
  assert.throws(() => store.show({ kind: "info", title: "" }), TypeError);
  assert.throws(() => store.show({ kind: "info", title: "x\u0007" }), TypeError);
  assert.throws(() => store.show({ kind: "info", title: "x", actions: [{}, {}, {}] }), TypeError);
  assert.throws(() => store.show({ kind: "info", title: "x", progress: 0.5 }), TypeError);
});

test("a settings announcement that moves no toast notifies no watcher, and a new delay still applies to the shown toast", () => {
  const { store, settingValues, changes } = fixture();
  store.show({ kind: "info", title: "quiet" });
  const before = changes();
  store.settingsChanged();
  assert.equal(changes(), before, "nothing that a watcher shows changed");

  store.show({ kind: "error", title: "stuck", text: "stuck" });
  const notified = changes();
  settingValues.autoDismissProblemToasts = true;
  settingValues.problemToastDismissSeconds = 1;
  store.settingsChanged();
  assert.equal(changes(), notified, "the restarted delay is not a change of the toast list");
  const toast = store.toasts().find((t) => t.title === "stuck");
  assert.ok(toast.remaining <= 1000 && toast.remaining > 0, `remaining ${toast.remaining}`);
});

test("read marks one entry read and an id that no entry has is refused", () => {
  const { store, changes } = fixture();
  const first = store.show({ kind: "info", title: "one" });
  store.show({ kind: "info", title: "two" });
  const before = changes();
  store.read(first);
  assert.equal(store.status().entries.find((e) => e.id === first).read, true);
  assert.equal(store.status().unread, 1);
  assert.equal(changes(), before + 1, "a read changes the entries");
  assert.throws(() => store.read("notice-missing"), RangeError);
});

test("a show of the origin that holds a shown notice of the same kind and title is the same occurrence: new content, no new count", () => {
  const { store } = fixture();
  const id = store.show({ kind: "error", title: "sync failed", text: "first", origin: "sync-1" });
  const again = store.show({ kind: "error", title: "sync failed", text: "second", origin: "sync-1",
    actions: [{ label: "retry", command: "core.notices.retry", params: {} }] });
  assert.equal(again, id);
  assert.equal(store.notice(id).count, 1, "a redraw of the same origin does not count again");
  assert.equal(store.notice(id).text, "second", "the content is replaced");
  assert.equal(store.notice(id).actions.length, 1, "the actions are replaced");
});

test("a show of another origin with the same kind and title merges into the shown notice and counts", () => {
  const { store } = fixture();
  const id = store.show({ kind: "warning", title: "low disk", text: "a", origin: "disk-1" });
  assert.equal(store.show({ kind: "warning", title: "low disk", text: "a", origin: "disk-2" }), id);
  assert.equal(store.notice(id).count, 2, "a new origin is a new occurrence");
});

test("an occurrence of an origin whose notice was closed is a new notice with its count of one", () => {
  const { store } = fixture();
  const first = store.show({ kind: "error", title: "backup failed", text: "a", origin: "backup-1" });
  store.close(first);
  // A changed text is a new occurrence; an identical redraw of a closed occurrence stays closed (docs/spec/notifications.md#notices).
  const second = store.show({ kind: "error", title: "backup failed", text: "b", origin: "backup-1" });
  assert.notEqual(second, first);
  assert.equal(store.notice(second).count, 1);
});

test("card notices merge only within one card: the same kind and title on two cards are two notices", () => {
  const { store } = fixture();
  const onA = store.showTab({ kind: "warning", title: "service outdated", text: "a" }, { card: "card-a", tab: "tab-a", plugin: "plugin" });
  const onB = store.showTab({ kind: "warning", title: "service outdated", text: "b" }, { card: "card-b", tab: "tab-b", plugin: "plugin" });
  assert.notEqual(onB, onA);
  assert.equal(store.toasts().length, 2);
  assert.equal(store.notice(onA).count, 1);
  assert.equal(store.notice(onB).count, 1);
});

test("a card notice and an app notice with the same kind and title do not merge", () => {
  const { store } = fixture();
  const app = store.show({ kind: "warning", title: "service outdated", text: "app" });
  const card = store.showTab({ kind: "warning", title: "service outdated", text: "card" }, { card: "card-a", tab: "tab-a", plugin: "plugin" });
  assert.notEqual(card, app);
  assert.equal(store.toasts().length, 2);
});

test("the same card with the same kind and title merges into the shown card notice", () => {
  const { store } = fixture();
  const first = store.showTab({ kind: "warning", title: "service outdated", text: "one" }, { card: "card-a", tab: "tab-a", plugin: "plugin" });
  const again = store.showTab({ kind: "warning", title: "service outdated", text: "two" }, { card: "card-a", tab: "tab-b", plugin: "plugin" });
  assert.equal(again, first);
  assert.equal(store.notice(first).count, 2);
});

test("a card notice with an origin takes the new content of its origin and is withdrawn with it", () => {
  const { store } = fixture();
  const target = { card: "card-a", tab: "tab-a", plugin: "plugin" };
  const first = store.showTab({ kind: "warning", title: "service outdated", text: "one" }, target, "sidecar-outdated:svc:tab-a");
  const again = store.showTab({ kind: "warning", title: "service outdated", text: "two" }, target, "sidecar-outdated:svc:tab-a");
  assert.equal(again, first);
  assert.equal(store.notice(first).count, 1, "a show of the same origin is the same occurrence");
  assert.equal(store.notice(first).text, "two");
  store.withdrawOrigin("sidecar-outdated:svc:tab-a");
  assert.equal(store.toasts().length, 0);
});

// A source passes its failed operation as the first action of its error notice; core adds no retry to an error that it makes
// (docs/spec/notifications.md#toasts).
test("a source retry is the first action of its error toast, and an error without one has no retry", () => {
  const { store } = fixture();
  const sourced = store.show({ kind: "error", title: "sync failed", origin: "sync-2", actions: [{ label: "다시 시도", command: "core.notices.retry", params: {} }] });
  assert.equal(store.toastActions(sourced)[0].label, "다시 시도");
  const core = store.show({ kind: "error", title: "config unreadable", origin: "config-2" });
  assert.equal(store.toastActions(core).some((action) => action.label === "다시 시도"), false, "core adds no retry");
});
