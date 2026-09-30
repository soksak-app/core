import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { registerPlugin } from "../registry.js";
import { setSurfaceTextSize } from "../text-size.js";

setSurfaceTextSize(() => 1);

test("native closure before authorization cannot erase the mounted module's core registrations", async (t) => {
  const dom = new JSDOM("<main><div id=slot></div></main>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  const actualHost = await import("../host.js");
  t.mock.module("../host.js", { exports: {
    ...actualHost, native: true, onSurfacePrepared: () => () => {},
  } });
  const { registry } = await import("../exposure.js");
  const { mountSurface, authorizeSurface, disposeSurface } = await import("../surface-modules.js?authorization-closure");
  const pluginId = "fixture-authorization";
  const surfaceId = "fixture-authorization-surface";
  registry.declare("core", {
    status: [
      { name: "core.surface.document", description: "Surface document.", schema: { type: "object" } },
      { name: "core.surface.input", description: "Surface input.", schema: { type: "array" } },
    ],
    commands: [{ name: "core.surface.hit", description: "Tests a surface point.", params: { type: "object" }, result: { type: "boolean" } }],
    dom: [],
  });
  const command = `${pluginId}.ping`;
  const declarations = { status: [], commands: [{ name: command, description: "Pings the fixture.",
    params: { type: "object" }, result: { type: "null" } }], dom: [] };
  registerPlugin({ id: pluginId, diagnostics: null, surface: () => null });
  registry.declare(pluginId, declarations);
  registry.configure({ surfacePlugin: (id) => id === surfaceId ? pluginId : null });
  const module = `data:text/javascript,${encodeURIComponent(`export async function mount(root, context) {
    await context.exposure.command('${command}', () => null);
    return { dispose() { context.exposure.dispose(); } };
  }`)}`;
  const mounting = mountSurface(document.querySelector("#slot"), {
    module, surfaceId, pluginId, declarations, sidecars: [], composition: { kind: "dom" },
  });
  try {
    // 승인 전 등록 요청의 마이크로태스크를 완료한 뒤 이전 네이티브 종료를 주입한다.
    await new Promise((resolve) => setImmediate(resolve));
    registry.registered({ surface: surfaceId, closed: true });
    authorizeSurface(surfaceId);
    await mounting;
    assert.deepEqual(registry.namesOf(surfaceId), [
      "status core.surface.document", "status core.surface.input", "command core.surface.hit", `command ${command}`,
    ], "native closure erased the core registrations while later plugin registration survived");
  } finally {
    authorizeSurface(surfaceId);
    await mounting;
    await disposeSurface(surfaceId);
    dom.window.close();
  }
});
