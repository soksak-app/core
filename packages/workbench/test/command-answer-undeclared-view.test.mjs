import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { registerPlugin } from "../registry.js";
import { recordOrigin } from "../tab-reports.js";
import { setSurfaceTextSize } from "../text-size.js";

setSurfaceTextSize(() => 1);

// A core command answers after the plane drew the newest layout, and that layout leaves empty the place of a view that has not
// declared its composition (docs/spec/exposure.md#registration, docs/spec/native-surfaces.md#view-surfaces). The answer waits
// for no such declaration: the answer of the drawn wait arrives while one view of the layout has not declared, after the other
// view declared.
test("the drawn wait of a command answers while a view of the layout has not declared", async (t) => {
  const dom = new JSDOM('<main><div id="declared"></div><div id="silent"></div></main>', { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  dom.window.ResizeObserver = class { observe() {} disconnect() {} };
  dom.window.requestAnimationFrame = () => 1;
  dom.window.cancelAnimationFrame = () => {};
  const declared = [];
  const actualHost = await import("../host.js");
  t.mock.module("../host.js", { exports: {
    ...actualHost,
    native: true,
    onSurfacePrepared: () => () => {},
    surfaceContextRuntime: (surface, declarations) => {
      const runtime = actualHost.surfaceContextRuntime(surface, declarations);
      return { ...runtime, native: { ...runtime.native, on: () => Promise.resolve(() => {}), call: async (name) => {
        if (name === "compositionDeclare") declared.push(surface.surfaceId);
        return null;
      } } };
    },
  } });
  const modules = await import("../surface-modules.js?command-answer-undeclared-view");
  const { createPageLayout } = await import("../page-layout.js?command-answer-undeclared-view");
  const view = (id) => {
    recordOrigin(id, null, "test fixture");
    registerPlugin({ id, surface: () => null });
    const slot = document.querySelector(`#${id.split("-").at(-1)}`);
    slot.dataset.nativeSurfaceId = id;
    return { slot, surface: { module: null, surfaceId: id, pluginId: id,
      declarations: { status: [], commands: [], element: [] }, sidecars: [],
      composition: { kind: "view", page: "ui/page.html" } } };
  };
  const declaredView = view("fixture-command-declared");
  const silentView = view("fixture-command-silent");
  const page = createPageLayout({
    document, showError: () => {}, setVerify: () => {}, log: () => {}, surfaces: {}, plane: {}, compositor: {},
    textSize: () => 1, rendered: async () => {}, surfaceUnloaded: () => false,
    waitSurfaceCompositionAnswered: modules.waitSurfaceCompositionAnswered,
  });
  try {
    modules.authorizeSurface(declaredView.surface.surfaceId);
    await modules.mountSurface(declaredView.slot, declaredView.surface);
    // The host never authorizes the other view, so it never declares its composition.
    modules.mountSurface(silentView.slot, silentView.surface);
    await page.drawn();
    assert.deepEqual(declared, ["fixture-command-declared"], "the answer came before the declared view declared");
    assert.equal(modules.compositionState(silentView.surface.surfaceId).state, "pending",
      "the view that does not declare declared its composition");
  } finally {
    await modules.disposeSurface(declaredView.surface.surfaceId);
    await modules.disposeSurface(silentView.surface.surfaceId);
    dom.window.close();
  }
});
