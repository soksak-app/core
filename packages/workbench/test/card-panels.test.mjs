// 카드 사방 패널의 상태 모델을 검사한다(V5-115, docs/spec/example-model.md).
// 지정은 카드 데이터이고 활성 탭에서 다시 계산되지 않는다 — 연동 차단이 이 검사의 핵심 주장이다.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const moduleUrl = new URL("../card-panels.js", import.meta.url);
const exists = readFileSync(moduleUrl, "utf8").length > 0; // 레드 단계에서는 모듈이 없어 이 줄은 예외를 낸다.

const panels = await import(moduleUrl);
const {
  PANEL_SIDES, panelState, resolvePanelSet, setPanel, togglePanel, sizePanel, panelsReport,
} = panels;

const DEFAULTS = { size: 190, min: 120, max: 480 };
const SETS = {
  "set-a": { id: "set-a", title: "A", sections: [], layout: "list" },
  "set-b": { id: "set-b", title: "B", sections: [], layout: "list" },
};
const card = () => ({ id: "tab-1", data: { activeId: "tab-1" }, tabs: [
  { id: "tab-1", plugin: "terminal" }, { id: "tab-2", plugin: "browser" },
] });

test("a side accepts at most one panel and rejects unknown sides", () => {
  assert.deepEqual(PANEL_SIDES, ["top", "bottom", "left", "right"]);
  const c = card();
  setPanel(c, "top", "set-a", SETS);
  assert.throws(() => setPanel(c, "middle", "set-a", SETS), /unknown panel side/);
});

test("an assigned panel resolves its set and keeps the assignment when the set is gone", () => {
  const c = card();
  setPanel(c, "right", "set-a", SETS);
  assert.equal(resolvePanelSet(c, "right", SETS), SETS["set-a"]);
  // dangling: 세트가 삭제되어도 지정은 지워지지 않는다 — 조용한 삭제 금지.
  assert.equal(resolvePanelSet(c, "right", {}), null);
  assert.equal(panelState(c, "right", DEFAULTS).set, "set-a");
});

test("switching the card's active tab never changes the assigned set", () => {
  const c = card();
  setPanel(c, "left", "set-a", SETS);
  c.data.activeId = "tab-2"; // 활성 탭을 다른 플러그인으로 바꾼다.
  assert.equal(resolvePanelSet(c, "left", SETS), SETS["set-a"]);
  setPanel(c, "bottom", "set-b", SETS);
  c.data.activeId = "tab-1";
  assert.equal(resolvePanelSet(c, "bottom", SETS), SETS["set-b"]);
});

test("toggle and size keep per-side state with the shared bounds", () => {
  const c = card();
  setPanel(c, "top", "set-a", SETS);
  const open = panelState(c, "top", DEFAULTS);
  assert.equal(open.collapsed, false);
  assert.equal(open.size, DEFAULTS.size);
  sizePanel(c, "top", 300, DEFAULTS);
  assert.equal(panelState(c, "top", DEFAULTS).size, 300);
  assert.throws(() => sizePanel(c, "top", 10, DEFAULTS), /120 to 480/);
  assert.throws(() => sizePanel(c, "top", 5000, DEFAULTS), /120 to 480/);
  togglePanel(c, "top");
  const folded = panelState(c, "top", DEFAULTS);
  assert.equal(folded.collapsed, true);
  assert.equal(folded.size, 300, "folding keeps the stored size");
  togglePanel(c, "top");
  assert.equal(panelState(c, "top", DEFAULTS).collapsed, false);
});

test("turning a panel off clears the side and the report omits it", () => {
  const c = card();
  setPanel(c, "right", "set-a", SETS);
  setPanel(c, "bottom", "set-b", SETS);
  const report = panelsReport(c, SETS, DEFAULTS);
  assert.deepEqual(Object.keys(report).sort(), ["bottom", "right"]);
  setPanel(c, "right", "off", SETS);
  assert.deepEqual(panelsReport(c, SETS, DEFAULTS), { bottom: { set: "set-b", size: 190, collapsed: false } });
});

test("an unassigned card reports no panels", () => {
  assert.deepEqual(panelsReport(card(), SETS, DEFAULTS), {});
  assert.equal(panelState(card(), "top", DEFAULTS), null);
});
