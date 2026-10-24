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
  let releaseWaitObserved;
  let inspectRelease = true;
  let refuseComposition = false;
  let holdDispose = false;
  let announceDisposal;
  let releaseDisposal;
  const disposalStarted = new Promise((resolve) => { announceDisposal = resolve; });
  const disposalGate = new Promise((resolve) => { releaseDisposal = resolve; });
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
          releaseWaitObserved?.();
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
      const exposure = runtime.exposure;
      return { ...runtime, exposure: { ...exposure, dispose: async () => {
        if (holdDispose) {
          announceDisposal();
          await disposalGate;
          holdDispose = false;
        }
        return exposure.dispose();
      } }, native: { ...runtime.native, on: async () => () => {}, call: async (name) => {
        if (name === "compositionDeclare" && refuseComposition) {
          refuseComposition = false;
          throw new Error("the host refused the replacement composition");
        }
        return null;
      } } };
    },
  } });
  const { mountSurface, authorizeSurface, disposeSurface, waitSurfaceCompositionDeclared, mountedSurface } = await import("../surface-modules.js?remount-composition");
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

    inspectRelease = false;
    holdDispose = true;
    const oldDisposal = disposeSurface(id, { released: true });
    await disposalStarted;
    assert.equal(mountedSurface(id)?.disposed, true, "the test did not hold the retired entry during cleanup");
    try {
      const staleWait = waitSurfaceCompositionDeclared(id);
      await assert.rejects(staleWait, /surface fixture-remount-composition is not mounted/,
        "a disposed entry without a replacement satisfied the composition wait");
    } finally {
      releaseDisposal();
    }
    await oldDisposal;
    inspectRelease = true;

    authorizeSurface(id);
    await mountSurface(slot, surface);
    await waitSurfaceCompositionDeclared(id);
    const releaseWait = new Promise((resolve) => { releaseWaitObserved = resolve; });
    const disposing = disposeSurface(id, { released: true });
    const remounting = mountSurface(slot, surface);
    await disposing;
    authorizeSurface(id);
    await remounting;
    await waitSurfaceCompositionDeclared(id);
    await releaseWait;

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
    await assert.rejects(waitSurfaceCompositionDeclared(id), /surface fixture-remount-composition mount attempt 4 failed during mount: the host refused the replacement composition/,
      "a failed replacement must preserve its original failure after releasing its mounted entry");
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
    await assert.rejects(waitSurfaceCompositionDeclared(id), /surface fixture-remount-registration-failure mount attempt 1 failed during mount: initial state callback failed/,
      "a failed registration must preserve its original failure after releasing its mounted entry");

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

test("a listener failure before readiness reports an error and releases the view", { timeout: 5000 }, async (t) => {
  const dom = new JSDOM("<main><div id=slot></div></main>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  dom.window.ResizeObserver = class { observe() {} disconnect() {} };
  dom.window.requestAnimationFrame = () => 1;
  dom.window.cancelAnimationFrame = () => {};
  let rejectProcessEnded;
  const registrationError = new Error("view-process-ended registration failed before ready");
  const removed = [];
  const states = [];
  let compositionCalls = 0;
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
      }, call: async (name) => {
        if (name === "compositionDeclare") compositionCalls += 1;
        return null;
      } } };
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
    const mounting = mountSurface(slot, surface, { onState: (state) => states.push(state) });
    await new Promise((resolve) => setImmediate(resolve));
    rejectProcessEnded(registrationError);
    await assert.rejects(mounting, /view-process-ended registration failed before ready/);
    await assert.rejects(waitSurfaceCompositionDeclared(id), /view-process-ended registration failed before ready/);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(states.at(-1).phase, "error", "a post-readiness listener failure must reach surface status");
    assert.equal(states.at(-1).error, registrationError);
    assert.deepEqual([...removed].sort(), ["view-call", "view-presentation-abandoned", "view-reply", "view-responsiveness", "view-stopped"].sort());
    assert.equal(compositionCalls, 0, "a view with an incomplete listener setup declared its composition");
    assert.equal(viewCommandsOf(id), null, "post-readiness failure retained the view-command layer");
    assert.equal(mountedSurface(id), null, "post-readiness failure retained the mounted entry");
    assert.deepEqual(unhandled, [], "post-readiness listener rejection became unhandled");
  } finally {
    await disposeSurface(id);
    process.off("unhandledRejection", onUnhandled);
    dom.window.close();
  }
});

