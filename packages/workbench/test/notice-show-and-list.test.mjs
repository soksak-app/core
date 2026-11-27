// core.notices.show {id} opens the center on an entry, and core.toasts.list {open} shows the other toasts of the line form as a
// column (docs/spec/notifications.md#commands-and-statuses). Escape closes the list before the center.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { installExposure } from "../exposure.js";
import { beginSettings } from "../settings.js";
import { errorToasts } from "../shown-errors.js";
import { notificationStore } from "../tab-reports.js";

installExposure(JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")));

function fixture(t, toastStyle = "card") {
  const dom = new JSDOM("<body></body>");
  t.after(() => dom.window.close());
  const { document } = dom.window;
  Object.assign(globalThis, { window: dom.window, document });
  // jsdom has no layout, so it has no scrollIntoView; the scroll is recorded here and its drawn position is left to a window check.
  const scrolls = [];
  dom.window.Element.prototype.scrollIntoView = function scrollIntoView(options) {
    scrolls.push({ id: this.dataset.id, options });
  };
  beginSettings({ common: { toastStyle }, projects: [] }, null);
  const store = notificationStore();
  store.clearAll();
  if (store.status().open) store.toggle();
  store.setFilter("all");
  store.setList(false);
  errorToasts(document);
  return { document, store, scrolls };
}

test("show opens the center and marks the entry as the shown entry", (t) => {
  const { store } = fixture(t);
  const id = store.show({ kind: "error", title: "save failed" });
  store.showEntry(id);
  assert.equal(store.status().open, true);
  assert.equal(store.state.shown, id);
});

test("show refuses an unknown id and names it", (t) => {
  const { store } = fixture(t);
  assert.throws(() => store.showEntry("notice-999"), (error) => error instanceof RangeError && error.message.includes("notice-999"));
  assert.equal(store.status().open, false);
});

test("the list shows the other toasts of the line form as a column, newest first, and reports listOpen", (t) => {
  const { document, store } = fixture(t, "line");
  store.show({ kind: "error", title: "first" });
  store.show({ kind: "error", title: "second" });
  store.show({ kind: "error", title: "third" });
  assert.equal(store.toastStatus().listOpen, false);
  assert.equal(document.querySelectorAll("#toasts .toast").length, 1, "the line shows one toast");
  store.setList(true);
  assert.equal(store.toastStatus().listOpen, true);
  const titles = [...document.querySelectorAll("#toasts .toast .toast__title")].map((node) => node.textContent);
  assert.deepEqual(titles, ["third", "second", "first"]);
  store.setList(false);
  assert.equal(document.querySelectorAll("#toasts .toast").length, 1);
});

test("the counter of the line form runs core.toasts.list with the opposite of the list state", (t) => {
  const { document, store } = fixture(t, "line");
  store.show({ kind: "error", title: "first" });
  store.show({ kind: "error", title: "second" });
  const counter = document.querySelector("#toasts .toast__more");
  assert.equal(counter.dataset.command, "core.toasts.list");
  assert.deepEqual(JSON.parse(counter.dataset.params), { open: true });
  store.setList(true);
  assert.deepEqual(JSON.parse(document.querySelector("#toasts .toast__more").dataset.params), { open: false });
});

test("an error toast offers the Details action that runs core.notices.show with its id, and a warning offers none", (t) => {
  const { document, store } = fixture(t);
  const error = store.show({ kind: "error", title: "save failed" });
  store.show({ kind: "warning", title: "disk low" });
  const buttons = (title) => [...document.querySelectorAll("#toasts .toast")].find((node) => node.querySelector(".toast__title").textContent === title).querySelectorAll(".toast__actions button");
  const more = [...buttons("save failed")].find((b) => b.textContent === "자세히");
  assert.equal(more.dataset.command, "core.notices.show");
  assert.deepEqual(JSON.parse(more.dataset.params), { id: error });
  assert.equal([...buttons("disk low")].some((b) => b.textContent === "자세히"), false);
});

test("Escape closes the list before it closes the center", (t) => {
  const { document, store } = fixture(t, "line");
  store.show({ kind: "error", title: "first" });
  store.show({ kind: "error", title: "second" });
  store.toggle();
  store.setList(true);
  document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" }));
  assert.equal(store.toastStatus().listOpen, false);
  assert.equal(store.status().open, true, "the center stays open while the list closes");
  document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" }));
  assert.equal(store.status().open, false);
});

test("core.notices reports the shown entry, and null while no entry is marked or the marked entry is removed", (t) => {
  const { store } = fixture(t);
  const id = store.show({ kind: "error", title: "save failed" });
  assert.equal(store.status().shown, null);
  store.showEntry(id);
  assert.equal(store.status().shown, id);
  store.clearAll();
  assert.equal(store.status().shown, null);
});

test("show marks the drawn entry of the center as the shown entry", (t) => {
  const { document, store, scrolls } = fixture(t);
  errorToasts(document).place(document.body);
  const id = store.show({ kind: "error", title: "save failed" });
  store.showEntry(id);
  const entry = document.querySelector(`.notice-center__entry[data-id="${id}"]`);
  assert.ok(entry, "the center draws the entry");
  assert.equal(entry.dataset.shown, "true");
  assert.deepEqual(scrolls.at(-1), { id, options: { block: "nearest" } }, "the center asks for the entry to scroll into view");
});
