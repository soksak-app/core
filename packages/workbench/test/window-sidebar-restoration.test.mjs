import assert from "node:assert/strict";
import test from "node:test";

// The stored layout check and the restoration of the window sidebar record are tested through the exported functions of each module.
const environmentFile = {
  runtime: "runtime",
  workspace: { focus: "main", grid: { xs: [0, 1], ys: [0, 1], cards: [
    { id: "main", c0: 0, c1: 1, r0: 0, r1: 1, tabs: [{ plugin: "pane", title: "p" }] },
  ] } },
  sidebars: { sets: [], links: [] },
};
const manifest = {
  id: "pane", name: "Pane", description: "검사용 표면.", mark: "P", icon: "<path d='M0 0h1v1H0z'/>",
  surface: { composition: { kind: "view", page: "ui/page.html", regions: [{ name: "page", kind: "document", input: "native" }], overlays: [] } },
};

const { installEnvironment } = await import("../environment.js");
installEnvironment(environmentFile, { plugins: [{ id: "pane", package: "@fixture/pane", version: "0.0.1", manifest }] });
const { checkStoredLayout } = await import("../stored-layout.js");
const { restoreWindowSidebars } = await import("../window-sidebars.js");

test("saved window state rejects obsolete and unknown cards before replacing the displayed layout", () => {
  for (const card of [{ id: "rail-pane" }, { id: "window:missing:left" },
    { id: "a", data: { tabs: [{ id: "t", plugin: "pane" }], activeId: "missing" } }]) {
    assert.throws(() => checkStoredLayout({ state: { cards: [card] }, windowSidebars: {} }), /stored|obsolete|unknown/);
  }
  checkStoredLayout({ state: { cards: [{ id: "a", data: { tabs: [{ id: "t", plugin: "pane" }], activeId: "t" } }] }, windowSidebars: {} });
  // A tab of a plugin that is not loaded opens as a placeholder (docs/spec/plugins.md).
  checkStoredLayout({ state: { cards: [{ id: "a", data: { tabs: [{ id: "t", plugin: "missing" }], activeId: "t" } }] }, windowSidebars: {} });
});

test("a stored layout in an earlier form is refused with what it found", () => {
  const card = (data) => ({ id: "a", data: { tabs: [{ id: "t", plugin: "pane" }], activeId: "t", ...data } });
  assert.throws(() => checkStoredLayout({ state: { cards: [card({ panels: {} })] }, windowSidebars: {} }),
    /^Error: card a stores panels, an earlier form of sidebars$/);
  assert.throws(() => checkStoredLayout({ state: { cards: [card({ sidebar: { width: 190 } })] }, windowSidebars: {} }),
    /^Error: card a stores sidebar, an earlier form of sidebars$/);
  assert.throws(() => checkStoredLayout({ state: { cards: [card({})] }, windowSidebars: {}, sidebars: { a: { tab: null, folded: [] } } }),
    /^Error: sidebar choice a names card a, an earlier form of a:left$/);
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