test("disposing a surface ends its already-waiting composition declaration", { timeout: 5000 }, async (t) => {
  const dom = new JSDOM("<main><div id=slot></div></main>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  dom.window.ResizeObserver = class { observe() {} disconnect() {} };
  dom.window.requestAnimationFrame = () => 1;
  dom.window.cancelAnimationFrame = () => {};
  let beginDeclaration;
  let finishDeclaration;
  const declarationStarted = new Promise((resolve) => { beginDeclaration = resolve; });
  const declaration = new Promise((resolve) => { finishDeclaration = resolve; });
  const actualHost = await import("../host.js");
  t.mock.module("../host.js", { exports: {
    ...actualHost,
    native: true,
    onSurfacePrepared: () => () => {},
    surfaceContextRuntime: (surface, declarations) => {
      const runtime = actualHost.surfaceContextRuntime(surface, declarations);
      return { ...runtime, native: { ...runtime.native, on: async () => () => {}, call: (name) => {
        if (name === "compositionDeclare") {
          beginDeclaration();
          return declaration;
        }
        return Promise.resolve(null);
      } } };
    },
  } });
  const { mountSurface, authorizeSurface, disposeSurface, waitSurfaceCompositionDeclared } = await import("../surface-modules.js?composition-wait-dispose");
  const id = "fixture-composition-wait-dispose";
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
    await declarationStarted;
    let waitOutcome;
    const wait = waitSurfaceCompositionDeclared(id).then(
      () => { waitOutcome = { status: "fulfilled" }; },
      (error) => { waitOutcome = { status: "rejected", error }; },
    );
    await disposeSurface(id);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(waitOutcome?.status, "rejected", "dispose did not end the existing composition wait");
    assert.match(waitOutcome.error.message, new RegExp(`surface ${id} was disposed before declaring composition`));

    finishDeclaration(null);
    await Promise.allSettled([mount, wait]);
  } finally {
    finishDeclaration(null);
    await disposeSurface(id);
    dom.window.close();
  }
});

