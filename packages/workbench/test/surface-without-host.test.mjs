// A document without a host does not mount a surface that needs a host (a view that declares a sidecar) and draws a placeholder.
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { registerPlugin } from "../registry.js";

registerPlugin({ id: "fixture-host", name: "Probe", surface: () => null });
const { setSurfaceTextSize } = await import("../text-size.js");
setSurfaceTextSize(() => 1);

test("a view that declares a sidecar shows a placeholder without a host", async () => {
  const dom = new JSDOM("<main><div id=slot></div></main>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  const { mountSurface } = await import("../surface-modules.js");
  const states = [];
  await mountSurface(document.querySelector("#slot"),
    { surfaceId: "tab-sidecar", pluginId: "fixture-host", sidecars: ["@scope/sidecar-probe"],
      composition: { kind: "view", page: "ui/view.html", regions: [], overlays: [] } }, { onState: (state) => states.push(state.phase) });
  const placeholder = document.querySelector("#slot .surface-placeholder");
  assert.equal(placeholder?.textContent, "Probe 표면은 네이티브 호스트가 있어야 열립니다");
  assert.deepEqual(states, ["ready"]);
  const { disposeSurfacesExcept, waitSurfaceCompositionDeclared } = await import("../surface-modules.js");
  await waitSurfaceCompositionDeclared("tab-sidecar");
  await disposeSurfacesExcept(new Set());
  assert.equal(document.querySelector("#slot .surface-placeholder"), null, "removing the tab removes its placeholder");
  dom.window.close();
});
