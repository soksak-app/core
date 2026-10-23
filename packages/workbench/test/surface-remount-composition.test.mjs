import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { JSDOM } from "jsdom";
import { registerPlugin } from "../registry.js";
import { recordOrigin } from "../tab-reports.js";
import { setSurfaceTextSize } from "../text-size.js";
import { viewCommandsOf } from "../view-commands.js";

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

test("a rejected view listener registration releases successful listeners and rejects the mount", { timeout: 5000 }, async (t) => {
  const dom = new JSDOM("<main><div id=slot></div></main>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  dom.window.ResizeObserver = class { observe() {} disconnect() {} };
  dom.window.requestAnimationFrame = () => 1;
  dom.window.cancelAnimationFrame = () => {};
  const registrationError = new Error("view-process-ended registration failed");
  const removed = [];
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  const actualHost = await import("../host.js");
  t.mock.module("../host.js", { exports: {
    ...actualHost,
    native: true,
    onSurfacePrepared: () => () => {},
    surfaceContextRuntime: (surface, declarations) => {
      const runtime = actualHost.surfaceContextRuntime(surface, declarations);
      return { ...runtime, native: { ...runtime.native, on: (name) => {
        if (name === "view-process-ended") return Promise.resolve().then(() => { throw registrationError; });
        return Promise.resolve(() => removed.push(name));
      }, call: async () => null } };
    },
  } });
  const { mountSurface, authorizeSurface, disposeSurface, waitSurfaceCompositionDeclared, mountedSurface } = await import("../surface-modules.js?view-listener-registration-failure");
  const id = "fixture-view-listener-registration-failure";
  const pluginId = id;
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
    const mount = mountSurface(slot, surface);
    const wait = waitSurfaceCompositionDeclared(id);
    const [mountResult, waitResult] = await Promise.allSettled([mount, wait]);
    assert.equal(mountResult.status, "rejected", "listener setup failure must reject mount");
    assert.equal(mountResult.reason, registrationError, "mount must preserve the original listener error");
    assert.equal(waitResult.status, "rejected", "listener setup failure must reject composition wait");
    assert.equal(waitResult.reason, registrationError, "composition wait must preserve the original listener error");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual([...removed].sort(), ["view-call", "view-presentation-abandoned", "view-reply", "view-responsiveness", "view-stopped"].sort(),
      "every successful listener registration must be released");
    assert.equal(viewCommandsOf(id), null, "failed mount retained its view-command layer");
    assert.equal(mountedSurface(id), null, "failed mount retained its mounted entry");
    assert.equal(slot.querySelector(".surface-module-host"), null, "failed mount retained its host");
    assert.deepEqual(unhandled, [], "listener rejection escaped as an unhandled promise");
  } finally {
    await disposeSurface(id);
    process.off("unhandledRejection", onUnhandled);
    dom.window.close();
  }
});

