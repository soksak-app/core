import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { registerPlugin } from "../registry.js";
import { setSurfaceTextSize } from "../text-size.js";

setSurfaceTextSize(() => 1);

// 표면을 제거하면 워크벤치는 모듈의 dispose 보다 먼저 그 표면의 영역을 뗀다. 모듈의 dispose 는 사이드카 세션을 끝내고,
// 공급자는 세션을 끝낼 때 전송 그림을 놓는다. 영역이 붙어 있는 동안 세션이 끝나면 이미 보낸 프레임을 호스트가 놓인 그림으로
// 표시하려다 notFound 로 실패한다(F60). 영역을 먼저 떼면 그 프레임은 stale 로 답한다.
test("removing a surface detaches its regions before the module ends its sidecar session", { timeout: 5000 }, async (t) => {
  const dom = new JSDOM("<main><div id=slot></div></main>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  dom.window.ResizeObserver = class { observe() {} disconnect() {} };
  // 관찰은 다음 animation frame 에 시작하며, 이 검사는 frame 을 진행하지 않는다.
  dom.window.requestAnimationFrame = () => 1;
  dom.window.cancelAnimationFrame = () => {};
  // 영역의 여백은 뷰포트 크기로 잰다. 이 검사는 크기를 쓰지 않는다.
  Object.defineProperty(dom.window, "visualViewport", { value: { width: 800, height: 600 } });
  const order = [];
  globalThis.surfaceDisposeOrder = order;
  const actualHost = await import("../host.js");
  t.mock.module("../host.js", { exports: {
    ...actualHost,
    native: true,
    onSurfacePrepared: () => () => {},
    // 호스트에 가는 영역 떼기만 기록하고 호스트 사건은 오지 않는다. 나머지 표면 런타임은 실제 것을 쓴다.
    surfaceContextRuntime: (surface, declarations) => {
      const runtime = actualHost.surfaceContextRuntime(surface, declarations);
      return { ...runtime, native: { ...runtime.native, on: () => () => {}, call: async (name, payload) => {
        if (name === "imageDetach") order.push(`imageDetach ${payload.name}`);
        return null;
      } } };
    },
  } });
  const { mountSurface, authorizeSurface, disposeSurface } = await import("../surface-modules.js?dispose-order");
  const pluginId = "fixture-dispose-order";
  const surfaceId = "fixture-dispose-order-surface";
  registerPlugin({ id: pluginId, surface: () => null });
  // 모듈은 공급 플러그인처럼 dispose 에서 사이드카 세션을 먼저 끝내고 그 다음 composition 을 해제한다.
  const module = `data:text/javascript,${encodeURIComponent(`export async function mount(root, context) {
    root.innerHTML = "<div id=view></div>";
    const composition = await context.composition.create({ regions: { view: root.querySelector("#view") } });
    return { async dispose() {
      globalThis.surfaceDisposeOrder.push("session close");
      await composition.dispose();
    } };
  }`)}`;
  const surface = { module, surfaceId, pluginId, declarations: { status: [], commands: [], dom: [] }, sidecars: [],
    composition: { kind: "hybrid", regions: [{ name: "view", kind: "image", sidecar: "fixture-sidecar", input: "dom" }],
      overlays: [] } };
  try {
    authorizeSurface(surfaceId);
    await mountSurface(document.querySelector("#slot"), surface);
    await disposeSurface(surfaceId);
    assert.deepEqual(order, ["imageDetach view", "session close"]);
  } finally {
    delete globalThis.surfaceDisposeOrder;
    dom.window.close();
  }
});
