// The notice center file notices.json (docs/spec/notifications.md#notice-center): read at start, written on each change, expired entries
// dropped on read, write and open, and a file of another format refused with an error that names the file.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { installExposure } from "../exposure.js";
import { beginSettings } from "../settings.js";
import { checkNoticesDocument, openNotices } from "../notices-file.js";
import { errorToasts } from "../shown-errors.js";
import { notificationStore, reportTitle } from "../tab-reports.js";

// The listeners of the tab reports outlive a test unless they are removed: each test removes what it opened.
const stops = [];
afterEach(() => { for (const stop of stops.splice(0)) stop(); });

installExposure(JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")));

const DAY = 24 * 60 * 60 * 1000;
const entry = (over) => ({
  id: "notice-1", kind: "info", title: "saved", text: "", source: { kind: "core" }, actions: [],
  at: new Date().toISOString(), count: 1, read: false, ...over,
});

test("a document of the current format yields its entries; null is a missing file; another format is refused by name", () => {
  assert.deepEqual(checkNoticesDocument(null), []);
  assert.deepEqual(checkNoticesDocument({ format: 2, notices: [entry({})] }).map((e) => e.id), ["notice-1"]);
  assert.throws(() => checkNoticesDocument({ format: 1, notices: [] }), /notices\.json holds no notices of format 2/);
  assert.throws(() => checkNoticesDocument({ notices: [] }), /notices\.json holds no notices of format 2/);
  assert.throws(() => checkNoticesDocument({ format: 2, notices: [entry({ source: { kind: "card", card: "c", tab: "t" } })] }),
    /notice-1 is a card notice without its tab label/);
});

test("open restores the stored entries, drops the expired ones and writes the list after a change", async () => {
  const store = notificationStore();
  store.clearAll();
  const written = [];
  const host = {
    notices: async () => ({
      format: 2,
      notices: [
        entry({ id: "notice-7", kind: "info", title: "week-old", at: new Date(Date.now() - 8 * DAY).toISOString() }),
        entry({ id: "notice-8", kind: "error", title: "kept", at: new Date(Date.now() - 30 * DAY).toISOString() }),
        entry({ id: "notice-9", kind: "info", title: "recent" }),
      ],
    }),
    noticesPut: async (notices) => { written.push(notices); return 1; },
  };
  stops.push(await openNotices({ host, failed: () => assert.fail("no failure expected") }));
  assert.deepEqual(store.status().entries.map((e) => e.title).sort(), ["kept", "recent"], "the week-old info entry expired at read");
  store.show({ kind: "info", title: "new one" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(written.length >= 1, true, "a change writes the list");
  const last = written.at(-1);
  assert.deepEqual(last.map((e) => e.title).sort(), ["kept", "new one", "recent"]);
});

test("a tab report that changes no notice writes nothing after open", async () => {
  const store = notificationStore();
  store.clearAll();
  const written = [];
  const host = {
    notices: async () => ({ format: 2, notices: [entry({ id: "notice-3", title: "stored" })] }),
    noticesPut: async (notices) => { written.push(notices); return 1; },
  };
  stops.push(await openNotices({ host, failed: () => assert.fail("no failure expected") }));
  reportTitle("notices-baseline-tab", "first");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(written, [], "the restored notices are not written back unchanged");
});

test("a refused write shows one error notice with its origin, and the repeated refusal of the same write changes nothing", async (t) => {
  const dom = new JSDOM("<body></body>");
  t.after(() => dom.window.close());
  const { document } = dom.window;
  Object.assign(globalThis, { window: dom.window, document });
  beginSettings({ common: {}, projects: [] }, null);
  const store = notificationStore();
  store.clearAll();
  if (store.status().open) store.toggle();
  store.setFilter("all");
  let writes = 0;
  const host = { notices: async () => null, noticesPut: async () => { writes += 1; throw new Error("write refused"); } };
  // The failure path of projects.js: the error display with the origin of the notices file.
  const failed = (error) => errorToasts(document).show(error.message, "", "notices-file", "notices-file");
  stops.push(await openNotices({ host, failed }));
  store.show({ kind: "info", title: "one change" });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(writes, 1, "the change is written once; the error notice of the refusal is no real change, so no write follows");
  assert.equal(store.entries().filter((e) => e.kind === "error").length, 1, "one error notice");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(writes, 1, "no write follows the refusal");
  // A tab report with no change of the notices is not a reason to write the error notice that the refusal added.
  reportTitle("refusal-tab", "after");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(writes, 1, "a report with no change of the notices writes nothing");
});

test("a refusal with a new message on each write still starts no further write: the failure of a write is no real change", async (t) => {
  const dom = new JSDOM("<body></body>");
  t.after(() => dom.window.close());
  const { document } = dom.window;
  Object.assign(globalThis, { window: dom.window, document });
  beginSettings({ common: {}, projects: [] }, null);
  const store = notificationStore();
  store.clearAll();
  if (store.status().open) store.toggle();
  store.setFilter("all");
  let writes = 0;
  // The cap ends the refusals, so a failing build stops after 50 writes instead of running on.
  const host = { notices: async () => null, noticesPut: async () => { writes += 1; if (writes > 50) return 1; throw new Error(`write refused ${writes}`); } };
  const failed = (error) => errorToasts(document).show(error.message, "", "notices-file", "notices-file");
  stops.push(await openNotices({ host, failed }));
  store.show({ kind: "info", title: "one change" });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(writes, 1, "a refusal whose message differs is still one failure of one write");
});
