// 호스트가 없는 문서는 호스트가 필요한 표면(사이드카나 혼합 합성을 선언한 표면)을 마운트하지 않고 자리 표시를 그린다.
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { registerPlugin } from "../registry.js";

registerPlugin({ id: "fixture-host", name: "Probe", diagnostics: null, surface: () => null });
const { setSurfaceTextSize } = await import("../text-size.js");
setSurfaceTextSize(() => 1);

const moduleUrl = "data:text/javascript,export function mount(){globalThis.hostSurfaceMounted=true;return {dispose(){}}}";

for (const [label, extra] of [["sidecars", { sidecars: ["@scope/sidecar-probe"], composition: { kind: "dom" } }],
  ["a hybrid composition", { sidecars: [], composition: { kind: "hybrid", regions: {}, overlays: {} } }]]) {
  test(`a surface that declares ${label} shows a placeholder without a host`, async () => {
    const dom = new JSDOM("<main><div id=slot></div></main>", { url: "http://localhost/" });
    globalThis.document = dom.window.document;
    const { mountSurface } = await import("../surface-modules.js");
    const states = [];
    globalThis.hostSurfaceMounted = false;
    await mountSurface(document.querySelector("#slot"),
      { module: moduleUrl, surfaceId: `tab-${label}`, pluginId: "fixture-host", ...extra }, { onState: (state) => states.push(state.phase) });
    assert.equal(globalThis.hostSurfaceMounted, false, "the module was not imported");
    const placeholder = document.querySelector("#slot .surface-placeholder");
    assert.equal(placeholder?.textContent, "Probe 표면은 네이티브 호스트가 있어야 열립니다");
    assert.deepEqual(states, ["ready"]);
    const { disposeSurfacesExcept, focusSurface, waitSurfaceCompositionDeclared } = await import("../surface-modules.js");
    assert.equal(await focusSurface(`tab-${label}`), false, "a placeholder takes no focus");
    await waitSurfaceCompositionDeclared(`tab-${label}`);
    await disposeSurfacesExcept(new Set());
    assert.equal(document.querySelector("#slot .surface-placeholder"), null, "removing the tab removes its placeholder");
    dom.window.close();
  });
}
