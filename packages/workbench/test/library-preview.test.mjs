import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

// 라이브러리 미리보기는 저장 배치를 여는 것과 같은 검사로 받아들이거나 거부한다.
globalThis.document = new JSDOM("<body></body>").window.document;
globalThis.fetch = async (path) => {
  const files = {
    "/environment.json": {
      runtime: "runtime",
      workspace: { focus: "main", grid: { xs: [0, 1], ys: [0, 1], cards: [
        { id: "main", c0: 0, c1: 1, r0: 0, r1: 1, tabs: [{ plugin: "probe", title: "p" }] },
      ] } },
      sidebars: { sets: [], links: [] },
    },
    "/installed-plugins.json": { plugins: [{ id: "probe", package: "@fixture/probe", version: "0.0.1" }] },
    "/modules/@fixture/probe/plugin.json": {
      id: "probe", name: "Probe", description: "검사용 표면.", mark: "P", icon: "<path d='M0 0h1v1H0z'/>",
      surface: { module: "ui/surface.js", composition: { kind: "dom" } },
    },
  };
  const body = files[path];
  return body ? { ok: true, json: async () => structuredClone(body) } : { ok: false, status: 404 };
};

const { loadEnvironment } = await import("../environment.js");
await loadEnvironment();
const { preview } = await import("../library-preview.js");

const project = (plugin) => ({
  activeSpaceId: "space",
  spaces: [{ id: "space", layout: { focusedId: "main", named: 1, state: { xs: [0, 1], ys: [0, 1], cards: [
    { id: "main", c0: 0, c1: 1, r0: 0, r1: 1, data: { activeId: "tab-a", tabs: [{ id: "tab-a", plugin, title: "a" }] } },
  ] } } }],
});

test("a library preview draws a saved layout of registered plugins", () => {
  const el = preview(project("probe"));
  assert.equal(el.dataset.error, undefined);
  assert.deepEqual([...el.querySelectorAll(".library-preview__pane")].map((pane) => pane.dataset.plugin), ["probe"]);
});

test("a library preview draws a tab of a plugin that is not loaded as a placeholder pane", () => {
  const el = preview(project("gone"));
  assert.equal(el.dataset.error, undefined, el.dataset.error);
  const panes = [...el.querySelectorAll(".library-preview__pane")];
  assert.deepEqual(panes.map((pane) => [pane.dataset.plugin, pane.dataset.placeholder]), [["gone", "true"]]);
});
