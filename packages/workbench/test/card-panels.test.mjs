// 카드 사방 패널의 상태 모델을 검사한다(V5-115, docs/spec/example-model.md).
// 지정은 카드 데이터이고 활성 탭에서 다시 계산되지 않는다 — 연동 차단이 이 검사의 핵심 주장이다.
import assert from "node:assert/strict";
import test from "node:test";

const moduleUrl = new URL("../card-panels.js", import.meta.url);

const panels = await import(moduleUrl);
const {
  PANEL_SIDES, panelState, effectivePanel, resolvePanelSet, setPanel, togglePanel, sizePanel, panelsReport,
} = panels;

const DEFAULTS = { size: 190, min: 120, max: 480 };
const SETS = {
  "set-a": { id: "set-a", title: "A", sections: [], layout: "list" },
  "set-b": { id: "set-b", title: "B", sections: [], layout: "list" },
};
// 플러그인 id 를 이름하지 않는다(경계 계약) — 패널 상태는 활성 탭의 정체와 무관하므로
// 검사 카드의 탭은 종류를 문자열 표시로만 구분한다.
const card = () => ({ id: "tab-1", data: { activeId: "tab-1" }, tabs: [
  { id: "tab-1", plugin: "first" }, { id: "tab-2", plugin: "second" },
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
  // dangling: 세트가 삭제되어도 지정은 지워지지 않는다.
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

test("a linked plugin default stands in when the card has no explicit assignment", () => {
  const c = card();
  const linked = { id: "set-c", title: "C", sections: [], layout: "list" };
  // 기본 지정: 명시 지정이 없으면 플러그인 연결이 그 변에 선다.
  assert.deepEqual(effectivePanel(c, "top", DEFAULTS, linked), { set: "set-c", size: 190, collapsed: false });
  assert.equal(effectivePanel(c, "top", DEFAULTS, null), null, "no link and no assignment means no panel");
  // 명시 지정이 우선이다 — 연결과 다른 세트가 그 변에 선다.
  setPanel(c, "top", "set-a", SETS);
  assert.equal(effectivePanel(c, "top", DEFAULTS, linked).set, "set-a");
  // 명시 지정을 해지하면 연결 기본이 다시 선다(지정이 없어진 것이지 패널이 금지된 것이 아니다).
  setPanel(c, "top", "off", SETS);
  assert.equal(effectivePanel(c, "top", DEFAULTS, linked).set, "set-c");
});
