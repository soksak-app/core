import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { JSDOM } from "jsdom";
import { registerPlugin } from "../registry.js";
import { recordOrigin } from "../tab-reports.js";
import { setSurfaceTextSize } from "../text-size.js";

setSurfaceTextSize(() => 1);

test("a remount waiting for dispose is visible to composition waits", { timeout: 5000 }, async (t) => {
  const dom = new JSDOM("<main><div id=slot></div></main>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  dom.window.ResizeObserver = class { observe() {} disconnect() {} };
  dom.window.requestAnimationFrame = () => 1;
  dom.window.cancelAnimationFrame = () => {};

  const id = "fixture-remount-composition";
  let waitForComposition;
  let waitResult;
  let inspectRelease = true;
  let refuseComposition = false;
  const actualRegions = await import("../document-regions.js");
  t.mock.module("../document-regions.js", { exports: {
    ...actualRegions,
    documentRegions: {
      ...actualRegions.documentRegions,
      released(surfaceId) {
        actualRegions.documentRegions.released(surfaceId);
        if (surfaceId !== id || !inspectRelease) return;
        queueMicrotask(async () => {
          try {
            await waitForComposition(surfaceId);
            waitResult = null;
          } catch (error) {
            waitResult = error;
          }
        });
      },
    },
  } });

  const actualHost = await import("../host.js");
  t.mock.module("../host.js", { exports: {
    ...actualHost,
    native: true,
    onSurfacePrepared: () => () => {},
    surfaceContextRuntime: (surface, declarations) => {
      const runtime = actualHost.surfaceContextRuntime(surface, declarations);
      return { ...runtime, native: { ...runtime.native, on: async () => () => {}, call: async (name) => {
        if (name === "compositionDeclare" && refuseComposition) {
          refuseComposition = false;
          throw new Error("the host refused the replacement composition");
        }
        return null;
      } } };
    },
  } });
  const { mountSurface, authorizeSurface, disposeSurface, waitSurfaceCompositionDeclared } = await import("../surface-modules.js?remount-composition");
  waitForComposition = waitSurfaceCompositionDeclared;
  const pluginId = "fixture-remount-composition";
  recordOrigin(id, null, "test fixture");
  registerPlugin({ id: pluginId, surface: () => null });
  const slot = document.querySelector("#slot");
  slot.dataset.nativeSurfaceId = id;
  const surface = {
    module: null, surfaceId: id, pluginId,
    declarations: { status: [], commands: [], dom: [] }, sidecars: [],
    composition: { kind: "view", page: "ui/page.html" },
  };

  try {
    authorizeSurface(id);
    await mountSurface(slot, surface);
    await waitSurfaceCompositionDeclared(id);

    const disposing = disposeSurface(id, { released: true });
    const remounting = mountSurface(slot, surface);
    await disposing;
    authorizeSurface(id);
    await remounting;
    await waitSurfaceCompositionDeclared(id);

    assert.equal(waitResult, null, waitResult?.message ?? "composition wait failed during replacement mount");
    inspectRelease = false;
    await disposeSurface(id, { released: true });
    await assert.rejects(waitSurfaceCompositionDeclared(id), /surface fixture-remount-composition is not mounted/,
      "disposing without a replacement must not leave a pending or mounted surface");

    authorizeSurface(id);
    refuseComposition = true;
    const failedMount = mountSurface(slot, surface);
    const failedWait = waitSurfaceCompositionDeclared(id);
    await assert.rejects(failedMount, /the host refused the replacement composition/);
    await assert.rejects(failedWait, /the host refused the replacement composition/);
    await assert.rejects(waitSurfaceCompositionDeclared(id), /surface fixture-remount-composition is not mounted/,
      "a failed replacement must clear its pending and mounted entries");
  } finally {
    await disposeSurface(id);
    dom.window.close();
  }
});

test("a mount failure before registration reaches composition wait and releases its host", { timeout: 5000 }, async (t) => {
  const dom = new JSDOM("<main><div id=slot></div></main>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  dom.window.ResizeObserver = class { observe() {} disconnect() {} };
  dom.window.requestAnimationFrame = () => 1;
  dom.window.cancelAnimationFrame = () => {};
  const actualHost = await import("../host.js");
  t.mock.module("../host.js", { exports: {
    ...actualHost,
    native: true,
    onSurfacePrepared: () => () => {},
    surfaceContextRuntime: (surface, declarations) => {
      const runtime = actualHost.surfaceContextRuntime(surface, declarations);
      return { ...runtime, native: { ...runtime.native, on: async () => () => {}, call: async () => null } };
    },
  } });
  const { mountSurface, authorizeSurface, disposeSurface, waitSurfaceCompositionDeclared } = await import("../surface-modules.js?remount-registration-failure");
  const id = "fixture-remount-registration-failure";
  const pluginId = "fixture-remount-registration-failure";
  recordOrigin(id, null, "test fixture");
  registerPlugin({ id: pluginId, surface: () => null });
  const slot = document.querySelector("#slot");
  slot.dataset.nativeSurfaceId = id;
  const surface = {
    module: null, surfaceId: id, pluginId,
    declarations: { status: [], commands: [], dom: [] }, sidecars: [],
    composition: { kind: "view", page: "ui/page.html" },
  };

  try {
    authorizeSurface(id);
    const failedMount = mountSurface(slot, surface, { onState: () => { throw new Error("initial state callback failed"); } });
    const failedWait = waitSurfaceCompositionDeclared(id);
    await assert.rejects(failedMount, /initial state callback failed/);
    await assert.rejects(failedWait, /initial state callback failed/);
    assert.equal(slot.querySelector(".surface-module-host"), null, "a failed registration left its host in the slot");
    await assert.rejects(waitSurfaceCompositionDeclared(id), /surface fixture-remount-registration-failure is not mounted/,
      "a failed registration left a pending or mounted entry");

    const falsyId = "fixture-remount-falsy-failure";
    const falsyPluginId = "fixture-remount-falsy-failure";
    recordOrigin(falsyId, null, "test fixture");
    registerPlugin({ id: falsyPluginId, surface: () => null });
    const falsySurface = { ...surface, surfaceId: falsyId, pluginId: falsyPluginId };
    authorizeSurface(falsyId);
    const falsyMount = mountSurface(slot, falsySurface, { onState: () => { throw null; } });
    const falsyWait = waitSurfaceCompositionDeclared(falsyId);
    await assert.rejects(falsyMount, (error) => error === null);
    await assert.rejects(falsyWait, (error) => error === null);
    assert.equal(slot.querySelector(".surface-module-host"), null, "a falsy registration failure left its host in the slot");
  } finally {
    await disposeSurface(id);
    dom.window.close();
  }
});

test("same-slot and moved-slot mounts preserve the entry while authorization is pending", { timeout: 5000 }, async (t) => {
  const dom = new JSDOM("<main><div id=first></div><div id=second></div></main>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  dom.window.ResizeObserver = class { observe() {} disconnect() {} };
  dom.window.requestAnimationFrame = () => 1;
  dom.window.cancelAnimationFrame = () => {};
  const actualHost = await import("../host.js");
  t.mock.module("../host.js", { exports: {
    ...actualHost,
    native: true,
    onSurfacePrepared: () => () => {},
    surfaceContextRuntime: (surface, declarations) => {
      const runtime = actualHost.surfaceContextRuntime(surface, declarations);
      return { ...runtime, native: { ...runtime.native, on: async () => () => {}, call: async () => null } };
    },
  } });
  const { mountSurface, authorizeSurface, disposeSurface, waitSurfaceCompositionDeclared, mountedSurface } = await import("../surface-modules.js?remount-registration-paths");
  const id = "fixture-remount-registration-paths";
  const pluginId = "fixture-remount-registration-paths";
  recordOrigin(id, null, "test fixture");
  registerPlugin({ id: pluginId, surface: () => null });
  const first = document.querySelector("#first");
  const second = document.querySelector("#second");
  const surface = {
    module: null, surfaceId: id, pluginId,
    declarations: { status: [], commands: [], dom: [] }, sidecars: [],
    composition: { kind: "view", page: "ui/page.html" },
  };

  try {
    const firstMount = mountSurface(first, surface);
    const firstWait = waitSurfaceCompositionDeclared(id);
    const sameSlotMount = mountSurface(first, surface);
    const sameSlotWait = waitSurfaceCompositionDeclared(id);
    const movedSlotMount = mountSurface(second, surface);
    const movedSlotWait = waitSurfaceCompositionDeclared(id);
    const entry = mountedSurface(id);
    assert.equal(entry.host.parentNode, second, "the moved surface host did not enter the target slot");
    assert.equal(first.querySelectorAll(".surface-module-host").length, 0);
    assert.equal(second.querySelectorAll(".surface-module-host").length, 1);
    authorizeSurface(id);
    await Promise.all([firstMount, firstWait, sameSlotMount, sameSlotWait, movedSlotMount, movedSlotWait]);
    assert.equal(mountedSurface(id), entry, "same-slot or moved-slot mount replaced the surface entry");
  } finally {
    await disposeSurface(id);
    dom.window.close();
  }
});
