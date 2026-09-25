// 설정 창의 세트 편집과 배치 값 설정(docs/spec/settings.md).
import test from "node:test";
import assert from "node:assert/strict";
import { createSet, deleteSet, updateSet } from "../sidebar-sets.js";
import { defaults, set } from "../settings.js";

const sets = [
  { id: "set-1", title: "탐색기", sections: ["alpha.one"], layout: "list" },
  { id: "set-3", title: "셸", sections: ["beta.one"], layout: "tabs" },
];
const links = [
  { place: "left", plugin: null, set: "set-1" },
  { place: "rail", plugin: "beta", set: "set-3" },
];

test("the compositing test values are not settings", () => {
  assert.equal(Object.hasOwn(defaults, "latency"), false);
  assert.equal(Object.hasOwn(defaults, "skew"), false);
});

test("the layout values are settings with the former constants as defaults", () => {
  assert.equal(defaults.sidebarMinWidth, 120);
  assert.equal(defaults.sidebarMaxWidth, 480);
  assert.equal(defaults.sidebarWidth, 120);
  assert.equal(defaults.sidebarFoldedWidth, 28);
  assert.equal(defaults.railWidth, 190);
});

test("a layout value outside its range or order is rejected before anything changes", () => {
  assert.throws(() => set({ sidebarFoldedWidth: 8 }, "common"), /sidebarFoldedWidth/);
  assert.throws(() => set({ sidebarMinWidth: 200 }, "common"), /sidebarMinWidth .*sidebarWidth .*sidebarMaxWidth/);
  assert.throws(() => set({ sidebarWidth: 500 }, "common"), /sidebarMinWidth .*sidebarWidth .*sidebarMaxWidth/);
  assert.throws(() => set({ railWidth: 1.5 }, "common"), /railWidth/);
});

test("a created set takes the smallest unused number, the list layout, and no sections", () => {
  const next = createSet(sets);
  assert.deepEqual(next.at(-1), { id: "set-2", title: "새 세트", sections: [], layout: "list" });
  assert.deepEqual(next.slice(0, 2), sets);
});

test("an update changes the title, the layout, or one section", () => {
  let next = updateSet(sets, "set-1", { title: "파일" });
  assert.equal(next[0].title, "파일");
  next = updateSet(next, "set-1", { layout: "tabs" });
  assert.equal(next[0].layout, "tabs");
  next = updateSet(next, "set-1", { section: "alpha.two", on: true });
  assert.deepEqual(next[0].sections, ["alpha.one", "alpha.two"]);
  next = updateSet(next, "set-1", { section: "alpha.one", on: false });
  assert.deepEqual(next[0].sections, ["alpha.two"]);
  assert.deepEqual(sets[0].sections, ["alpha.one"], "the update must not change the given list");
  assert.throws(() => updateSet(sets, "set-1", { layout: "grid" }), /layout/);
  assert.throws(() => updateSet(sets, "set-1", { title: "" }), /title/);
  assert.throws(() => updateSet(sets, "set-1", { title: "가".repeat(41) }), /title/);
  assert.throws(() => updateSet(sets, "set-9", { title: "x" }), /set-9/);
});

test("deleting a set removes its links in the same change", () => {
  const next = deleteSet(sets, links, "set-3");
  assert.deepEqual(next.sets.map((s) => s.id), ["set-1"]);
  assert.deepEqual(next.links, [links[0]]);
  assert.throws(() => deleteSet(sets, links, "set-9"), /set-9/);
});
