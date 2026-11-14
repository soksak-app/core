import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { selectPageWire } from "@soksak/runtime";
import { drained } from "./support/drained.mjs";

// The host calls of the surfaces are answered by the page-wire case of each test (docs/spec/cases/page-wire/README.md). A case is selected
// before the first module that imports host.js is imported, because host.js reads the host when it is imported. The case of the start
// holds the first batch of the page log, which states the clock anchor, so every later case holds the batches of its own events only.
const startWire = selectPageWire("surface-remount-composition-start");
const { registerPlugin } = await import("../registry.js");
const { recordOrigin } = await import("../tab-reports.js");
const { setSurfaceTextSize } = await import("../text-size.js");
const { pageIdentity } = await import("../page-identity.js");
await import("../host.js");
const { flushEvents, recordWorkbenchStart } = await import("../page-log.js");
const { setTraceEnabled } = await import("../performance.js");
const { setLogPolicy } = await import("../log-policy.js");
const { documentRegions } = await import("../document-regions.js");
await import("../surface-modules.js");

setSurfaceTextSize(() => 1);
recordWorkbenchStart({ href: "http://localhost/" }, 0);
await flushEvents();
startWire.finish();

/** The events that the page sent in the batches of its wire. */
const batchEvents = (wire) => wire.calls
  .filter(({ name, payload }) => name === "log" && payload?.action === "batch")
  .flatMap(({ payload }) => payload.events);
/** The events of the trace of the composition of a surface, as {event, fields}. */
const compositionEvents = (wire) => batchEvents(wire)
  .filter(({ event }) => event === "workbench.trace.surface.composition")
  .map(({ event, fields }) => ({ event, fields }));
/** The events that record a failed mount, as {level, event, fields}. */
const failedMounts = (wire) => batchEvents(wire)
  .filter(({ event }) => event === "workbench.surface.mount.failed")
  .map(({ level, event, fields }) => ({ level, event, fields }));

