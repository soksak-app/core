import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

test("surface mount keeps one module host when a tab moves slots", async () => {
  const dom = new JSDOM("<main><div id=a></div><div id=b></div></main>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  const { mountSurface } = await import("../surface-modules.js");
  const moduleUrl = "data:text/javascript,export function mount(root,c){c.status.report('ready');return {dispose(){}}}";
  const surface = { module: moduleUrl, surfaceId: "tab-1", pluginId: "fixture", composition: { kind: "dom" } };
  const first = document.querySelector("#a");
  const second = document.querySelector("#b");
  const mounts = await Promise.all([mountSurface(first, surface), mountSurface(first, surface)]);
  assert.equal(mounts[0], mounts[1], "concurrent layout notifications must share one module mount");
  assert.equal(first.querySelectorAll(".surface-module-host").length, 1);
  await mountSurface(second, surface);
  assert.equal(second.querySelectorAll(".surface-module-host").length, 1);
  assert.equal(first.querySelectorAll(".surface-module-host").length, 0);
  dom.window.close();
});

test("selecting a parked tab reattaches its existing module host", async () => {
  const dom = new JSDOM("<main><div id=slot></div></main>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  const { mountSurface } = await import("../surface-modules.js");
  const moduleUrl = "data:text/javascript,export function mount(){return {dispose(){}}}";
  const first = { module: moduleUrl, surfaceId: "tab-park-first", pluginId: "fixture", composition: { kind: "dom" } };
  const second = { module: moduleUrl, surfaceId: "tab-park-second", pluginId: "fixture", composition: { kind: "dom" } };
  const slot = document.querySelector("#slot");

  await mountSurface(slot, first);
  const firstHost = slot.querySelector(".surface-module-host");
  await mountSurface(slot, second);
  const secondHost = slot.querySelector(".surface-module-host");
  assert.notEqual(firstHost, secondHost);
  assert.equal(slot.querySelectorAll(".surface-module-host").length, 1);

  await mountSurface(slot, first);
  assert.equal(firstHost.parentNode, slot);
  assert.equal(slot.querySelectorAll(".surface-module-host").length, 2);
  assert.equal(firstHost.dataset.surfaceSuspended, undefined);
  dom.window.close();
});

test("a mounted module registers and releases its declared exposure through the real registry", async () => {
  const dom = new JSDOM("<main><div id=slot></div></main>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  const { registry } = await import("../exposure.js");
  const { mountSurface, disposeSurface } = await import("../surface-modules.js");
  const pluginId = "fixture-integration";
  const surfaceId = "fixture-module-surface";
  const declarations = {
    status: [],
    commands: [{
      name: `${pluginId}.ping`, description: "Pings the fixture.",
      params: { type: "object" }, result: { type: "null" },
    }],
    dom: [],
  };
  registry.declare("core", {
    status: [
      { name: "core.surface.document", description: "Surface document.", schema: { type: "object" } },
      { name: "core.surface.input", description: "Surface input.", schema: { type: "array" } },
    ],
    commands: [{ name: "core.surface.hit", description: "Tests a surface point.", params: { type: "object" }, result: { type: "boolean" } }],
    dom: [],
  });
  registry.declare(pluginId, declarations);
  registry.configure({ surfacePlugin: (id) => id === surfaceId ? pluginId : null });
  const moduleUrl = `data:text/javascript,${encodeURIComponent(`export async function mount(root, context) {
    if (!context.runtime.clipboard || typeof context.runtime.clipboard.writeText !== 'function') throw new Error('clipboard capability is missing');
    await context.exposure.command('${pluginId}.ping', () => null);
    return { dispose() { context.exposure.dispose(); } };
  }`)}`;
  const surface = {
    module: moduleUrl, surfaceId, pluginId, declarations, composition: { kind: "dom" },
  };
  await mountSurface(document.querySelector("#slot"), surface);
  assert.deepEqual(registry.registrants("command", `${pluginId}.ping`), [surfaceId]);
  assert.deepEqual(registry.registrants("status", "core.surface.document"), [surfaceId]);
  assert.deepEqual(registry.registrants("status", "core.surface.input"), [surfaceId]);
  assert.deepEqual(registry.registrants("command", "core.surface.hit"), [surfaceId]);
  await disposeSurface(surfaceId);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(registry.registrants("command", `${pluginId}.ping`), []);
  dom.window.close();
});

test("surface mount readiness separates module mount from native presentation", async () => {
  const dom = new JSDOM("<main><div id=slot></div></main>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  const { mountSurface, waitSurfaceCompositionDeclared } = await import("../surface-modules.js");
  const moduleUrl = `data:text/javascript,${encodeURIComponent(`export async function mount() {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { dispose() {} };
  }`)}`;
  const surface = { module: moduleUrl, surfaceId: "tab-mounted", pluginId: "fixture", composition: { kind: "dom" } };
  const mounting = mountSurface(document.querySelector("#slot"), surface);
  await waitSurfaceCompositionDeclared(surface.surfaceId);
  await mounting;
  dom.window.close();
});
