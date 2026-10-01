import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { registerPlugin } from "../registry.js";
import { setSurfaceTextSize } from "../text-size.js";

setSurfaceTextSize(() => 1);

// 모든 코어 명령은 답하기 전에 보이는 네이티브 표면의 composition 선언을 기다린다. 마운트가 실패한 표면은 선언하지
// 않으므로, 그 기다림은 마운트 오류로 끝나야 한다.
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
  registerPlugin({ id: pluginId, diagnostics: null, surface: () => null });
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
    // 실패한 마운트의 해제는 surface-dispose-failed.test.mjs 가 검사한다.
    dom.window.close();
  }
});
