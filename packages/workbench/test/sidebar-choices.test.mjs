// 사이드바마다 고른 탭과 접은 섹션이 스페이스에 저장되고 다시 적용되는지 검사한다(docs/spec/projects.md#persistence).
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<body></body>", { url: "https://example.test/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.ErrorEvent = dom.window.ErrorEvent;
globalThis.dispatchEvent = () => true;

const { registry } = await import("../exposure.js");
const { registerSection } = await import("../registry.js");
const sections = await import("../sidebar-sections.js");

registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);
const empty = `data:text/javascript,${encodeURIComponent("export function mount() { return { dispose() {} }; }")}`;
registerSection({ id: "probe.one", name: "하나", module: empty });
registerSection({ id: "probe.two", name: "둘", module: empty });

test("the selected tab and folded sections are reported for saving and restored from a saved space", () => {
  const tabs = document.createElement("div");
  const list = document.createElement("div");
  tabs.className = "set";
  list.className = "set";
  document.body.append(tabs, list);
  const context = { card: null, surface: null };
  sections.drawSet(tabs, "rail-probe", { id: "set-t", title: "T", sections: ["probe.one", "probe.two"], layout: "tabs" }, context);
  sections.drawSet(list, "left", { id: "set-l", title: "L", sections: ["probe.one", "probe.two"], layout: "list" }, context);
  let saved = 0;
  sections.onChoicesChange(() => { saved++; });

  sections.selectSection("rail-probe", "probe.two");
  sections.foldSection("left", "probe.one");
  assert.equal(saved, 2, "a user choice did not ask the space to be saved");
  const choices = sections.sidebarChoices();
  assert.deepEqual(choices, { "rail-probe": { tab: "probe.two", folded: [] }, left: { tab: null, folded: ["probe.one"] } });

  sections.restoreSidebarChoices({});
  const state = () => Object.fromEntries(sections.sidebarsState().map((bar) =>
    [bar.sidebar, { tab: bar.tab, folded: bar.sections.filter((s) => s.folded).map((s) => s.id) }]));
  assert.deepEqual(state().left.folded, []);
  sections.restoreSidebarChoices(choices);
  assert.deepEqual(state(), { "rail-probe": { tab: "probe.two", folded: [] }, left: { tab: null, folded: ["probe.one"] } });
  assert.equal(saved, 2, "restoring a saved space asked for another save");
});
