// A page notice belongs to no card: it has the plugin as its source, a toast and a center entry, and no card status line
// (docs/spec/notifications.md#plugin-notices).
import assert from "node:assert/strict";
import test from "node:test";

const reports = await import("../tab-reports.js");

test("a page notice shows as a toast and a center entry with the plugin as its source, and no status line", () => {
  const id = reports.reportPageNotice({ kind: "info", title: "Built" }, "fixture-plain");
  const store = reports.notificationStore();
  const entry = store.entries().find((e) => e.id === id);
  assert.deepEqual(entry.source, { kind: "plugin", plugin: "fixture-plain" });
  assert.equal(entry.title, "Built");
  assert.ok(store.toasts().some((t) => t.id === id), "the page notice shows as a toast");
  assert.ok(store.records().find((n) => n.id === id).line === null, "the page notice has no status line");
});

test("a system page notice is kept as a system notification keyed by its plugin", () => {
  reports.reportPageNotice({ kind: "info", title: "Posted", system: true }, "fixture-plain");
  assert.ok(reports.tabNotices().some(([key, text]) => key === "fixture-plain" && text === "Posted"));
});

test("a page notice refuses an invalid kind with the notice rule", () => {
  assert.throws(() => reports.reportPageNotice({ kind: "loud", title: "Built" }, "fixture-plain"),
    { message: "a notice kind must be success, info, warning, error or progress" });
});

test("the page notice, its progress and its done go through the one notice store", () => {
  const id = reports.reportPageNotice({ kind: "progress", title: "Import" }, "fixture-plain");
  reports.reportProgress(id, 0.5);
  reports.reportDone(id, "success", "Imported");
  const entry = reports.notificationStore().entries().find((e) => e.id === id);
  assert.equal(entry.kind, "success");
  assert.equal(entry.title, "Imported");
});
