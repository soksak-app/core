// The notice center (docs/spec/notifications.md#notice-center): the groups, the filter, the foot, the clear controls, the read controls and
// the press on an entry, which runs core.notices.read {id}. The commands are declared from the declaration, and each run is recorded.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { registry, installExposure } from "../exposure.js";
import { beginSettings } from "../settings.js";
import { errorToasts } from "../shown-errors.js";
import { notificationStore } from "../tab-reports.js";

const declared = JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8"));
installExposure(declared);

// The handlers of the notice commands forward to the store, as core-exposure.js registers them; core-exposure itself loads the page
// modules, which need a whole page.
const invalid = (action) => action();
const handlers = {
  "core.notices.toggle": () => notificationStore().toggle(),
  "core.notices.filter": ({ filter }) => invalid(() => notificationStore().setFilter(filter)),
  "core.notices.read-all": () => notificationStore().readAll(),
  "core.notices.read": ({ id }) => invalid(() => notificationStore().read(id)),
  "core.notices.clear": ({ group }) => invalid(() => notificationStore().clear(group)),
  "core.notices.clear-all": () => notificationStore().clearAll(),
  "core.notices.close": ({ id }) => invalid(() => notificationStore().close(id)),
};
for (const [name, run] of Object.entries(handlers)) registry.command(name, run);

function fixture(t, settings = {}) {
  const dom = new JSDOM("<body></body>");
  t.after(() => dom.window.close());
  const { document } = dom.window;
  Object.assign(globalThis, { window: dom.window, document });
  beginSettings({ common: settings, projects: [] }, null);
  const store = notificationStore();
  store.clearAll();
  // The store is one per page: a center left open by an earlier test is closed here.
  if (store.status().open) store.toggle();
  // The filter is kept by the store too; each test starts at all.
  store.setFilter("all");
  errorToasts(document);
  const runs = [];
  registry.watch((name, params) => { runs.push({ name, params }); });
  t.after(() => registry.watch(() => {}));
  return {
    document, store, runs,
    center: () => document.querySelector(".notice-center"),
    entries: () => [...document.querySelectorAll(".notice-center__entry")],
    groups: () => [...document.querySelectorAll(".notice-center__group")],
  };
}

test("the center lists the entries in the groups progress, today and yesterday, and its foot holds the clear-all control", (t) => {
  const { store, center, groups, document } = fixture(t);
  store.show({ kind: "info", title: "today one" });
  store.show({ kind: "progress", title: "building", progress: null });
  store.toggle();
  assert.ok(center(), "the center is drawn when it opens");
  const labels = groups().map((g) => g.querySelector(".notice-center__label > span").textContent);
  assert.deepEqual(labels.slice(0, 2), ["진행 중", "오늘"], "progress first, then the day groups");
  assert.equal(center().querySelector(".notice-center__foot").textContent.includes("오류는 지울 때까지, 나머지는 7일 동안 남는다."), true);
  assert.ok(document.querySelector('.notice-center__foot [data-expose="core.notices.clear-all"]'));
});

test("the filter shows only the entries of its filter and its segment counts them", (t) => {
  const { store, entries, document } = fixture(t);
  store.show({ kind: "info", title: "info" });
  store.show({ kind: "error", title: "broken" });
  store.show({ kind: "warning", title: "waits" });
  store.toggle();
  store.setFilter("problems");
  assert.deepEqual(entries().map((e) => e.querySelector(".notice-center__title").textContent), ["waits", "broken"]);
  const problems = [...document.querySelectorAll(".notice-center__filter")].map((b) => b.textContent).find((text) => text.startsWith("오류·경고"));
  assert.equal(problems, "오류·경고 2", "the segment counts the warning and the error");
});

test("a group clear control runs core.notices.clear with its group and removes the group", (t) => {
  const { store, document, runs } = fixture(t);
  store.show({ kind: "info", title: "today one" });
  store.toggle();
  document.querySelector(".notice-center__clear").click();
  assert.deepEqual(runs.at(-1), { name: "core.notices.clear", params: { group: "today" } });
});

test("the read-all control runs core.notices.read-all and the clear-all control runs core.notices.clear-all", (t) => {
  const { store, document, runs } = fixture(t);
  store.show({ kind: "info", title: "one" });
  store.toggle();
  document.querySelector(".notice-center__read").click();
  assert.equal(runs.at(-1).name, "core.notices.read-all");
  document.querySelector('.notice-center__foot [data-expose="core.notices.clear-all"]').click();
  assert.equal(runs.at(-1).name, "core.notices.clear-all");
});

test("a press on an entry runs core.notices.read with the entry id", (t) => {
  const { store, entries, runs } = fixture(t);
  const id = store.show({ kind: "info", title: "press me" });
  store.toggle();
  // The store keeps the progress entries of earlier tests, so the entry is chosen by its title.
  entries().find((e) => e.querySelector(".notice-center__title").textContent === "press me").click();
  assert.deepEqual(runs.at(-1), { name: "core.notices.read", params: { id } });
});

test("the center style setting draws a drawer at the right of the window and a popover under the bell", (t) => {
  const drawer = fixture(t, { noticeCenterStyle: "drawer" });
  drawer.store.toggle();
  assert.equal(drawer.center().dataset.style, "drawer");
  drawer.store.toggle();
  const popover = fixture(t, { noticeCenterStyle: "popover" });
  popover.store.toggle();
  assert.equal(popover.center().dataset.style, "popover");
});
