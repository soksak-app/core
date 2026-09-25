// 설정 창의 세트 편집과 배치 값 설정(docs/spec/settings.md).
import test from "node:test";
import assert from "node:assert/strict";
import { changeRow, chooseLink, createSet, deleteSet, resolveSidebar, updateSet } from "../sidebar-sets.js";
import { matchPlugins } from "../plugin-search.js";
import { LAYOUT_RANGES, defaults, set, setPluginSettings, setSidebarDefaults } from "../settings.js";

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
  assert.equal(defaults.sidebarWidth, 190);
  assert.equal(Object.hasOwn(defaults, "railWidth"), false, "the rail starts at sidebarWidth");
  // 세 값은 한 범위를 함께 쓰므로 같은 값이 같은 슬라이더 위치에 놓인다.
  assert.deepEqual(LAYOUT_RANGES, { sidebarMinWidth: [60, 800], sidebarMaxWidth: [60, 800], sidebarWidth: [60, 800] });
});

test("a layout value outside its range or order is rejected before anything changes", () => {
  assert.throws(() => set({ sidebarMinWidth: 8 }, "common"), /sidebarMinWidth/);
  assert.throws(() => set({ railWidth: 190 }, "common"), /Unknown setting: railWidth/);
  assert.throws(() => set({ sidebarMinWidth: 200 }, "common"), /sidebarMinWidth .*sidebarWidth .*sidebarMaxWidth/);
  assert.throws(() => set({ sidebarWidth: 500 }, "common"), /sidebarMinWidth .*sidebarWidth .*sidebarMaxWidth/);
  assert.throws(() => set({ sidebarWidth: 1.5 }, "common"), /sidebarWidth/);
});

test("a created set takes the smallest unused number, the list layout, and no sections", () => {
  const next = createSet(sets);
  assert.deepEqual(next.at(-1), { id: "set-2", title: "새 세트", sections: [], layout: "list" });
  assert.deepEqual(next.slice(0, 2), sets);
});

test("an update changes the title or the layout only", () => {
  let next = updateSet(sets, "set-1", { title: "파일" });
  assert.equal(next[0].title, "파일");
  next = updateSet(next, "set-1", { layout: "tabs" });
  assert.equal(next[0].layout, "tabs");
  assert.deepEqual(sets[0], { id: "set-1", title: "탐색기", sections: ["alpha.one"], layout: "list" }, "the update must not change the given list");
  assert.throws(() => updateSet(sets, "set-1", { layout: "grid" }), /layout/);
  assert.throws(() => updateSet(sets, "set-1", { title: "" }), /title/);
  assert.throws(() => updateSet(sets, "set-1", { title: "가".repeat(41) }), /title/);
  assert.throws(() => updateSet(sets, "set-9", { title: "x" }), /set-9/);
  assert.throws(() => updateSet(sets, "set-1", { sections: ["alpha.two"] }), /unknown field sections/);
});

test("section rows choose, move, remove, and add sections without repeating one", () => {
  const registered = ["alpha.one", "alpha.two", "beta.one"];
  const start = [{ id: "set-1", title: "묶음", sections: ["alpha.one", "beta.one"], layout: "list" }];
  const rows = (list) => list[0].sections;
  assert.deepEqual(rows(changeRow(start, "set-1", { action: "choose", index: 0, section: "alpha.two" }, registered)),
    ["alpha.two", "beta.one"]);
  assert.deepEqual(rows(changeRow(start, "set-1", { action: "up", index: 1 }, registered)), ["beta.one", "alpha.one"]);
  assert.deepEqual(rows(changeRow(start, "set-1", { action: "down", index: 0 }, registered)), ["beta.one", "alpha.one"]);
  assert.deepEqual(rows(changeRow(start, "set-1", { action: "remove", index: 0 }, registered)), ["beta.one"]);
  assert.deepEqual(rows(changeRow(start, "set-1", { action: "add" }, registered)), ["alpha.one", "beta.one", "alpha.two"]);
  assert.deepEqual(rows(start), ["alpha.one", "beta.one"], "a row change must not change the given list");
  assert.throws(() => changeRow(start, "set-1", { action: "choose", index: 0, section: "beta.one" }, registered),
    /section beta.one is already in set set-1/);
  assert.throws(() => changeRow(start, "set-1", { action: "up", index: 0 }, registered), /row 0 cannot move up/);
  assert.throws(() => changeRow(start, "set-1", { action: "down", index: 1 }, registered), /row 1 cannot move down/);
  assert.throws(() => changeRow(start, "set-1", { action: "remove", index: 5 }, registered), /no row 5/);
  assert.throws(() => changeRow(start, "set-1", { action: "choose", index: 0, section: "gamma.one" }, registered), /unknown section gamma.one/);
  const full = [{ ...start[0], sections: [...registered] }];
  assert.throws(() => changeRow(full, "set-1", { action: "add" }, registered), /set set-1 already contains every registered section/);
  assert.throws(() => changeRow(start, "set-1", { action: "jump" }, registered), /unknown row action jump/);
});

