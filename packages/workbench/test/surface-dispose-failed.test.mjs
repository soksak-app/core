import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { registerPlugin } from "../registry.js";
import { setSurfaceTextSize } from "../text-size.js";

setSurfaceTextSize(() => 1);

// 플러그인 모듈의 마운트가 실패한 탭도 닫을 수 있어야 한다. 마운트 오류는 마운트가 보고했으므로 해제는 정리를 마친다.
test("disposing a native surface whose module failed to mount removes it", { timeout: 5000 }, async (t) => {
  const dom = new JSDOM("<main><div id=slot></div></main>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  const actualHost = await import("../host.js");
  t.mock.module("../host.js", { exports: {
    ...actualHost, native: true, onSurfacePrepared: () => () => {},
  } });
  const { mountSurface, authorizeSurface, disposeSurface, mountedSurface } =
    await import("../surface-modules.js?dispose-failed");
  const pluginId = "fixture-dispose-failed";
  const surfaceId = "fixture-dispose-failed-surface";
  registerPlugin({ id: pluginId, surface: () => null });
  const module = `data:text/javascript,${encodeURIComponent(`export async function mount() {
    throw new Error("fixture mount failed");
  }`)}`;
  const slot = document.querySelector("#slot");
  const mounting = mountSurface(slot, {
    module, surfaceId, pluginId, declarations: { status: [], commands: [], dom: [] }, sidecars: [],
    composition: { kind: "hybrid" },
  });
  try {
    authorizeSurface(surfaceId);
    await assert.rejects(mounting, /fixture mount failed/);
    await disposeSurface(surfaceId);
    assert.equal(mountedSurface(surfaceId), null, "the failed surface stayed mounted");
    assert.equal(slot.querySelectorAll(".surface-module-host").length, 0, "the failed surface left its host element");
  } finally {
    dom.window.close();
  }
});
