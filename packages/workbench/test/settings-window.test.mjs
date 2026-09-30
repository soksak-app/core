// 설정 창의 세트 편집과 배치 값 설정(docs/spec/settings.md).
import test from "node:test";
import assert from "node:assert/strict";
import { changeRow, chooseLink, createSet, deleteSet, resolveSidebar, updateSet } from "../sidebar-sets.js";
import { matchPlugins } from "../plugin-search.js";
import { LAYOUT_RANGES, defaults, set, setPluginSettings, setSidebarDefaults, THEMES } from "../settings.js";

const sets = [
  { id: "set-1", title: "탐색기", sections: ["alpha.one"], layout: "list" },
  { id: "set-3", title: "셸", sections: ["beta.one"], layout: "tabs" },
];
const links = [
  { place: "left", plugin: null, set: "set-1" },
  { place: "card-left", plugin: "beta", set: "set-3" },
];

function relativeLuminance(hex) {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255)
    .map((value) => value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

test("every theme rail has measurable selection contrast against its card", () => {
  for (const theme of THEMES) {
    for (const mode of ["dark", "light"]) {
      const colors = theme[mode];
      const card = relativeLuminance(colors.card);
      const rail = relativeLuminance(colors.rail);
      const ratio = (Math.max(card, rail) + 0.05) / (Math.min(card, rail) + 0.05);
      assert.ok(ratio >= 2.4, `${theme.name}/${mode} selection ratio ${ratio.toFixed(2)} is below 2.4`);
    }
  }
});

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

test("the menu language follows the setting, the supported system tag, or the default", async () => {
  // set 의 적용은 문서 루트에 값을 심고 저장소에 쓴다. 검사 문맥에 문서와 저장소가 없으므로
  // 최소한의 루트와 메모리 저장소를 둔다. 질의 문자로 이 검사만 별도의 모듈 사본을 써서
  // 다른 검사의 모듈 상태(저장소 연결 여부)를 오염시키지 않는다.
  const realDocument = globalThis.document;
  globalThis.document = { documentElement: { dataset: {}, style: { setProperty() {} } } };
  const memory = { common: {}, projects: [] };
  try {
    const { MENU_LANGUAGES, connectSettings, menuLanguage, set: change, value } = await import("../settings.js?test=menu-language");
    await connectSettings({
      snapshot: async () => structuredClone(memory),
      settings: async (id, values) => {
        assert.equal(id, null, "common settings carry no project id");
        memory.common = { ...memory.common, ...values };
      },
      onChange: () => () => {},
    });
    assert.equal(value("language"), "auto");
    assert.deepEqual(MENU_LANGUAGES.map(({ id }) => id), ["ko", "en"]);
    // auto 는 시스템 언어의 주 태그를 표에서 찾는다. 검사 문맥의 시스템 언어와 무관하게
    // 표에 있는 태그는 그대로, 없는 태그는 기본 언어로 내려간다.
    assert.ok(["ko", "en"].includes(menuLanguage()), `auto resolves to a declared language: ${menuLanguage()}`);
    await change({ language: "ko" }, "common");
    assert.equal(menuLanguage(), "ko");
    await change({ language: "en" }, "common");
    assert.equal(menuLanguage(), "en");
    assert.throws(() => change({ language: "ja" }, "common"), /Invalid setting language/);
    await change({ language: "auto" }, "common");
    assert.equal(memory.common.language, "auto");
  } finally {
    globalThis.document = realDocument;
  }
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
  // 이름 바꿈(V5-116-1): 낡은 rail 자리는 알 수 없는 자리로 거부된다.
  assert.throws(() => set({ links: [{ place: "rail", plugin: "alpha", set: "set-1" }] }, "common"), /requires a place/);
  assert.throws(() => set({ links: [{ place: "card-left", plugin: "beta", set: "set-1" }] }, "common"), /plugin beta without a surface/);
});

test("window and card choices are independent without inherited focus selection", () => {
  const sets = [{ id: "set-a", title: "A", sections: [], layout: "list" }];
  let links = chooseLink([], "right", null, "set-a");
  links = chooseLink(links,"window-right","alpha","set-a");
  assert.equal(resolveSidebar(links,sets,"right",null).id,"set-a");
  assert.equal(resolveSidebar(links,sets,"window-right","alpha").id,"set-a");
  assert.equal(resolveSidebar(links,sets,"window-right","beta"),null);
  links = chooseLink(links,"window-right","alpha","off");
  assert.equal(resolveSidebar(links,sets,"right",null).id,"set-a");
  assert.equal(resolveSidebar(links,sets,"window-right","alpha"),null);
  assert.throws(()=>chooseLink(links,"right","alpha","set-a"),/invalid plugin/);
  assert.throws(()=>chooseLink(links,"window-right","alpha","inherit"),/inherit/);
  assert.deepEqual(chooseLink(chooseLink([],"card-left","alpha","set-a"),"card-left","alpha","off"),[]);
});

test("the obsolete sidebar positioning setting is absent and rejected",()=>{
  assert.equal(Object.hasOwn(defaults,"cardSidebar"),false);
  assert.throws(()=>set({cardSidebar:"inset"},"common"),/Unknown setting: cardSidebar/);
});