test("a remount waiting for dispose is visible to composition waits", { timeout: 5000 }, async () => {
  const wire = selectPageWire("surface-remount-composition-replacement");
  const dom = new JSDOM("<main><div id=slot></div></main>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  dom.window.ResizeObserver = class { observe() {} disconnect() {} };
  dom.window.requestAnimationFrame = () => 1;
  dom.window.cancelAnimationFrame = () => {};

  const id = "fixture-remount-composition";
  let pageIdentityReads = 0;
  const pageTimeOrigin = dom.window.performance.timeOrigin;
  Object.defineProperty(dom.window.performance, "timeOrigin", { configurable: true, get() {
    pageIdentityReads += 1;
    return pageTimeOrigin;
  } });
  const { mountSurface, authorizeSurface, disposeSurface, waitSurfaceCompositionDeclared, mountedSurface } = await import("../surface-modules.js?remount-composition");
  const pluginId = "fixture-remount-composition";
  recordOrigin(id, null, "test fixture");
  registerPlugin({ id: pluginId, surface: () => null });
  const slot = document.querySelector("#slot");
  slot.dataset.nativeSurfaceId = id;
  const surface = {
    module: null, surfaceId: id, pluginId,
    declarations: { status: [], commands: [], element: [] }, sidecars: [],
    composition: { kind: "view", page: "ui/page.html" },
  };

  try {
    // The events of the trace of the composition are of the class call, which the policy stores at the level debug.
    await setLogPolicy({ call: "debug" });
    await setTraceEnabled(true);
    authorizeSurface(id);
    await mountSurface(slot, surface);
    await waitSurfaceCompositionDeclared(id);
    await flushEvents();
    assert.deepEqual(compositionEvents(wire), [{
      event: "workbench.trace.surface.composition",
      fields: { page: pageIdentity, surface: id, attempt: 1, action: "declare", outcome: "accepted" },
    }], "the accepted native composition declaration was not correlated with its page and mount attempt");
    // The disposal marks the entry as disposed in the call, and its cleanup continues in the microtasks after the call, so the
    // retired entry is visible to the checks that follow the call in the same turn.
    const oldDisposal = disposeSurface(id, { released: true });
    assert.equal(mountedSurface(id)?.disposed, true, "the test did not hold the retired entry during cleanup");
    const staleWait = waitSurfaceCompositionDeclared(id);
    await assert.rejects(staleWait, /surface fixture-remount-composition is not mounted/,
      "a disposed entry without a replacement satisfied the composition wait");
    await oldDisposal;
    await flushEvents();
    assert.deepEqual(compositionEvents(wire).filter(({ fields }) => fields.action === "dispose").at(-1), {
      event: "workbench.trace.surface.composition",
      fields: { page: pageIdentity, surface: id, attempt: 1, action: "dispose", reason: "released" },
    }, "page disposal was not recorded distinctly from native composition removal");

    authorizeSurface(id);
    await mountSurface(slot, surface);
    await waitSurfaceCompositionDeclared(id);
    await flushEvents();
    const disposing = disposeSurface(id, { released: true });
    const remounting = mountSurface(slot, surface);
    // The wait starts while the retired entry is disposing and the replacement mount is registered.
    const replacementWait = waitSurfaceCompositionDeclared(id).then(() => null, (error) => error);
    await disposing;
    authorizeSurface(id);
    await remounting;
    await waitSurfaceCompositionDeclared(id);
    const waitResult = await replacementWait;
    assert.equal(waitResult, null, waitResult?.message ?? "composition wait failed during replacement mount");
    await flushEvents();
    await disposeSurface(id, { released: true });
    await assert.rejects(waitSurfaceCompositionDeclared(id), /surface fixture-remount-composition is not mounted/,
      "disposing without a replacement must not leave a pending or mounted surface");
    await flushEvents();

    authorizeSurface(id);
    const failedMount = mountSurface(slot, surface);
    const failedWait = waitSurfaceCompositionDeclared(id);
    await assert.rejects(failedMount, /the host refused the replacement composition/);
    await assert.rejects(failedWait, /the host refused the replacement composition/);
    await flushEvents();
    assert.deepEqual(compositionEvents(wire).filter(({ fields }) => fields.action === "declare").at(-1), {
      event: "workbench.trace.surface.composition",
      fields: { page: pageIdentity, surface: id, attempt: 4, action: "declare", outcome: "rejected" },
    }, "a rejected native declaration was not recorded with the failed mount attempt");
    assert.deepEqual(compositionEvents(wire).filter(({ fields }) => fields.action === "dispose").at(-1), {
      event: "workbench.trace.surface.composition",
      fields: { page: pageIdentity, surface: id, attempt: 4, action: "dispose", reason: "mount-failure" },
    }, "failed mount disposal did not preserve its page-local reason");
    await assert.rejects(waitSurfaceCompositionDeclared(id), /surface fixture-remount-composition mount attempt 4 failed during mount: the host refused the replacement composition/,
      "a failed replacement must preserve its original failure after releasing its mounted entry");

    const readsBeforeDisabledMount = pageIdentityReads;
    const recordedBeforeDisabledMount = compositionEvents(wire).length;
    await setTraceEnabled(false);
    authorizeSurface(id);
    await mountSurface(slot, surface);
    await waitSurfaceCompositionDeclared(id);
    await disposeSurface(id, { released: true });
    await flushEvents();
    assert.equal(pageIdentityReads, readsBeforeDisabledMount, "a disabled trace built composition event fields");
    assert.equal(compositionEvents(wire).length, recordedBeforeDisabledMount, "a disabled trace recorded composition events");
    // The policy returns to the errors of every class, so the later tests of the file store only the events that they name.
    await setLogPolicy({});
  } finally {
    await disposeSurface(id);
    dom.window.close();
  }
  wire.finish();
});

test("a mount failure before registration reaches composition wait and releases its host", { timeout: 5000 }, async () => {
  const wire = selectPageWire("surface-remount-composition-registration-failure");
  const dom = new JSDOM("<main><div id=slot></div></main>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  dom.window.ResizeObserver = class { observe() {} disconnect() {} };
  dom.window.requestAnimationFrame = () => 1;
  dom.window.cancelAnimationFrame = () => {};
  const { mountSurface, authorizeSurface, disposeSurface, waitSurfaceCompositionDeclared } = await import("../surface-modules.js?remount-registration-failure");
  const id = "fixture-remount-registration-failure";
  const pluginId = "fixture-remount-registration-failure";
  recordOrigin(id, null, "test fixture");
  registerPlugin({ id: pluginId, surface: () => null });
  const slot = document.querySelector("#slot");
  slot.dataset.nativeSurfaceId = id;
  const surface = {
    module: null, surfaceId: id, pluginId,
    declarations: { status: [], commands: [], element: [] }, sidecars: [],
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
    await flushEvents();

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
    await flushEvents();
  } finally {
    await disposeSurface(id);
    dom.window.close();
  }
  wire.finish();
});

test("same-slot and moved-slot mounts preserve the entry while authorization is pending", { timeout: 5000 }, async () => {
  const wire = selectPageWire("surface-remount-composition-slots");
  const dom = new JSDOM("<main><div id=first></div><div id=second></div></main>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  dom.window.ResizeObserver = class { observe() {} disconnect() {} };
  dom.window.requestAnimationFrame = () => 1;
  dom.window.cancelAnimationFrame = () => {};
  const { mountSurface, authorizeSurface, disposeSurface, waitSurfaceCompositionDeclared, mountedSurface } = await import("../surface-modules.js?remount-registration-paths");
  const id = "fixture-remount-registration-paths";
  const pluginId = "fixture-remount-registration-paths";
  recordOrigin(id, null, "test fixture");
  registerPlugin({ id: pluginId, surface: () => null });
  const first = document.querySelector("#first");
  const second = document.querySelector("#second");
  const surface = {
    module: null, surfaceId: id, pluginId,
    declarations: { status: [], commands: [], element: [] }, sidecars: [],
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
  wire.finish();
});

test("disposing a mount releases resolved listeners before pending registration settles", { timeout: 5000 }, async () => {
  const wire = selectPageWire("surface-remount-composition-listener-pending-dispose");
  const dom = new JSDOM("<main><div id=slot></div></main>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  dom.window.ResizeObserver = class { observe() {} disconnect() {} };
  dom.window.requestAnimationFrame = () => 1;
  dom.window.cancelAnimationFrame = () => {};
  const registrationError = new Error("view-process-ended registration failed after dispose");
  const reports = [];
  // Waiters of the reports: each report calls the waiters, and until resolves when the predicate holds.
  const reportWaiters = [];
  const untilReported = (predicate) => new Promise((resolve) => {
    const check = () => (predicate() ? resolve() : reportWaiters.push(check));
    check();
  });
  const originalDispatchEvent = globalThis.dispatchEvent;
  globalThis.dispatchEvent = (event) => {
    reports.push(event.message);
    for (const check of reportWaiters.splice(0)) check();
    return originalDispatchEvent?.call(globalThis, event) ?? true;
  };
  const { mountSurface, authorizeSurface, disposeSurface } = await import("../surface-modules.js?view-listener-pending-dispose");
  const id = "fixture-view-listener-pending-dispose";
  recordOrigin(id, null, "test fixture");
  registerPlugin({ id, surface: () => null });
  const slot = document.querySelector("#slot");
  slot.dataset.nativeSurfaceId = id;
  const surface = {
    module: null, surfaceId: id, pluginId: id,
    declarations: { status: [], commands: [], element: [] }, sidecars: [],
    composition: { kind: "view", page: "ui/page.html" },
  };

  try {
    authorizeSurface(id);
    const mount = mountSurface(slot, surface);
    await drained();
    await disposeSurface(id);
    assert.equal(slot.querySelector(".surface-module-host"), null, "the surface was not removed before its mount ended");
    assert.deepEqual([...wire.unsubscribed].sort(), ["view-call", "view-presentation-abandoned", "view-responsiveness", "view-stopped"].sort(),
      "dispose must release resolved listeners without waiting for pending registrations");
    wire.release();
    wire.release();
    const [mountResult] = await Promise.allSettled([mount]);
    assert.equal(mountResult.status, "fulfilled", "disposing the mount must retain its cancellation result");
    assert.equal(mountResult.value, null, "a mount that the dispose cancelled resolved with a value");
    await untilReported(() => reports.includes("native listener cleanup: late listener cleanup failed")
      && reports.includes(`view listener registration after dispose: ${registrationError.message}`));
    assert.ok(reports.some((message) => message === "native listener cleanup: late listener cleanup failed"),
      "a late cleanup error must be reported");
    assert.ok(reports.some((message) => message === `view listener registration after dispose: ${registrationError.message}`),
      "a registration failure after disposal must be reported without changing cancellation");
  } finally {
    await disposeSurface(id);
    globalThis.dispatchEvent = originalDispatchEvent;
    dom.window.close();
  }
  wire.finish();
});

test("a rejected view listener registration releases successful listeners and rejects the mount", { timeout: 5000 }, async () => {
  const wire = selectPageWire("surface-remount-composition-listener-refused");
  const dom = new JSDOM("<main><div id=slot></div></main>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  dom.window.ResizeObserver = class { observe() {} disconnect() {} };
  dom.window.requestAnimationFrame = () => 1;
  dom.window.cancelAnimationFrame = () => {};
  const { mountSurface, disposeSurface, waitSurfaceCompositionDeclared, mountedSurface } = await import("../surface-modules.js?view-listener-registration-failure");
  const id = "fixture-view-listener-registration-failure";
  const pluginId = id;
  recordOrigin(id, null, "test fixture");
  registerPlugin({ id: pluginId, surface: () => null });
  const slot = document.querySelector("#slot");
  slot.dataset.nativeSurfaceId = id;
  const surface = {
    module: null, surfaceId: id, pluginId,
    declarations: { status: [], commands: [], element: [] }, sidecars: [],
    composition: { kind: "view", page: "ui/page.html" },
  };

  try {
    const mount = mountSurface(slot, surface);
    const wait = waitSurfaceCompositionDeclared(id);
    const [mountResult, waitResult] = await Promise.allSettled([mount, wait]);
    assert.equal(mountResult.status, "rejected", "listener setup failure must reject mount");
    assert.equal(mountResult.reason.message, "view-process-ended registration failed", "mount must preserve the original listener error");
    assert.equal(waitResult.status, "rejected", "listener setup failure must reject composition wait");
    assert.equal(waitResult.reason, mountResult.reason, "composition wait must preserve the original listener error");
    // The release of the successful registrations runs in the microtasks that follow the failure.
    await drained();
    assert.deepEqual([...wire.unsubscribed].sort(), ["view-call", "view-presentation-abandoned", "view-reply", "view-responsiveness", "view-stopped"].sort(),
      "every successful listener registration must be released");
    assert.equal(mountedSurface(id), null, "failed mount retained its mounted entry");
    assert.equal(slot.querySelector(".surface-module-host"), null, "failed mount retained its host");
    await flushEvents();
  } finally {
    await disposeSurface(id);
    dom.window.close();
  }
  wire.finish();
});


test("a listener failure before readiness reports an error and releases the view", { timeout: 5000 }, async () => {
  const wire = selectPageWire("surface-remount-composition-listener-before-ready");
  const dom = new JSDOM("<main><div id=slot></div></main>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  dom.window.ResizeObserver = class { observe() {} disconnect() {} };
  dom.window.requestAnimationFrame = () => 1;
  dom.window.cancelAnimationFrame = () => {};
  const states = [];
  const { mountSurface, authorizeSurface, disposeSurface, waitSurfaceCompositionDeclared, mountedSurface } = await import("../surface-modules.js?view-listener-after-ready");
  const id = "fixture-view-listener-after-ready";
  recordOrigin(id, null, "test fixture");
  registerPlugin({ id, surface: () => null });
  const slot = document.querySelector("#slot");
  slot.dataset.nativeSurfaceId = id;
  const surface = {
    module: null, surfaceId: id, pluginId: id,
    declarations: { status: [], commands: [], element: [] }, sidecars: [],
    composition: { kind: "view", page: "ui/page.html" },
  };

  try {
    authorizeSurface(id);
    const mounting = mountSurface(slot, surface, { onState: (state) => states.push(state) });
    const failure = await mounting.then(() => assert.fail("the mount of the failed registration resolved"), (error) => error);
    assert.match(failure.message, /view-process-ended registration failed before ready/);
    await assert.rejects(waitSurfaceCompositionDeclared(id), /view-process-ended registration failed before ready/);
    assert.equal(states.at(-1).phase, "error", "a post-readiness listener failure must reach surface status");
    assert.equal(states.at(-1).error, failure);
    await drained();
    assert.deepEqual([...wire.unsubscribed].sort(), ["view-call", "view-presentation-abandoned", "view-reply", "view-responsiveness", "view-stopped"].sort());
    assert.equal(wire.calls.filter(({ name }) => name === "compositionDeclare").length, 0, "a view with an incomplete listener setup declared its composition");
    assert.equal(mountedSurface(id), null, "post-readiness failure retained the mounted entry");
    await flushEvents();
  } finally {
    await disposeSurface(id);
    dom.window.close();
  }
  wire.finish();
});

test("disposing a surface ends its already-waiting composition declaration", { timeout: 5000 }, async () => {
  const wire = selectPageWire("surface-remount-composition-declaration-held");
  const dom = new JSDOM("<main><div id=slot></div></main>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  dom.window.ResizeObserver = class { observe() {} disconnect() {} };
  dom.window.requestAnimationFrame = () => 1;
  dom.window.cancelAnimationFrame = () => {};
  const { mountSurface, authorizeSurface, disposeSurface, waitSurfaceCompositionDeclared, compositionState } = await import("../surface-modules.js?composition-wait-dispose");
  const id = "fixture-composition-wait-dispose";
  recordOrigin(id, null, "test fixture");
  registerPlugin({ id, surface: () => null });
  const slot = document.querySelector("#slot");
  slot.dataset.nativeSurfaceId = id;
  const surface = {
    module: null, surfaceId: id, pluginId: id,
    declarations: { status: [], commands: [], element: [] }, sidecars: [],
    composition: { kind: "view", page: "ui/page.html" },
  };
  let answered = false;

  try {
    authorizeSurface(id);
    const mount = mountSurface(slot, surface);
    // The mount reaches the composition declaration in the microtasks that follow the authorization, and the case holds its answer.
    await drained();
    assert.equal(compositionState(id).state, "declaring", "the surface did not send its composition declaration");
    let waitOutcome;
    const wait = waitSurfaceCompositionDeclared(id).then(
      () => { waitOutcome = { status: "fulfilled" }; },
      (error) => { waitOutcome = { status: "rejected", error }; },
    );
    await disposeSurface(id);
    await wait;
    assert.equal(waitOutcome?.status, "rejected", "dispose did not end the existing composition wait");
    assert.match(waitOutcome.error.message, new RegExp(`surface ${id} was disposed before declaring composition`));

    wire.release();
    answered = true;
    await Promise.allSettled([mount, wait]);
  } finally {
    if (!answered && wire.calls.some(({ name }) => name === "compositionDeclare")) wire.release();
    await disposeSurface(id);
    dom.window.close();
  }
  wire.finish();
});

test("a drawn wait records a listener failure before the native view is declared", { timeout: 5000 }, async () => {
  const wire = selectPageWire("surface-remount-composition-drawn-retry");
  const dom = new JSDOM("<main><div id=slot></div></main>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  dom.window.ResizeObserver = class { observe() {} disconnect() {} };
  dom.window.requestAnimationFrame = () => 1;
  dom.window.cancelAnimationFrame = () => {};
  const registrationMessage = "view-process-ended registration failed before ready";
  let resolveErrorState;
  const errorReported = new Promise((resolve) => { resolveErrorState = resolve; });
  const { mountSurface, authorizeSurface, disposeSurface, mountedSurface, waitSurfaceCompositionAnswered } = await import("../surface-modules.js?view-attributed-failure");
  const { createPageLayout } = await import("../page-layout.js?view-attributed-failure");
  const id = "fixture-view-attributed-failure";
  recordOrigin(id, null, "test fixture");
  registerPlugin({ id, surface: () => null });
  const slot = document.querySelector("#slot");
  slot.dataset.nativeSurfaceId = id;
  const surface = {
    module: null, surfaceId: id, pluginId: id,
    declarations: { status: [], commands: [], element: [] }, sidecars: [],
    composition: { kind: "view", page: "ui/page.html" },
  };
  const page = createPageLayout({
    document, showError: () => {}, setVerify: () => {}, log: () => {}, surfaces: {}, plane: {}, compositor: {},
    textSize: () => 1, rendered: async () => {}, surfaceUnloaded: () => false, waitSurfaceCompositionAnswered,
  });
  let declared = false;

  try {
    authorizeSurface(id);
    const failedMount = mountSurface(slot, surface, { onState: (state) => { if (state.phase === "error") resolveErrorState(state); } });
    await errorReported;
    await assert.rejects(failedMount, /view-process-ended registration failed before ready/);
    assert.equal(mountedSurface(id), null, "the failed view registration mounted a native surface");
    assert.equal(slot.dataset.nativeSurfaceId, id, "the drawn layout no longer names the failed surface");
    await flushEvents();
    assert.deepEqual(failedMounts(wire), [{
      level: "error", event: "workbench.surface.mount.failed",
      fields: { plugin: id, surface: id, attempt: 1, phase: "mount", reason: registrationMessage },
    }]);
    await assert.rejects(page.drawn(), new RegExp(`surface ${id} mount attempt 1 failed during mount: ${registrationMessage}`));

    authorizeSurface(id);
    const retry = mountSurface(slot, surface);
    // The retry reaches its composition declaration in the microtasks that follow the authorization, and the case holds its answer.
    await drained();
    assert.equal(wire.calls.filter(({ name }) => name === "compositionDeclare").length, 1, "the retry did not send its composition declaration");
    // The retry draws after the composition finished, and not with the earlier failed attempt. The draw runs in microtasks until it
    // waits for the answer of the composition, so after the end of the microtask queue a draw that did not wait for it has ended.
    const order = [];
    const retryDraw = page.drawn().then(() => { order.push("ready"); }, (error) => { order.push(error); });
    await drained();
    assert.deepEqual(order, [], "the retry drew before its composition finished");
    order.push("finished");
    wire.release();
    declared = true;
    await Promise.all([retry, retryDraw]);
    assert.deepEqual(order, ["finished", "ready"], "a pending retry inherited the earlier failed attempt");
    await disposeSurface(id);
    await assert.rejects(page.drawn(), new RegExp(`surface ${id} is not mounted`),
      "normal disposal retained the completed mount registration");
  } finally {
    if (!declared && wire.calls.some(({ name }) => name === "compositionDeclare")) wire.release();
    await disposeSurface(id);
    dom.window.close();
  }
  wire.finish();
});

test("removing a pre-readiness listener failure from the desired plane clears its retained failure", { timeout: 5000 }, async () => {
  const wire = selectPageWire("surface-remount-composition-plane-cleanup");
  const dom = new JSDOM("<main><div id=slot></div></main>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  dom.window.ResizeObserver = class { observe() {} disconnect() {} };
  dom.window.requestAnimationFrame = () => 1;
  dom.window.cancelAnimationFrame = () => {};
  let resolveErrorState;
  const errorStateSeen = new Promise((resolve) => { resolveErrorState = resolve; });
  const { mountSurface, authorizeSurface, disposeSurface, disposeSurfacesExcept, waitSurfaceCompositionAnswered } = await import("../surface-modules.js?view-failure-plane-cleanup");
  const { createPageLayout } = await import("../page-layout.js?view-failure-plane-cleanup");
  const id = "fixture-view-failure-plane-cleanup";
  recordOrigin(id, null, "test fixture");
  registerPlugin({ id, surface: () => null });
  const slot = document.querySelector("#slot");
  slot.dataset.nativeSurfaceId = id;
  const surface = {
    module: null, surfaceId: id, pluginId: id,
    declarations: { status: [], commands: [], element: [] }, sidecars: [],
    composition: { kind: "view", page: "ui/page.html" },
  };
  const page = createPageLayout({
    document, showError: () => {}, setVerify: () => {}, log: () => {}, surfaces: {}, plane: {}, compositor: {},
    textSize: () => 1, rendered: async () => {}, surfaceUnloaded: () => false, waitSurfaceCompositionAnswered,
  });
  try {
    authorizeSurface(id);
    const mounting = mountSurface(slot, surface, { onState: (state) => { if (state.phase === "error") resolveErrorState(); } });
    await errorStateSeen;
    await assert.rejects(mounting, /listener failed before plane departure/);
    await assert.rejects(page.drawn(), /listener failed before plane departure/);
    await disposeSurfacesExcept(new Set());
    await assert.rejects(page.drawn(), new RegExp(`surface ${id} is not mounted`));
    await flushEvents();
  } finally {
    await disposeSurface(id);
    dom.window.close();
  }
  wire.finish();
});

test("a disposed pending listener setup cannot replace a newer attempt", { timeout: 5000 }, async () => {
  const wire = selectPageWire("surface-remount-composition-old-listener");
  const dom = new JSDOM("<main><div id=slot></div></main>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  dom.window.ResizeObserver = class { observe() {} disconnect() {} };
  dom.window.requestAnimationFrame = () => 1;
  dom.window.cancelAnimationFrame = () => {};
  let resolveErrorState;
  const errorReported = new Promise((resolve) => { resolveErrorState = resolve; });
  const { mountSurface, authorizeSurface, disposeSurface, mountedSurface, waitSurfaceCompositionAnswered } = await import("../surface-modules.js?view-old-failure");
  const { createPageLayout } = await import("../page-layout.js?view-old-failure");
  const id = "fixture-view-old-failure";
  // Resolves when the handler of the old listener failure reports it after the dispose.
  const oldFailureReported = Promise.withResolvers();
  const originalDispatchEvent = globalThis.dispatchEvent;
  globalThis.dispatchEvent = (event) => {
    if (event.message === "view listener registration after dispose: old disposed listener failed") oldFailureReported.resolve();
    return originalDispatchEvent?.call(globalThis, event) ?? true;
  };
  recordOrigin(id, null, "test fixture");
  registerPlugin({ id, surface: () => null });
  const slot = document.querySelector("#slot");
  slot.dataset.nativeSurfaceId = id;
  const surface = {
    module: null, surfaceId: id, pluginId: id,
    declarations: { status: [], commands: [], element: [] }, sidecars: [],
    composition: { kind: "view", page: "ui/page.html" },
  };
  const page = createPageLayout({
    document, showError: () => {}, setVerify: () => {}, log: () => {}, surfaces: {}, plane: {}, compositor: {},
    textSize: () => 1, rendered: async () => {}, surfaceUnloaded: () => false, waitSurfaceCompositionAnswered,
  });
  try {
    authorizeSurface(id);
    const oldMount = mountSurface(slot, surface, { onState: (state) => { if (state.phase === "error") resolveErrorState(state); } });
    await disposeSurface(id);
    await oldMount;
    authorizeSurface(id);
    const newMount = mountSurface(slot, surface, { onState: (state) => { if (state.phase === "error") resolveErrorState(state); } });
    const current = mountedSurface(id);
    // The case holds the registration of each mount; the first held registration is the old one, which the host refuses now.
    wire.release();
    await oldFailureReported.promise;
    assert.equal(mountedSurface(id), current, "an old listener failure removed the newer mounted attempt");
    await flushEvents();
    assert.deepEqual(failedMounts(wire), [],
      "a listener rejection after normal dispose was classified as a failed mount");
    wire.release();
    await errorReported;
    await assert.rejects(newMount, /new listener failed before readiness/);
    await flushEvents();
    assert.equal(failedMounts(wire).at(-1)?.fields.attempt, 2,
      "the new mount failure was attributed to the old attempt");
    await assert.rejects(page.drawn(), /mount attempt 2 failed during mount: new listener failed before readiness/);
  } finally {
    globalThis.dispatchEvent = originalDispatchEvent;
    await disposeSurface(id);
    dom.window.close();
  }
  wire.finish();
});

test("a disposing surface leaves the tabs with attached regions before its exposure disposal ends", { timeout: 5000 }, async () => {
  const wire = selectPageWire("surface-remount-composition-regions");
  const dom = new JSDOM("<main><div id=slot></div></main>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  dom.window.ResizeObserver = class { observe() {} disconnect() {} };
  dom.window.requestAnimationFrame = () => 1;
  dom.window.cancelAnimationFrame = () => {};
  const { mountSurface, authorizeSurface, disposeSurface, waitSurfaceCompositionDeclared } = await import("../surface-modules.js?dispose-regions");
  const id = "fixture-dispose-regions";
  recordOrigin(id, null, "test fixture");
  registerPlugin({ id, surface: () => null });
  const slot = document.querySelector("#slot");
  slot.dataset.nativeSurfaceId = id;
  const surface = {
    module: null, surfaceId: id, pluginId: id,
    declarations: { status: [], commands: [], element: [] }, sidecars: [],
    composition: { kind: "view", page: "ui/page.html" },
  };
  try {
    authorizeSurface(id);
    await mountSurface(slot, surface);
    await waitSurfaceCompositionDeclared(id);
    documentRegions.attached(id, "page");
    assert.ok(documentRegions.tabs().includes(id), "the fixture region did not attach");
    const disposal = disposeSurface(id, { released: true });
    // The host closes the regions with the released surface, so a session write that starts now must not ask them. The disposal
    // releases the regions in the call, before its cleanup continues in the microtasks that follow, so the exposure disposal has not ended here.
    assert.ok(!documentRegions.tabs().includes(id),
      `a disposing surface still lists attached regions: ${JSON.stringify(documentRegions.tabs())}`);
    await disposal;
  } finally {
    await disposeSurface(id);
    dom.window.close();
  }
  wire.finish();
});