test("disposing a mount releases resolved listeners before pending registration settles", { timeout: 5000 }, async (t) => {
  const dom = new JSDOM("<main><div id=slot></div></main>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  dom.window.ResizeObserver = class { observe() {} disconnect() {} };
  dom.window.requestAnimationFrame = () => 1;
  dom.window.cancelAnimationFrame = () => {};
  let rejectProcessEnded;
  let resolveReply;
  let registrationStarted;
  const started = new Promise((resolve) => { registrationStarted = resolve; });
  const registrationError = new Error("view-process-ended registration failed after dispose");
  const removed = [];
  const reports = [];
  const originalDispatchEvent = globalThis.dispatchEvent;
  globalThis.dispatchEvent = (event) => {
    reports.push(event.message);
    return originalDispatchEvent?.call(globalThis, event) ?? true;
  };
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  const actualHost = await import("../host.js");
  t.mock.module("../host.js", { exports: {
    ...actualHost,
    native: true,
    onSurfacePrepared: () => () => {},
    surfaceContextRuntime: (surface, declarations) => {
      const runtime = actualHost.surfaceContextRuntime(surface, declarations);
      return { ...runtime, native: { ...runtime.native, on: (name) => {
        if (name === "view-process-ended") return new Promise((_, reject) => {
          rejectProcessEnded = reject;
          registrationStarted();
        });
        if (name === "view-reply") return new Promise((resolve) => { resolveReply = resolve; });
        return Promise.resolve(() => removed.push(name));
      }, call: async () => null } };
    },
  } });
  const { mountSurface, authorizeSurface, disposeSurface } = await import("../surface-modules.js?view-listener-pending-dispose");
  const id = "fixture-view-listener-pending-dispose";
  recordOrigin(id, null, "test fixture");
  registerPlugin({ id, surface: () => null });
  const slot = document.querySelector("#slot");
  slot.dataset.nativeSurfaceId = id;
  const surface = {
    module: null, surfaceId: id, pluginId: id,
    declarations: { status: [], commands: [], dom: [] }, sidecars: [],
    composition: { kind: "view", page: "ui/page.html" },
  };

  try {
    authorizeSurface(id);
    const mount = mountSurface(slot, surface);
    await started;
    await disposeSurface(id);
    assert.deepEqual([...removed].sort(), ["view-call", "view-presentation-abandoned", "view-responsiveness", "view-stopped"].sort(),
      "dispose must release resolved listeners without waiting for pending registrations");
    resolveReply(() => { throw new Error("late listener cleanup failed"); });
    rejectProcessEnded(registrationError);
    const [mountResult] = await Promise.allSettled([mount]);
    assert.equal(mountResult.status, "fulfilled", "disposing the mount must retain its cancellation result");
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(reports.some((message) => message === "native listener cleanup: late listener cleanup failed"),
      "a late cleanup error must be reported");
    assert.ok(reports.some((message) => message === `view listener registration after dispose: ${registrationError.message}`),
      "a registration failure after disposal must be reported without changing cancellation");
    assert.deepEqual(unhandled, [], "pending listener outcomes must not become unhandled");
  } finally {
    await disposeSurface(id);
    process.off("unhandledRejection", onUnhandled);
    globalThis.dispatchEvent = originalDispatchEvent;
    dom.window.close();
  }
});

test("a listener failure after readiness reports an error and releases the view", { timeout: 5000 }, async (t) => {
  const dom = new JSDOM("<main><div id=slot></div></main>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  dom.window.ResizeObserver = class { observe() {} disconnect() {} };
  dom.window.requestAnimationFrame = () => 1;
  dom.window.cancelAnimationFrame = () => {};
  let rejectProcessEnded;
  const registrationError = new Error("view-process-ended registration failed after ready");
  const removed = [];
  const states = [];
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  const actualHost = await import("../host.js");
  t.mock.module("../host.js", { exports: {
    ...actualHost,
    native: true,
    onSurfacePrepared: () => () => {},
    surfaceContextRuntime: (surface, declarations) => {
      const runtime = actualHost.surfaceContextRuntime(surface, declarations);
      return { ...runtime, native: { ...runtime.native, on: (name) => {
        if (name === "view-process-ended") return new Promise((_, reject) => { rejectProcessEnded = reject; });
        return Promise.resolve(() => removed.push(name));
      }, call: async () => null } };
    },
  } });
  const { mountSurface, authorizeSurface, disposeSurface, waitSurfaceCompositionDeclared, mountedSurface } = await import("../surface-modules.js?view-listener-after-ready");
  const id = "fixture-view-listener-after-ready";
  recordOrigin(id, null, "test fixture");
  registerPlugin({ id, surface: () => null });
  const slot = document.querySelector("#slot");
  slot.dataset.nativeSurfaceId = id;
  const surface = {
    module: null, surfaceId: id, pluginId: id,
    declarations: { status: [], commands: [], dom: [] }, sidecars: [],
    composition: { kind: "view", page: "ui/page.html" },
  };

  try {
    authorizeSurface(id);
    await mountSurface(slot, surface, { onState: (state) => states.push(state) });
    await waitSurfaceCompositionDeclared(id);
    assert.equal(states.at(-1).phase, "ready");
    rejectProcessEnded(registrationError);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(states.at(-1).phase, "error", "a post-readiness listener failure must reach surface status");
    assert.equal(states.at(-1).error, registrationError);
    assert.deepEqual([...removed].sort(), ["view-call", "view-presentation-abandoned", "view-reply", "view-responsiveness", "view-stopped"].sort());
    assert.equal(viewCommandsOf(id), null, "post-readiness failure retained the view-command layer");
    assert.equal(mountedSurface(id), null, "post-readiness failure retained the mounted entry");
    assert.deepEqual(unhandled, [], "post-readiness listener rejection became unhandled");
  } finally {
    await disposeSurface(id);
    process.off("unhandledRejection", onUnhandled);
    dom.window.close();
  }
});