test("a drawn wait records a listener failure before the native view is declared", { timeout: 5000 }, async (t) => {
  const dom = new JSDOM("<main><div id=slot></div></main>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  dom.window.ResizeObserver = class { observe() {} disconnect() {} };
  dom.window.requestAnimationFrame = () => 1;
  dom.window.cancelAnimationFrame = () => {};
  const registrationError = new Error("view-process-ended registration failed before ready");
  const events = [];
  let rejectProcessEnded;
  let holdNextComposition = false;
  let finishComposition;
  let compositionStarted;
  const heldCompositionStarted = new Promise((resolve) => { compositionStarted = resolve; });
  let resolveErrorState;
  const errorReported = new Promise((resolve) => { resolveErrorState = resolve; });
  const actualPageLog = await import("../page-log.js");
  t.mock.module("../page-log.js", { exports: {
    ...actualPageLog,
    emitEvent: (level, event, fields) => events.push({ level, event, fields }),
    eventEnabled: () => true,
  } });
  const actualHost = await import("../host.js");
  t.mock.module("../host.js", { exports: {
    ...actualHost,
    native: true,
    onSurfacePrepared: () => () => {},
    surfaceContextRuntime: (surface, declarations) => {
      const runtime = actualHost.surfaceContextRuntime(surface, declarations);
      return { ...runtime, native: { ...runtime.native, on: (name) => {
        if (name === "view-process-ended" && !rejectProcessEnded) return new Promise((_, reject) => { rejectProcessEnded = reject; });
        return Promise.resolve(() => {});
      }, call: async (name) => {
        if (name === "compositionDeclare" && holdNextComposition) {
          holdNextComposition = false;
          compositionStarted();
          return new Promise((resolve) => { finishComposition = resolve; });
        }
        return null;
      } } };
    },
  } });
  const { mountSurface, authorizeSurface, disposeSurface, mountedSurface } = await import("../surface-modules.js?view-attributed-failure");
  const { createPageLayout } = await import("../page-layout.js?view-attributed-failure");
  const id = "fixture-view-attributed-failure";
  recordOrigin(id, null, "test fixture");
  registerPlugin({ id, surface: () => null });
  const slot = document.querySelector("#slot");
  slot.dataset.nativeSurfaceId = id;
  const surface = {
    module: null, surfaceId: id, pluginId: id,
    declarations: { status: [], commands: [], dom: [] }, sidecars: [],
    composition: { kind: "view", page: "ui/page.html" },
  };
  const page = createPageLayout({
    document, showError: () => {}, setVerify: () => {}, log: () => {}, surfaces: {}, plane: {}, compositor: {},
    textSize: () => 1, rendered: async () => {}, waitSurfaceCompositionDeclared: async (surfaceId) => {
      const { waitSurfaceCompositionDeclared } = await import("../surface-modules.js?view-attributed-failure");
      return waitSurfaceCompositionDeclared(surfaceId);
    },
  });

  try {
    authorizeSurface(id);
    const failedMount = mountSurface(slot, surface, { onState: (state) => { if (state.phase === "error") resolveErrorState(state); } });
    rejectProcessEnded(registrationError);
    await errorReported;
    await assert.rejects(failedMount, /view-process-ended registration failed before ready/);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(mountedSurface(id), null, "the failed view registration mounted a native surface");
    assert.equal(slot.dataset.nativeSurfaceId, id, "the drawn layout no longer names the failed surface");
    assert.deepEqual(events.filter(({ event }) => event === "page.surface.mount.failed"), [{
      level: "error", event: "page.surface.mount.failed",
      fields: { plugin: id, surface: id, attempt: 1, phase: "mount", reason: registrationError.message },
    }]);
    await assert.rejects(page.drawn(), new RegExp(`surface ${id} mount attempt 1 failed during mount: ${registrationError.message}`));

    holdNextComposition = true;
    authorizeSurface(id);
    const retry = mountSurface(slot, surface);
    await heldCompositionStarted;
    let drawnOutcome = null;
    const retryDraw = page.drawn().then(() => { drawnOutcome = "ready"; }, (error) => { drawnOutcome = error; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(drawnOutcome, null, "a pending retry inherited the earlier failed attempt");
    finishComposition(null);
    await Promise.all([retry, retryDraw]);
    assert.equal(drawnOutcome, "ready", "a successful retry did not replace the failed outcome");
    await disposeSurface(id);
    await assert.rejects(page.drawn(), new RegExp(`surface ${id} is not mounted`),
      "normal disposal retained the completed mount registration");
  } finally {
    await disposeSurface(id);
    dom.window.close();
  }
});

test("removing a pre-readiness listener failure from the desired plane clears its retained failure", { timeout: 5000 }, async (t) => {
  const dom = new JSDOM("<main><div id=slot></div></main>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  dom.window.ResizeObserver = class { observe() {} disconnect() {} };
  dom.window.requestAnimationFrame = () => 1;
  dom.window.cancelAnimationFrame = () => {};
  let rejectProcessEnded;
  let errorState = false;
  const actualHost = await import("../host.js");
  t.mock.module("../host.js", { exports: {
    ...actualHost,
    native: true,
    onSurfacePrepared: () => () => {},
    surfaceContextRuntime: (surface, declarations) => {
      const runtime = actualHost.surfaceContextRuntime(surface, declarations);
      return { ...runtime, native: { ...runtime.native, on: (name) => {
        if (name === "view-process-ended") return new Promise((_, reject) => { rejectProcessEnded = reject; });
        return Promise.resolve(() => {});
      }, call: async () => null } };
    },
  } });
  const { mountSurface, authorizeSurface, disposeSurface, disposeSurfacesExcept } = await import("../surface-modules.js?view-failure-plane-cleanup");
  const { createPageLayout } = await import("../page-layout.js?view-failure-plane-cleanup");
  const id = "fixture-view-failure-plane-cleanup";
  recordOrigin(id, null, "test fixture");
  registerPlugin({ id, surface: () => null });
  const slot = document.querySelector("#slot");
  slot.dataset.nativeSurfaceId = id;
  const surface = {
    module: null, surfaceId: id, pluginId: id,
    declarations: { status: [], commands: [], dom: [] }, sidecars: [],
    composition: { kind: "view", page: "ui/page.html" },
  };
  const page = createPageLayout({
    document, showError: () => {}, setVerify: () => {}, log: () => {}, surfaces: {}, plane: {}, compositor: {},
    textSize: () => 1, rendered: async () => {}, waitSurfaceCompositionDeclared: async (surfaceId) => {
      const { waitSurfaceCompositionDeclared } = await import("../surface-modules.js?view-failure-plane-cleanup");
      return waitSurfaceCompositionDeclared(surfaceId);
    },
  });
  try {
    authorizeSurface(id);
    const mounting = mountSurface(slot, surface, { onState: (state) => { if (state.phase === "error") errorState = true; } });
    rejectProcessEnded(new Error("listener failed before plane departure"));
    while (!errorState) await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(mounting, /listener failed before plane departure/);
    await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(page.drawn(), /listener failed before plane departure/);
    await disposeSurfacesExcept(new Set());
    await assert.rejects(page.drawn(), new RegExp(`surface ${id} is not mounted`));
  } finally {
    await disposeSurface(id);
    dom.window.close();
  }
});

test("a disposed pending listener setup cannot replace a newer attempt", { timeout: 5000 }, async (t) => {
  const dom = new JSDOM("<main><div id=slot></div></main>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  dom.window.ResizeObserver = class { observe() {} disconnect() {} };
  dom.window.requestAnimationFrame = () => 1;
  dom.window.cancelAnimationFrame = () => {};
  const events = [];
  let registrations = 0;
  let rejectOld;
  let rejectNew;
  let resolveErrorState;
  const errorReported = new Promise((resolve) => { resolveErrorState = resolve; });
  const actualPageLog = await import("../page-log.js");
  t.mock.module("../page-log.js", { exports: {
    ...actualPageLog,
    emitEvent: (level, event, fields) => events.push({ level, event, fields }),
    eventEnabled: () => true,
  } });
  const actualHost = await import("../host.js");
  t.mock.module("../host.js", { exports: {
    ...actualHost,
    native: true,
    onSurfacePrepared: () => () => {},
    surfaceContextRuntime: (surface, declarations) => {
      const runtime = actualHost.surfaceContextRuntime(surface, declarations);
      return { ...runtime, native: { ...runtime.native, on: (name) => {
        if (name === "view-process-ended") {
          registrations++;
          return new Promise((_, reject) => {
            if (registrations === 1) rejectOld = reject;
            else rejectNew = reject;
          });
        }
        return Promise.resolve(() => {});
      }, call: async () => null } };
    },
  } });
  const { mountSurface, authorizeSurface, disposeSurface, mountedSurface } = await import("../surface-modules.js?view-old-failure");
  const { createPageLayout } = await import("../page-layout.js?view-old-failure");
  const id = "fixture-view-old-failure";
  recordOrigin(id, null, "test fixture");
  registerPlugin({ id, surface: () => null });
  const slot = document.querySelector("#slot");
  slot.dataset.nativeSurfaceId = id;
  const surface = {
    module: null, surfaceId: id, pluginId: id,
    declarations: { status: [], commands: [], dom: [] }, sidecars: [],
    composition: { kind: "view", page: "ui/page.html" },
  };
  const page = createPageLayout({
    document, showError: () => {}, setVerify: () => {}, log: () => {}, surfaces: {}, plane: {}, compositor: {},
    textSize: () => 1, rendered: async () => {}, waitSurfaceCompositionDeclared: async (surfaceId) => {
      const { waitSurfaceCompositionDeclared } = await import("../surface-modules.js?view-old-failure");
      return waitSurfaceCompositionDeclared(surfaceId);
    },
  });
  try {
    authorizeSurface(id);
    const oldMount = mountSurface(slot, surface, { onState: (state) => { if (state.phase === "error") resolveErrorState(state); } });
    await disposeSurface(id);
    await oldMount;
    authorizeSurface(id);
    const newMount = mountSurface(slot, surface, { onState: (state) => { if (state.phase === "error") resolveErrorState(state); } });
    const current = mountedSurface(id);
    rejectOld(new Error("old disposed listener failed"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(mountedSurface(id), current, "an old listener failure removed the newer mounted attempt");
    assert.deepEqual(events.filter(({ event }) => event === "page.surface.mount.failed"), [],
      "a listener rejection after normal dispose was classified as a failed mount");
    rejectNew(new Error("new listener failed before readiness"));
    await errorReported;
    await assert.rejects(newMount, /new listener failed before readiness/);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(events.filter(({ event }) => event === "page.surface.mount.failed").at(-1)?.fields.attempt, 2,
      "the new mount failure was attributed to the old attempt");
    await assert.rejects(page.drawn(), /mount attempt 2 failed during mount: new listener failed before readiness/);
  } finally {
    await disposeSurface(id);
    dom.window.close();
  }
});