test("the plugin search matches id, name, or description without letter case", () => {
  const units = [
    { id: "alpha", name: "셸", description: "명령을 실행하는 셸." },
    { id: "beta", name: "브라우저", description: "Web pages in a document region." },
  ];
  assert.deepEqual(matchPlugins(units, "").map((u) => u.id), ["alpha", "beta"]);
  assert.deepEqual(matchPlugins(units, "ALP").map((u) => u.id), ["alpha"]);
  assert.deepEqual(matchPlugins(units, "브라우").map((u) => u.id), ["beta"]);
  assert.deepEqual(matchPlugins(units, "web").map((u) => u.id), ["beta"]);
  assert.deepEqual(matchPlugins(units, "없음"), []);
});

test("deleting a set removes its links in the same change", () => {
  const next = deleteSet(sets, links, "set-3");
  assert.deepEqual(next.sets.map((s) => s.id), ["set-1"]);
  assert.deepEqual(next.links, [links[0]]);
  assert.throws(() => deleteSet(sets, links, "set-9"), /set-9/);
});

test("a stored set or link that breaks the sidebars rules is rejected before anything changes", () => {
  setPluginSettings([{ id: "alpha", surface: {}, sections: [{ id: "alpha.one", name: "하나", module: "ui/one.js" }] }]);
  setSidebarDefaults({ sets: [{ id: "set-1", title: "묶음", sections: ["alpha.one"], layout: "list" }], links: [] });
  const stored = (change) => { const value = structuredClone(defaults.sets); change(value); return value; };
  assert.throws(() => set({ sets: stored((v) => { v[0].sections = ["alpha.gone"]; }) }, "common"),
    /settings: set set-1 names unknown section alpha.gone/);
  assert.throws(() => set({ sets: stored((v) => { v[0].layout = "grid"; }) }, "common"), /layout must be list or tabs/);
  assert.throws(() => set({ sets: stored((v) => { v[0].title = ""; }) }, "common"), /title must be 1 to 40/);
  assert.throws(() => set({ links: [{ place: "left", plugin: null, set: "set-9" }] }, "common"), /known set/);
  assert.throws(() => set({ links: [{ place: "rail", plugin: "beta", set: "set-1" }] }, "common"), /plugin beta without a surface/);
});

test("a plugin's left or right choice takes precedence over the general choice", () => {
  const two = [{ id: "set-a", title: "A", sections: [], layout: "list" }, { id: "set-b", title: "B", sections: [], layout: "list" }];
  const shown = (links, plugin) => resolveSidebar(links, two, "right", plugin)?.id ?? null;
  // 일반 사용 안 함 + 플러그인 세트 → 보인다.
  let links = chooseLink([], "right", "alpha", "set-b");
  assert.equal(shown(links, "alpha"), "set-b");
  assert.equal(shown(links, "beta"), null);
  // 일반 세트 + 플러그인 사용 안 함 → 숨는다.
  links = chooseLink(chooseLink([], "right", null, "set-a"), "right", "alpha", "off");
  assert.deepEqual(links.find((l) => l.plugin === "alpha"), { place: "right", plugin: "alpha", set: null });
  assert.equal(shown(links, "alpha"), null);
  assert.equal(shown(links, "beta"), "set-a");
  // 플러그인 일반 따름 → 일반 세트.
  links = chooseLink(links, "right", "alpha", "inherit");
  assert.equal(links.some((l) => l.plugin === "alpha"), false);
  assert.equal(shown(links, "alpha"), "set-a");
  // 일반 사용 안 함은 일반 연결을 뺀다.
  assert.deepEqual(chooseLink(links, "right", null, "off"), []);
  assert.throws(() => chooseLink([], "left", null, "inherit"), /inherit/);
  assert.throws(() => chooseLink([], "rail", "alpha", "inherit"), /inherit/);
  assert.deepEqual(chooseLink(chooseLink([], "rail", "alpha", "set-a"), "rail", "alpha", "off"), []);
  assert.equal(resolveSidebar([{ place: "rail", plugin: "alpha", set: "set-a" }], two, "rail", "alpha").id, "set-a");
});

test("the sidebar position defaults to the inset sidebar", () => {
  assert.equal(defaults.rail, "inset");
});
