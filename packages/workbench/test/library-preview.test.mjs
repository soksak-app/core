import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

// 라이브러리 미리보기는 저장 배치를 여는 것과 같은 검사로 받아들이거나 거부한다.
globalThis.document = new JSDOM("<body></body>").window.document;
const environmentFile = {
  runtime: "runtime",
  workspace: { focus: "main", grid: { xs: [0, 1], ys: [0, 1], cards: [
    { id: "main", c0: 0, c1: 1, r0: 0, r1: 1, tabs: [{ plugin: "probe", title: "p" }] },
  ] } },
  sidebars: { sets: [], links: [] },
};
const manifest = {
  id: "probe", name: "Probe", description: "검사용 표면.", mark: "P", icon: "<path d='M0 0h1v1H0z'/>",
  surface: { module: "ui/surface.js", composition: { kind: "dom" } },
};

const { installEnvironment } = await import("../environment.js");
installEnvironment(environmentFile, { plugins: [{ id: "probe", package: "@fixture/probe", version: "0.0.1", manifest }] });
const { preview } = await import("../library-preview.js");

const project = (plugin) => ({
  activeSpaceId: "space",
  spaces: [{ id: "space", layout: { focusedId: "main", named: 1, state: { xs: [0, 1], ys: [0, 1], cards: [
    { id: "main", c0: 0, c1: 1, r0: 0, r1: 1, data: { activeId: "tab-a", tabs: [{ id: "tab-a", plugin, title: "a" }] } },
  ] } } }],
});

test("a library preview of a layout in an earlier form names projects.json and what it found", () => {
  const stored = project("probe");
  stored.root = "/work/a";
  stored.spaces[0].layout.state.cards[0].data.panels = {};
  const el = preview(stored);
  assert.equal(el.dataset.previewError, "projects.json: project /work/a space space: card main stores panels, an earlier form of sidebars");
});

test("a library preview draws a saved layout of registered plugins", () => {
  const el = preview(project("probe"));
  assert.equal(el.dataset.previewError, undefined);
  assert.deepEqual([...el.querySelectorAll(".library-preview__pane")].map((pane) => pane.dataset.plugin), ["probe"]);
});

test("a library preview draws a tab of a plugin that is not loaded as a placeholder pane", () => {
  const el = preview(project("gone"));
  assert.equal(el.dataset.previewError, undefined, el.dataset.previewError);
  const panes = [...el.querySelectorAll(".library-preview__pane")];
  assert.deepEqual(panes.map((pane) => [pane.dataset.plugin, pane.dataset.placeholder]), [["gone", "true"]]);
});
