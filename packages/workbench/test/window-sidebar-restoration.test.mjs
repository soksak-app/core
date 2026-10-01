import assert from "node:assert/strict";
import test from "node:test";

// 저장 배치 검사와 창 사이드바 기록 복원은 각 모듈의 내보낸 함수로 검사한다.
globalThis.fetch = async (path) => {
  const files = {
    "/environment.json": {
      runtime: "runtime",
      workspace: { focus: "main", grid: { xs: [0, 1], ys: [0, 1], cards: [
        { id: "main", c0: 0, c1: 1, r0: 0, r1: 1, tabs: [{ plugin: "pane", title: "p" }] },
      ] } },
      sidebars: { sets: [], links: [] },
    },
    "/installed-plugins.json": { plugins: [{ id: "pane", package: "@fixture/pane", version: "0.0.1" }] },
    "/modules/@fixture/pane/plugin.json": {
      id: "pane", name: "Pane", description: "검사용 표면.", mark: "P", icon: "<path d='M0 0h1v1H0z'/>",
      surface: { module: "ui/surface.js", composition: { kind: "dom" } },
    },
  };
  const body = files[path];
  return body ? { ok: true, json: async () => structuredClone(body) } : { ok: false, status: 404 };
};

const { loadEnvironment } = await import("../environment.js");
await loadEnvironment();
const { checkStoredLayout } = await import("../stored-layout.js");
const { restoreWindowSidebars } = await import("../window-sidebars.js");

test("saved window state rejects obsolete and unknown cards before replacing the displayed layout", () => {
  for (const card of [{ id: "rail-pane" }, { id: "window:missing:left" },
    { id: "a", data: { tabs: [{ id: "t", plugin: "pane" }], activeId: "missing" } }]) {
    assert.throws(() => checkStoredLayout({ state: { cards: [card] }, windowSidebars: {} }), /stored|obsolete|unknown/);
  }
  checkStoredLayout({ state: { cards: [{ id: "a", data: { tabs: [{ id: "t", plugin: "pane" }], activeId: "t" } }] }, windowSidebars: {} });
  // 불러오지 않은 플러그인의 탭은 placeholder 로 열린다(docs/spec/plugins.md).
  checkStoredLayout({ state: { cards: [{ id: "a", data: { tabs: [{ id: "t", plugin: "missing" }], activeId: "t" } }] }, windowSidebars: {} });
});

test("saved obsolete width fields fail even when empty", () => {
  for (const field of ["railWidth", "edgeWidth"]) {
    assert.throws(() => checkStoredLayout({ state: { cards: [] }, [field]: {} }), /obsolete/);
  }
});

test("explicit null sidebars records are rejected instead of becoming empty records", () => {
  assert.throws(() => checkStoredLayout({ state: { cards: [] }, windowSidebars: {}, sidebars: null }), /sidebar/);
});

test("explicit null windowSidebars records are rejected instead of becoming empty records", () => {
  assert.throws(() => restoreWindowSidebars(null), /sidebar/);
});
