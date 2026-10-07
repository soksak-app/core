import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { registerPlugin } from "../registry.js";
import { setSurfaceTextSize } from "../text-size.js";

setSurfaceTextSize(() => 1);

// 렌더 뒤의 표면 포커스는 모듈 준비와 호스트 표시를 기다린다. 그 사이 탭이 닫혀 표면이 해제되면 해제된 모듈의
// focus 를 부르지 않고 포커스를 주지 않았다고 답한다. 해제된 모듈의 그림 영역은 focus 를 거부한다(F91).
test("a surface removed while its focus waits for presentation takes no focus", { timeout: 5000 }, async (t) => {
  const dom = new JSDOM("<main><div id=slot></div></main>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  dom.window.ResizeObserver = class { observe() {} disconnect() {} };
  dom.window.requestAnimationFrame = () => 1;
  dom.window.cancelAnimationFrame = () => {};
  Object.defineProperty(dom.window, "visualViewport", { value: { width: 800, height: 600 } });
  const calls = [];
  globalThis.surfaceFocusCalls = calls;
  let presented;
  const actualHost = await import("../host.js");
  t.mock.module("../host.js", { exports: {
    ...actualHost,
    native: true,
    onSurfacePrepared: () => () => {},
    // 호스트 표시는 검사가 끝낼 때까지 기다린다.
    surfaces: { ...actualHost.surfaces, waitPresented: () => new Promise((resolve) => { presented = resolve; }) },
    surfaceContextRuntime: (surface, declarations) => {
      const runtime = actualHost.surfaceContextRuntime(surface, declarations);
      return { ...runtime, native: { ...runtime.native, on: () => () => {}, call: async (name) => {
        calls.push(name);
        return null;
      } } };
    },
  } });
  const { mountSurface, authorizeSurface, disposeSurface, focusSurface } = await import("../surface-modules.js?focus-dispose");
  const pluginId = "fixture-focus-dispose";
  const surfaceId = "fixture-focus-dispose-surface";
  registerPlugin({ id: pluginId, surface: () => null });
  // 모듈은 터미널처럼 focus 를 그림 영역에 넘긴다.
  const module = `data:text/javascript,${encodeURIComponent(`export async function mount(root, context) {
    root.innerHTML = "<div id=view></div>";
    const composition = await context.composition.create({ regions: { view: root.querySelector("#view") } });
    const image = composition.region("view");
    return { focus: () => image.focus(), dispose: () => composition.dispose() };
  }`)}`;
  const surface = { module, surfaceId, pluginId, declarations: { status: [], commands: [], dom: [] }, sidecars: [],
    composition: { kind: "hybrid", regions: [{ name: "view", kind: "image", sidecar: "fixture-sidecar", input: "dom" }],
      overlays: [] } };
  try {
    authorizeSurface(surfaceId);
    await mountSurface(document.querySelector("#slot"), surface);
    const focused = focusSurface(surfaceId);
    // focusSurface 가 호스트 표시를 기다리기 시작할 때까지 진행한다.
    while (!presented) await new Promise((resolve) => setImmediate(resolve));
    await disposeSurface(surfaceId);
    presented();
    assert.equal(await focused, false, "a removed surface was reported as focused");
    assert.equal(calls.includes("imageFocus"), false, "the removed module's image region was asked for focus");
  } finally {
    delete globalThis.surfaceFocusCalls;
    dom.window.close();
  }
});
