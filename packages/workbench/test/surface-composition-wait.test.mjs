import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { registerPlugin } from "../registry.js";
import { recordOrigin } from "../tab-reports.js";
import { setSurfaceTextSize } from "../text-size.js";

setSurfaceTextSize(() => 1);

// Every core command waits for the composition declaration of the visible native surfaces before it replies. A surface whose mount failed does not declare one,
// so that wait must end with the mount error.
test("a native surface whose module fails to mount ends its composition wait with the mount error", { timeout: 5000 }, async (t) => {
  const dom = new JSDOM("<main><div id=slot></div></main>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  const actualHost = await import("../host.js");
  t.mock.module("../host.js", { exports: {
    ...actualHost, native: true, onSurfacePrepared: () => () => {},
  } });
  const { mountSurface, authorizeSurface, waitSurfaceCompositionDeclared } =
    await import("../surface-modules.js?composition-wait");
  const pluginId = "fixture-composition-wait";
  const surfaceId = "fixture-composition-wait-surface";
  recordOrigin(surfaceId, null);
  registerPlugin({ id: pluginId, surface: () => null });
  const module = `data:text/javascript,${encodeURIComponent(`export async function mount() {
    throw new Error("fixture mount failed");
  }`)}`;
  const mounting = mountSurface(document.querySelector("#slot"), {
    module, surfaceId, pluginId, declarations: { status: [], commands: [], dom: [] }, sidecars: [],
    composition: { kind: "hybrid" },
  });
  try {
    authorizeSurface(surfaceId);
    await assert.rejects(mounting, /fixture mount failed/);
    await assert.rejects(waitSurfaceCompositionDeclared(surfaceId), /fixture mount failed/);
  } finally {
    // The release of a failed mount is checked by surface-dispose-failed.test.mjs.
    dom.window.close();
  }
});
