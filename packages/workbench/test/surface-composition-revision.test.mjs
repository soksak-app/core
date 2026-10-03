import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { registerPlugin } from "../registry.js";
import { setSurfaceTextSize } from "../text-size.js";

setSurfaceTextSize(() => 1);

// 같은 문서에서 해제한 표면을 같은 id 로 다시 마운트하면 새 composition 의 배치도 그 표면의 이전 배치보다 큰 revision 을
// 보내야 한다. 호스트는 표면마다 revision 이 커지기를 요구하고, 표면이 파괴되거나 문서가 바뀔 때만 그 값을 지운다.
test("a surface mounted again in the same document continues its composition revisions", { timeout: 5000 }, async (t) => {
  const dom = new JSDOM("<main><div id=slot></div></main>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  dom.window.ResizeObserver = class { observe() {} disconnect() {} };
  const placed = [];
  const actualHost = await import("../host.js");
  t.mock.module("../host.js", { exports: {
    ...actualHost,
    native: true,
    onSurfacePrepared: () => () => {},
    // 호스트에 가는 호출만 기록하고, 나머지 표면 런타임은 실제 것을 쓴다.
    surfaceContextRuntime: (surface, declarations) => {
      const runtime = actualHost.surfaceContextRuntime(surface, declarations);
      return { ...runtime, native: { ...runtime.native, call: async (name, payload) => {
        if (name === "compositionPlace") placed.push(payload.revision);
        return null;
      } } };
    },
  } });
  const { mountSurface, authorizeSurface, disposeSurface, disposeSurfacesExcept } = await import("../surface-modules.js?composition-revision");
  const pluginId = "fixture-composition-revision";
  const surfaceId = "fixture-composition-revision-surface";
  registerPlugin({ id: pluginId, surface: () => null });
  const module = `data:text/javascript,${encodeURIComponent(`export async function mount(root, context) {
    const composition = await context.composition.create({});
    await composition.update(() => {});
    return { dispose: () => composition.dispose() };
  }`)}`;
  const surface = { module, surfaceId, pluginId, declarations: { status: [], commands: [], dom: [] }, sidecars: [],
    composition: { kind: "hybrid", regions: [], overlays: [] } };
  const slot = document.querySelector("#slot");
  try {
    authorizeSurface(surfaceId);
    await mountSurface(slot, surface);
    await disposeSurface(surfaceId);
    authorizeSurface(surfaceId);
    await mountSurface(slot, surface);
    // 탭이 닫혔다가 같은 id 로 다시 열려도(저장된 탭의 복원) 번호는 이어진다.
    await disposeSurfacesExcept(new Set());
    authorizeSurface(surfaceId);
    await mountSurface(slot, surface);
    assert.equal(placed.length, 6, `placements ${JSON.stringify(placed)}`);
    for (let i = 1; i < placed.length; i++) {
      assert.ok(placed[i] > placed[i - 1], `revision ${placed[i]} after ${placed[i - 1]}: ${JSON.stringify(placed)}`);
    }
    await disposeSurface(surfaceId);
  } finally {
    dom.window.close();
  }
});
