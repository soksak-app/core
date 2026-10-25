import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

const record = (drawn) => ({
  surfaces: [{ id: "view", dim: false, visible: true,
    surface: { pluginId: "probe", composition: { kind: "view", page: "ui/page.html" } },
    applied: { x: 0, y: 0, w: 3, h: 4 } }],
  settled: true, drawn, titlebar: 40,
});

async function setup(t, surfaceModule, query) {
  const dom = new JSDOM('<div id="plane"></div>');
  globalThis.document = dom.window.document;
  t.mock.module("../surface-modules.js", { namedExports: surfaceModule });
  t.mock.module("../page-log.js", { namedExports: {
    rawConsole: { error: () => {}, info: () => {} }, emitEvent: () => {}, eventEnabled: () => false,
    reportRecord: async () => {}, flushEvents: async () => {},
  } });
  t.mock.module("@soksak/runtime", { namedExports: { windows: {}, host: {
    on: () => {},
    page: (path) => path,
    call: async (name, request) => {
      if (name === "setTheme") return null;
      if (name === "syncSurfaces") return {
        ticket: 1, placements: [], chrome: { controls: { x: 0, y: 0, w: 0, h: 0 }, row: request.titlebar },
      };
      if (name === "presentSurfaces") return request.placements;
      throw new Error(`unexpected host call ${name}`);
    },
  } } });
  const { surfaces } = await import(`../host.js?required-surface-module=${query}`);
  await surfaces.theme({ scheme: "dark", tokens: {} });
  return { dom, surfaces };
}

test("a drawn view fails when its required composition wait is missing", async (t) => {
  const { dom, surfaces } = await setup(t, {
    mountedSurface: () => ({ disposed: false }),
  }, "missing-wait");
  try {
    await assert.rejects(surfaces.place(record(true)), /waitSurfaceCompositionDeclared is not a function/,
      "a missing composition readiness API must not let a view placement proceed");
  } finally {
    dom.window.close();
  }
});

test("an undrawn view fails when its required mount lookup is missing", async (t) => {
  const { dom, surfaces } = await setup(t, {
    waitSurfaceCompositionDeclared: async () => {},
  }, "missing-mounted-surface");
  try {
    await assert.rejects(surfaces.place(record(false)), /mountedSurface is not a function/,
      "a missing mount lookup must not defer a required view without reporting the contract failure");
  } finally {
    dom.window.close();
  }
});
