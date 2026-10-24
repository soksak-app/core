import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { registerPlugin } from "../registry.js";
import { endSourceOrigin, registerSourceOrigin, seedSourceOrigins, sourceOrigin } from "../source-origins.js";
import { viewCommandGenerationOf } from "../view-commands.js";
import { recordOrigin } from "../tab-reports.js";
import { setSurfaceTextSize } from "../text-size.js";
import { chooseSource } from "../declared-section.js";

setSurfaceTextSize(() => 1);

function sourceListenerMap() {
  return new class extends Map {
    set(name, listener) {
      return super.set(name, name === "view-call" || name === "view-process-ended"
        ? (event = {}) => listener({ ...event, generation: event.generation ?? 1 })
        : listener);
    }
  }();
}

function seedViewSource(plugin, surface, generation = 1) {
  seedSourceOrigins({ floor: generation, pluginHosts: {}, views: { [surface]: generation } });
}

test("a queued view call from a retired source generation does not reach the replacement command layer", { timeout: 5000 }, async (t) => {
  const dom = new JSDOM("<main><div id=slot></div></main>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  dom.window.ResizeObserver = class { observe() {} disconnect() {} };
  dom.window.requestAnimationFrame = () => 1;
  dom.window.cancelAnimationFrame = () => {};
  const listeners = sourceListenerMap();
  const replies = [];
  const actualHost = await import("../host.js");
  const actualSourceOrigins = await import("../source-origins.js");
  t.mock.module("../source-origins.js", { exports: {
    ...actualSourceOrigins,
    sourceOrigin: (_plugin, surface) => surface === "fixture-generation-surface" ? 2 : undefined,
  } });
  t.mock.module("../host.js", { exports: {
    ...actualHost,
    native: true,
    onSurfacePrepared: () => () => {},
    surfaceContextRuntime: (surface, declarations) => {
      const runtime = actualHost.surfaceContextRuntime(surface, declarations);
      return { ...runtime, native: { ...runtime.native, on: async (name, listener) => {
        listeners.set(name, listener);
        return () => {};
      }, call: async (name, payload) => {
        if (name === "viewReply") replies.push(payload);
        return null;
      } } };
    },
  } });
  const { mountSurface, authorizeSurface, disposeSurface } = await import("../surface-modules.js?view-source-generation");
  const pluginId = "fixture-generation-plugin";
  const surfaceId = "fixture-generation-surface";
  recordOrigin(surfaceId, null, "test fixture");
  registerPlugin({ id: pluginId, surface: () => null });
  const surface = { module: null, surfaceId, pluginId, declarations: { status: [], commands: [], dom: [] }, sidecars: [], composition: { kind: "view", page: "ui/page.html" } };
  try {
    authorizeSurface(surfaceId);
    seedViewSource(pluginId, surfaceId);
    await mountSurface(document.querySelector("#slot"), surface);
    listeners.get("view-call")({ surface: surfaceId, plugin: pluginId, generation: 1, id: 1, command: "runtime.settings.read", params: null });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(replies, [], "the old view call reached the replacement command layer");

    listeners.get("view-call")({ surface: surfaceId, plugin: pluginId, generation: 2, id: 2, command: "runtime.settings.read", params: null });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(replies, [{ id: 2, result: {}, generation: 2 }], "the current view call did not reply with its source generation");
  } finally {
    await disposeSurface(surfaceId);
    dom.window.close();
  }
});

test("a view mount waits for its actual source registration before serving the first call", { timeout: 5000 }, async (t) => {
  const dom = new JSDOM("<main><div id=slot></div></main>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  dom.window.ResizeObserver = class { observe() {} disconnect() {} };
  dom.window.requestAnimationFrame = () => 1;
  dom.window.cancelAnimationFrame = () => {};
  const listeners = new Map();
  const calls = [];
  const replies = [];
  const actualHost = await import("../host.js");
  t.mock.module("../host.js", { exports: {
    ...actualHost,
    native: true,
    onSurfacePrepared: () => () => {},
    surfaceContextRuntime: (surface, declarations) => {
      const runtime = actualHost.surfaceContextRuntime(surface, declarations);
      return { ...runtime, native: { ...runtime.native, on: async (name, listener) => {
        listeners.set(name, listener);
        return () => listeners.delete(name);
      }, call: async (name, payload) => {
        calls.push({ name, payload });
        if (name === "viewReply") replies.push(payload);
        if (name === "compositionDeclare") {
          assert.ok(listeners.has("view-call"), "view-call listener was not installed before composition declaration");
          assert.ok(listeners.has("view-reply"), "view-reply listener was not installed before composition declaration");
        }
        return null;
      } } };
    },
  } });
  const { mountSurface, authorizeSurface, disposeSurface, waitSurfaceCompositionDeclared } = await import("../surface-modules.js?view-delayed-source-origin");
  const pluginId = "fixture-view-delayed-origin";
  const surfaceId = "fixture-view-delayed-origin-surface";
  recordOrigin(surfaceId, null, "test fixture");
  registerPlugin({ id: pluginId, surface: () => null });
  const surface = { module: null, surfaceId, pluginId, declarations: { status: [], commands: [], dom: [] }, sidecars: [], composition: { kind: "view", page: "ui/page.html" } };
  try {
    authorizeSurface(surfaceId);
    seedSourceOrigins({ floor: 0, pluginHosts: {}, views: {} });
    await mountSurface(document.querySelector("#slot"), surface);
    await waitSurfaceCompositionDeclared(surfaceId);
    assert.equal(calls.some(({ name }) => name === "viewRequest"), false, "mount invented a view command generation");
    listeners.get("view-call")({ surface: surfaceId, plugin: pluginId, generation: 1, id: 1, command: "runtime.settings.read", params: null });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(replies, [], "an unregistered generation was served");
    assert.equal(registerSourceOrigin(pluginId, surfaceId, 1), true, "the native source registration was not accepted");
    assert.equal(viewCommandGenerationOf(surfaceId), 1, "registration did not bind the command layer before the first call");
    assert.equal(endSourceOrigin(pluginId, surfaceId, 1), true, "the source end did not retire its exact generation");
    listeners.get("view-process-ended")({ surface: surfaceId, plugin: pluginId, generation: 1 });
    assert.equal(viewCommandGenerationOf(surfaceId), null, "process end did not release the commands of the ended document");

    assert.equal(registerSourceOrigin(pluginId, surfaceId, 2), true, "the replacement source registration was not accepted");
    assert.equal(viewCommandGenerationOf(surfaceId), 2, "the replacement registration did not bind its own command layer");
    listeners.get("view-process-ended")({ surface: surfaceId, plugin: pluginId, generation: 1 });
    assert.equal(viewCommandGenerationOf(surfaceId), 2, "a late old process end removed the replacement command layer");
    listeners.get("view-call")({ surface: surfaceId, plugin: pluginId, generation: 2, id: 2, command: "runtime.settings.read", params: null });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(replies, [{ id: 2, result: {}, generation: 2 }], "the first current call was not served after actual registration");
  } finally {
    await disposeSurface(surfaceId);
    dom.window.close();
  }
});

test("a retained view reads the text scale of its stored owner card", { timeout: 5000 }, async (t) => {
  const dom = new JSDOM("<main></main>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  dom.window.ResizeObserver = class { observe() {} disconnect() {} };
  dom.window.requestAnimationFrame = () => 1;
  dom.window.cancelAnimationFrame = () => {};
  const listeners = new Map();
  const replies = [];
  const actualHost = await import("../host.js");
  const actualEnvironment = await import("../environment.js");
  t.mock.module("../host.js", { exports: {
    ...actualHost,
    native: true,
    onSurfacePrepared: () => () => {},
    surfaceContextRuntime: (surface, declarations) => {
      const runtime = actualHost.surfaceContextRuntime(surface, declarations);
      return { ...runtime, native: { ...runtime.native, on: async (name, listener) => {
        listeners.set(name, listener);
        return () => listeners.delete(name);
      }, call: async (name, payload) => {
        if (name === "viewReply") replies.push(payload);
        return null;
      } } };
    },
  } });
  t.mock.module("../environment.js", { exports: { ...actualEnvironment, pluginDiagnostics: async () => null } });
  let liveScale = null;
  setSurfaceTextSize(() => liveScale);
  const { prepareRetainedSurface, releaseRetainedSurfaceSlots } = await import("../retained-surface-mounts.js");
  const { authorizeSurface, disposeSurface } = await import("../surface-modules.js");
  const pluginId = "fixture-retained-text-size";
  const surfaceId = "fixture-retained-text-size-tab";
  const ownerCard = { data: { textSize: 1.25 } };
  let frameFactor = 1.5;
  const retainedTextSize = () => frameFactor * (ownerCard.data?.textSize ?? 1);
  const surface = { module: null, surfaceId, pluginId, declarations: { status: [], commands: [], dom: [] }, sidecars: [],
    composition: { kind: "view", page: "ui/page.html" } };
  recordOrigin(surfaceId, null, "test fixture");
  registerPlugin({ id: pluginId, surface: () => null });
  seedViewSource(pluginId, surfaceId);
  try {
    authorizeSurface(surfaceId);
    await prepareRetainedSurface({
      id: surfaceId, surface,
      retainedTextSize,
    });
    listeners.get("view-call")({ surface: surfaceId, plugin: pluginId, generation: 1,
      id: 1, command: "runtime.textSize.read", params: null });
    for (let turn = 0; replies.length === 0 && turn < 10; turn += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(replies, [{ id: 1, result: 1.875, generation: 1 }],
      "a cold retained view did not read frame scale multiplied by its stored owner-card scale");
    frameFactor = 2;
    ownerCard.data.textSize = 1.5;
    listeners.get("view-call")({ surface: surfaceId, plugin: pluginId, generation: 1,
      id: 2, command: "runtime.textSize.read", params: null });
    for (let turn = 0; replies.length < 2 && turn < 10; turn += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(replies, [
      { id: 1, result: 1.875, generation: 1 },
      { id: 2, result: 1.875, generation: 1 },
    ], "a mounted retained view changed its cached scale while it remained outside the plane");
    liveScale = 3;
    listeners.get("view-call")({ surface: surfaceId, plugin: pluginId, generation: 1,
      id: 3, command: "runtime.textSize.read", params: null });
    for (let turn = 0; replies.length < 3 && turn < 10; turn += 1) await new Promise((resolve) => setImmediate(resolve));
    liveScale = null;
    listeners.get("view-call")({ surface: surfaceId, plugin: pluginId, generation: 1,
      id: 4, command: "runtime.textSize.read", params: null });
    for (let turn = 0; replies.length < 4 && turn < 10; turn += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(replies, [
      { id: 1, result: 1.875, generation: 1 },
      { id: 2, result: 1.875, generation: 1 },
      { id: 3, result: 3, generation: 1 },
      { id: 4, result: 3, generation: 1 },
    ], "a retained view did not adopt the live plane scale and retain it after leaving the plane");
  } finally {
    releaseRetainedSurfaceSlots({ surfaces: [] }, new Set());
    await disposeSurface(surfaceId);
    setSurfaceTextSize(() => 1);
    dom.window.close();
  }
});

test("a view declares its composition only after native call listeners are ready", { timeout: 5000 }, async (t) => {
  const dom = new JSDOM("<main><div id=slot></div></main>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  dom.window.ResizeObserver = class { observe() {} disconnect() {} };
  dom.window.requestAnimationFrame = () => 1;
  dom.window.cancelAnimationFrame = () => {};
  const listeners = new Map();
  const registrations = [];
  const calls = [];
  const replies = [];
  let startViewCallRegistration;
  const viewCallRegistration = new Promise((resolve) => { startViewCallRegistration = resolve; });
  const actualHost = await import("../host.js");
  const actualEnvironment = await import("../environment.js");
  t.mock.module("../host.js", { exports: {
    ...actualHost,
    native: true,
    onSurfacePrepared: () => () => {},
    surfaceContextRuntime: (surface, declarations) => {
      const runtime = actualHost.surfaceContextRuntime(surface, declarations);
      return { ...runtime, native: { ...runtime.native, on: (name, listener) => {
        if (name === "view-call") startViewCallRegistration();
        if (name !== "view-call" && name !== "view-reply") {
          listeners.set(name, listener);
          return Promise.resolve(() => { if (listeners.get(name) === listener) listeners.delete(name); });
        }
        return new Promise((resolve) => registrations.push(() => {
          listeners.set(name, listener);
          resolve(() => { if (listeners.get(name) === listener) listeners.delete(name); });
        }));
      }, call: async (name, payload) => {
        calls.push({ name, payload });
        if (name === "viewReply") replies.push(payload);
        return null;
      } } };
    },
  } });
  t.mock.module("../environment.js", { exports: { ...actualEnvironment, pluginDiagnostics: async () => null } });
  const { mountSurface, authorizeSurface, disposeSurface, waitSurfaceCompositionDeclared } = await import("../surface-modules.js?view-listener-ready");
  const pluginId = "fixture-view-listener-ready";
  const surfaceId = "fixture-view-listener-ready-surface";
  recordOrigin(surfaceId, null, "test fixture");
  registerPlugin({ id: pluginId, surface: () => null });
  const surface = { module: null, surfaceId, pluginId, declarations: { status: [], commands: [], dom: [] }, sidecars: [], composition: { kind: "view", page: "ui/page.html" } };
  let mounting;
  try {
    seedSourceOrigins({ floor: 1, pluginHosts: {}, views: { [surfaceId]: 1 } });
    mounting = mountSurface(document.querySelector("#slot"), surface);
    authorizeSurface(surfaceId);
    await viewCallRegistration;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.some(({ name }) => name === "compositionDeclare"), false,
      "composition was declared before the native view-call listener registration settled");

    for (const finish of registrations.splice(0)) finish();
    await mounting;
    await waitSurfaceCompositionDeclared(surfaceId);
    assert.ok(listeners.has("view-call"), "view-call listener was not ready when composition was declared");
    assert.ok(listeners.has("view-reply"), "view-reply listener was not ready when composition was declared");
    const call = listeners.get("view-call");
    call({ surface: surfaceId, plugin: pluginId, generation: 1, id: 1, command: "runtime.textSize.read", params: null });
    call({ surface: surfaceId, plugin: pluginId, generation: 1, id: 2, command: "runtime.native.on", params: { name: "exposure-request" } });
    for (let turn = 0; replies.length < 2 && turn < 10; turn += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(replies, [
      { id: 1, result: 1, generation: 1 },
      { id: 2, result: null, generation: 1 },
    ]);
  } finally {
    for (const finish of registrations.splice(0)) finish();
    if (mounting) await mounting.catch(() => {});
    await disposeSurface(surfaceId);
    dom.window.close();
  }
});

// A view surface has no module: the host loads its page into the view. Mounting it imports nothing and declares its view composition
// (docs/spec/plugins.md#view-surfaces), so a core command that waits for the declaration of the surface does not wait for a module.
test("mounting a view surface imports no module and declares its view composition", { timeout: 5000 }, async (t) => {
  const dom = new JSDOM("<main><div id=slot></div></main>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  dom.window.ResizeObserver = class { observe() {} disconnect() {} };
  dom.window.requestAnimationFrame = () => 1;
  dom.window.cancelAnimationFrame = () => {};
  const calls = [];
  const actualHost = await import("../host.js");
  t.mock.module("../host.js", { exports: {
    ...actualHost,
    native: true,
    onSurfacePrepared: () => () => {},
    surfaceContextRuntime: (surface, declarations) => {
      const runtime = actualHost.surfaceContextRuntime(surface, declarations);
      // The view answers its calls on view-call, which the fake host does not deliver, so its listener is a no-op.
      return { ...runtime, native: { ...runtime.native, on: async () => () => {}, call: async (name, payload) => {
        calls.push({ name, payload });
        return null;
      } } };
    },
  } });
  const { mountSurface, authorizeSurface, disposeSurface, waitSurfaceCompositionDeclared } = await import("../surface-modules.js?view");
  const pluginId = "fixture-view";
  const surfaceId = "fixture-view-surface";
  recordOrigin(surfaceId, null, "test fixture");
  registerPlugin({ id: pluginId, surface: () => null });
  const composition = { kind: "view", page: "ui/page.html" };
  const surface = { module: null, surfaceId, pluginId, declarations: { status: [], commands: [], dom: [] }, sidecars: [], composition };
  try {
    authorizeSurface(surfaceId);
    seedViewSource(pluginId, surfaceId);
    await mountSurface(document.querySelector("#slot"), surface);
    await waitSurfaceCompositionDeclared(surfaceId);
    assert.deepEqual(calls.filter(({ name }) => name === "compositionDeclare"), [{
      name: "compositionDeclare", payload: { plugin: pluginId, composition },
    }]);
  } finally {
    await disposeSurface(surfaceId);
    dom.window.close();
  }
});

// A view surface is ready once its composition is declared: the card leaves the loading state, as a module surface does after its module mounts.
test("a view surface reports phase ready after its view declares its composition", { timeout: 5000 }, async (t) => {
  const dom = new JSDOM("<main><div id=slot></div></main>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  dom.window.ResizeObserver = class { observe() {} disconnect() {} };
  dom.window.requestAnimationFrame = () => 1;
  dom.window.cancelAnimationFrame = () => {};
  const calls = [];
  const actualHost = await import("../host.js");
  t.mock.module("../host.js", { exports: {
    ...actualHost,
    native: true,
    onSurfacePrepared: () => () => {},
    surfaceContextRuntime: (surface, declarations) => {
      const runtime = actualHost.surfaceContextRuntime(surface, declarations);
      return { ...runtime, native: { ...runtime.native, on: async () => () => {}, call: async (name, payload) => {
        calls.push({ name, payload });
        return null;
      } } };
    },
  } });
  const { mountSurface, authorizeSurface, disposeSurface } = await import("../surface-modules.js?view-ready");
  const pluginId = "fixture-ready-view";
  const surfaceId = "fixture-ready-view-surface";
  recordOrigin(surfaceId, null, "test fixture");
  registerPlugin({ id: pluginId, surface: () => null });
  const composition = { kind: "view", page: "ui/page.html" };
  const surface = { module: null, surfaceId, pluginId, declarations: { status: [], commands: [], dom: [] }, sidecars: [], composition };
  const states = [];
  try {
    authorizeSurface(surfaceId);
    // The mount resolves after the composition is declared, so the last state is the state after the declaration.
    seedViewSource(pluginId, surfaceId);
    await mountSurface(document.querySelector("#slot"), surface, { onState: (state) => states.push(state) });
    assert.ok(calls.some(({ name }) => name === "compositionDeclare"), "the view did not declare its composition");
    assert.equal(states.at(-1).phase, "ready", `the surface phase after its composition declaration is ${states.at(-1).phase}`);
  } finally {
    await disposeSurface(surfaceId);
    dom.window.close();
  }
});

// The receipt of a view call and its reply are written at the debug level, so a call that never replies shows as a receipt without a reply.
test("a view call writes receipt and reply records with its source generation", { timeout: 5000 }, async (t) => {
  const dom = new JSDOM("<main><div id=slot></div></main>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  dom.window.ResizeObserver = class { observe() {} disconnect() {} };
  dom.window.requestAnimationFrame = () => 1;
  dom.window.cancelAnimationFrame = () => {};
  const listeners = sourceListenerMap();
  const replies = [];
  let replied;
  const replyArrived = new Promise((resolve) => { replied = resolve; });
  const actualHost = await import("../host.js");
  t.mock.module("../host.js", { exports: {
    ...actualHost,
    native: true,
    onSurfacePrepared: () => () => {},
    surfaceContextRuntime: (surface, declarations) => {
      const runtime = actualHost.surfaceContextRuntime(surface, declarations);
      return { ...runtime, native: { ...runtime.native, on: async (name, listener) => {
        listeners.set(name, listener);
        return () => {};
      }, call: async (name, payload) => {
        if (name === "viewReply") {
          replies.push(payload);
          replied();
        }
        return null;
      } } };
    },
  } });
  const emitted = [];
  const actualPageLog = await import("../page-log.js");
  t.mock.module("../page-log.js", { exports: { ...actualPageLog, emitEvent: (level, event, fields) => emitted.push({ level, event, fields }) } });
  const { mountSurface, authorizeSurface, disposeSurface } = await import("../surface-modules.js?view-records");
  const pluginId = "fixture-records-view";
  const surfaceId = "fixture-records-view-surface";
  recordOrigin(surfaceId, null, "test fixture");
  registerPlugin({ id: pluginId, surface: () => null });
  const composition = { kind: "view", page: "ui/page.html" };
  const surface = { module: null, surfaceId, pluginId, declarations: { status: [], commands: [], dom: [] }, sidecars: [], composition };
  try {
    authorizeSurface(surfaceId);
    seedViewSource(pluginId, surfaceId);
    await mountSurface(document.querySelector("#slot"), surface, { onState: () => {} });
    listeners.get("view-call")({ generation: 1, id: 7, command: "runtime.settings.read", params: null });
    // The reply is sent after the call has settled, so the test waits for the viewReply call.
    await replyArrived;
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(emitted.filter(({ event }) => event === "page.view.call"), [{ level: "debug", event: "page.view.call",
      fields: { plugin: pluginId, surface: surfaceId, generation: 1, id: 7, command: "runtime.settings.read" } }]);
    assert.deepEqual(emitted.filter(({ event }) => event === "page.view.reply"), [{ level: "debug", event: "page.view.reply",
      fields: { plugin: pluginId, surface: surfaceId, generation: 1, id: 7, outcome: "result" } }]);
    assert.deepEqual(replies, [{ id: 7, result: {}, generation: 1 }]);
  } finally {
    await disposeSurface(surfaceId);
    dom.window.close();
  }
});

// The text size registration of a view resolves with a promise of its off function (docs/spec/native-surfaces.md, view subscriptions).
test("a view subscription to the text size resolves with a result", { timeout: 5000 }, async (t) => {
  const dom = new JSDOM("<main><div id=slot></div></main>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  dom.window.ResizeObserver = class { observe() {} disconnect() {} };
  dom.window.requestAnimationFrame = () => 1;
  dom.window.cancelAnimationFrame = () => {};
  const listeners = sourceListenerMap();
  const replies = [];
  let replied;
  const replyArrived = new Promise((resolve) => { replied = resolve; });
  const actualHost = await import("../host.js");
  t.mock.module("../host.js", { exports: {
    ...actualHost,
    native: true,
    onSurfacePrepared: () => () => {},
    surfaceContextRuntime: (surface, declarations) => {
      const runtime = actualHost.surfaceContextRuntime(surface, declarations);
      return { ...runtime, native: { ...runtime.native, on: async (name, listener) => {
        listeners.set(name, listener);
        return () => {};
      }, call: async (name, payload) => {
        if (name === "viewReply") {
          replies.push(payload);
          replied();
        }
        return null;
      } } };
    },
  } });
  const emitted = [];
  const actualPageLog = await import("../page-log.js");
  t.mock.module("../page-log.js", { exports: { ...actualPageLog, emitEvent: (level, event, fields) => emitted.push({ level, event, fields }) } });
  const { mountSurface, authorizeSurface, disposeSurface } = await import("../surface-modules.js?view-text-size");
  const pluginId = "fixture-text-size-view";
  const surfaceId = "fixture-text-size-view-surface";
  recordOrigin(surfaceId, null, "test fixture");
  registerPlugin({ id: pluginId, surface: () => null });
  const composition = { kind: "view", page: "ui/page.html" };
  const surface = { module: null, surfaceId, pluginId, declarations: { status: [], commands: [], dom: [] }, sidecars: [], composition };
  try {
    authorizeSurface(surfaceId);
    seedViewSource(pluginId, surfaceId);
    await mountSurface(document.querySelector("#slot"), surface, { onState: () => {} });
    listeners.get("view-call")({ id: 8, command: "runtime.textSize.on", params: null });
    await replyArrived;
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(emitted.filter(({ event }) => event === "page.view.reply"), [{ level: "debug", event: "page.view.reply",
      fields: { plugin: pluginId, surface: surfaceId, id: 8, outcome: "result" } }]);
    assert.deepEqual(replies.map(({ id, result }) => ({ id, result })), [{ id: 8, result: null }]);
  } finally {
    await disposeSurface(surfaceId);
    dom.window.close();
  }
});

// contract: view.restart.limit-shows-error
// The view-stopped event of the surface is shown as the error state of the surface, and mounting the surface again replaces that state.
test("a view that stopped its restarts shows its reason as the error state of its surface until it is mounted again", { timeout: 5000 }, async (t) => {
  const dom = new JSDOM("<main><div id=slot></div></main>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  dom.window.ResizeObserver = class { observe() {} disconnect() {} };
  dom.window.requestAnimationFrame = () => 1;
  dom.window.cancelAnimationFrame = () => {};
  const listeners = sourceListenerMap();
  const actualHost = await import("../host.js");
  t.mock.module("../host.js", { exports: {
    ...actualHost,
    native: true,
    onSurfacePrepared: () => () => {},
    surfaceContextRuntime: (surface, declarations) => {
      const runtime = actualHost.surfaceContextRuntime(surface, declarations);
      // The fake host delivers an event to the listener of its name, as the surface runtime does for its own surface.
      return { ...runtime, native: { ...runtime.native, on: async (name, listener) => {
        listeners.set(name, listener);
        return () => {};
      }, call: async () => null } };
    },
  } });
  const { mountSurface, authorizeSurface, disposeSurface, waitSurfaceCompositionDeclared } = await import("../surface-modules.js?view-stop");
  const pluginId = "fixture-stopped-view";
  const surfaceId = "fixture-stopped-view-surface";
  recordOrigin(surfaceId, null, "test fixture");
  registerPlugin({ id: pluginId, surface: () => null });
  const composition = { kind: "view", page: "ui/page.html" };
  const surface = { module: null, surfaceId, pluginId, declarations: { status: [], commands: [], dom: [] }, sidecars: [], composition };
  const reason = "the view failed 4 times within 300 seconds and is created again when its tab is reopened";
  try {
    authorizeSurface(surfaceId);
    const states = [];
    seedViewSource(pluginId, surfaceId);
    await mountSurface(document.querySelector("#slot"), surface, { onState: (state) => states.push(state) });
    await waitSurfaceCompositionDeclared(surfaceId);
    listeners.get("view-stopped")({ surface: surfaceId, plugin: pluginId, reason });
    const stopped = states.at(-1);
    assert.equal(stopped.phase, "error");
    assert.equal(stopped.error.message, reason);

    await disposeSurface(surfaceId);
    authorizeSurface(surfaceId);
    const reopened = [];
    seedViewSource(pluginId, surfaceId);
    await mountSurface(document.querySelector("#slot"), surface, { onState: (state) => reopened.push(state) });
    assert.notEqual(reopened.at(-1).phase, "error", "mounting the surface again shows no error");
  } finally {
    await disposeSurface(surfaceId);
    dom.window.close();
  }
});

// contract: view.responsiveness.relay
// The view-responsiveness event of a view is the state of its surface in core.plugin.views, and dispose removes that state.
test("a view responsiveness notice is the state of its surface until the surface is disposed", { timeout: 20000 }, async (t) => {
  const dom = new JSDOM("<main><div id=slot></div></main>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  dom.window.ResizeObserver = class { observe() {} disconnect() {} };
  dom.window.requestAnimationFrame = () => 1;
  dom.window.cancelAnimationFrame = () => {};
  const listeners = sourceListenerMap();
  const emitted = [];
  const actualHost = await import("../host.js");
  t.mock.module("../host.js", { exports: {
    ...actualHost,
    native: true,
    onSurfacePrepared: () => () => {},
    surfaceContextRuntime: (surface, declarations) => {
      const runtime = actualHost.surfaceContextRuntime(surface, declarations);
      return { ...runtime, native: { ...runtime.native, on: async (name, listener) => {
        listeners.set(name, listener);
        return () => {};
      }, call: async () => null } };
    },
  } });
  const actualPageLog = await import("../page-log.js");
  t.mock.module("../page-log.js", { exports: { ...actualPageLog,
    emitEvent: (level, event, fields) => emitted.push({ level, event, fields }) } });
  const { mountSurface, authorizeSurface, disposeSurface, waitSurfaceCompositionDeclared } = await import("../surface-modules.js?view-responsive");
  const { views } = await import("../plugin-processes.js");
  const pluginId = "fixture-responsive-view";
  const surfaceId = "fixture-responsive-view-surface";
  recordOrigin(surfaceId, null, "test fixture");
  registerPlugin({ id: pluginId, surface: () => null });
  const composition = { kind: "view", page: "ui/page.html" };
  const surface = { module: null, surfaceId, pluginId, declarations: { status: [], commands: [], dom: [] }, sidecars: [], composition };
  const ofSurface = () => views().filter((entry) => entry.surface === surfaceId);
  try {
    authorizeSurface(surfaceId);
    seedViewSource(pluginId, surfaceId);
    await mountSurface(document.querySelector("#slot"), surface, { onState: () => {} });
    await waitSurfaceCompositionDeclared(surfaceId);
    listeners.get("view-responsiveness")({ surface: surfaceId, plugin: pluginId, generation: 1, responsive: false });
    assert.deepEqual(ofSurface(), [{ plugin: pluginId, surface: surfaceId, responsive: false }]);
    listeners.get("view-responsiveness")({ surface: surfaceId, plugin: pluginId, generation: 1, responsive: true });
    assert.deepEqual(ofSurface(), [{ plugin: pluginId, surface: surfaceId, responsive: true }]);
    assert.equal(registerSourceOrigin(pluginId, surfaceId, 2), true, "the replacement source did not advance its generation");
    listeners.get("view-responsiveness")({ surface: surfaceId, plugin: pluginId, generation: 1, responsive: false });
    assert.deepEqual(ofSurface(), [{ plugin: pluginId, surface: surfaceId, responsive: true }],
      "a delayed responsiveness notice of the retired view changed the replacement state");
    listeners.get("view-responsiveness")({ surface: surfaceId, plugin: pluginId, generation: 2, responsive: false });
    assert.deepEqual(ofSurface(), [{ plugin: pluginId, surface: surfaceId, responsive: false }],
      "the current generation responsiveness notice was not applied");
    assert.deepEqual(emitted.filter(({ event }) => event === "page.view.event.cancel").map(({ fields }) => fields), [
      { plugin: pluginId, surface: surfaceId, event: "view-responsiveness" },
    ], "the stale notice cancellation was not recorded");
    await disposeSurface(surfaceId);
    assert.deepEqual(ofSurface(), [], "dispose removes the responsiveness of the surface");
  } finally {
    await disposeSurface(surfaceId);
    dom.window.close();
  }
});

// The start values of a view (docs/spec/native-surfaces.md#view-surfaces): the host injects them as window.sokSurface before the
// page of the view runs. origin is the directory that the tab that opened the tab recorded, and project is the project that the
// window shows, or null.
test("the start values of a view carry its params, origin, project and declarations", async () => {
  const { viewStartValues } = await import("../surface-modules.js?view-start");
  const { reportDirectory } = await import("../tab-reports.js");
  reportDirectory("tab-with-directory", "/work/one");
  recordOrigin("tab-of-directory", "tab-with-directory", "test fixture");
  const surface = { surfaceId: "tab-of-directory", params: { path: "a.md" }, declarations: { commands: [] } };
  assert.deepEqual(viewStartValues(surface, { id: "prj-one", root: "/work/one" }), {
    params: { path: "a.md" },
    origin: { directory: "/work/one" },
    project: { id: "prj-one", root: "/work/one" },
    declarations: { status: [], commands: [], dom: [] },
  });
  recordOrigin("tab-without-directory", null, "test fixture");
  assert.deepEqual(viewStartValues({ surfaceId: "tab-without-directory", declarations: {} }, null), {
    params: null,
    origin: { directory: null },
    project: null,
    declarations: { status: [], commands: [], dom: [] },
  });
});

// A tab whose origin was pruned from the layout memory while it was out of the displayed layout is refused at its presentation. The
// refusal names the tab, its plugin, space and project, the path that created it, and whether this session recorded its origin.
test("a view whose origin is missing names the tab, its plugin, space, project, creation path and session history", async () => {
  const { viewStartValues } = await import("../surface-modules.js?view-origin-record");
  const { forgetTabsLeft, recordOrigin, storedLayoutState } = await import("../tab-reports.js");
  recordOrigin("tab-pruned", null, "new tab");
  const previous = [{ id: "card-pruned", data: { tabs: [{ id: "tab-pruned", plugin: "fixture-view" }] } }];
  storedLayoutState({ cards: previous });
  forgetTabsLeft(previous, []);
  assert.throws(() => viewStartValues({ surfaceId: "tab-pruned", pluginId: "fixture-view", declarations: {} }, null), (error) => {
    assert.equal(error.message, "tab tab-pruned has no origin: plugin fixture-view, space none, project none, created by new tab, held by this session: yes");
    return true;
  });
});

// contract: view.exposure.register
// A registered call of the view applies the entry through the exposure registry, relays it to the host, and the view's port
// consumes the forwarded exposure requests so the page never forwards them twice (docs/spec/exposure.md#relay).
test("a view registers its exposure through the page and its port consumes forwarded requests", { timeout: 20000 }, async (t) => {
  const dom = new JSDOM("<main><div id=slot></div></main>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  dom.window.ResizeObserver = class { observe() {} disconnect() {} };
  dom.window.requestAnimationFrame = () => 1;
  dom.window.cancelAnimationFrame = () => {};
  const listeners = sourceListenerMap();
  const calls = [];
  const actualHost = await import("../host.js");
  t.mock.module("../host.js", { exports: {
    ...actualHost,
    native: true,
    onSurfacePrepared: () => () => {},
    surfaceContextRuntime: (surface, declarations) => {
      const runtime = actualHost.surfaceContextRuntime(surface, declarations);
      return { ...runtime, native: { ...runtime.native, on: async (name, listener) => {
        listeners.set(name, listener);
        return () => {};
      }, call: async (name, payload) => {
        // The surface runtime scopes every host call with the surface id, as surfaceContextRuntime.invoke does.
        calls.push({ name, payload: { ...(payload ?? {}), surface: surface.surfaceId } });
        return null;
      } } };
    },
  } });
  // The registry and the port live in the shared exposure module, which the query-suffixed surface-modules instance imports too.
  const { registry, dispatchSurfaceRequest } = await import("../exposure.js");
  const { mountSurface, authorizeSurface, disposeSurface } = await import("../surface-modules.js?view-exp");
  const pluginId = "fixture-exp";
  const surfaceId = "fixture-exp-surface";
  recordOrigin(surfaceId, null, "test fixture");
  registry.configure({ surfacePlugin: () => pluginId });
  registry.declare(pluginId, {
    status: [{ name: `${pluginId}.lines`, description: "Lines.", schema: { type: "array" } }],
    commands: [], dom: [],
  });
  registerPlugin({ id: pluginId, surface: () => null });
  const composition = { kind: "view", page: "ui/page.html" };
  const surface = { module: null, surfaceId, pluginId, declarations: { status: [], commands: [], dom: [] }, sidecars: [], composition };
  try {
    authorizeSurface(surfaceId);
    seedViewSource(pluginId, surfaceId);
    await mountSurface(document.querySelector("#slot"), surface);
    listeners.get("view-call")({ surface: surfaceId, plugin: pluginId, id: 1, command: "runtime.native.call",
      params: { name: "registered", payload: { kind: "status", name: `${pluginId}.lines` } } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(registry.registrants("status", `${pluginId}.lines`), [surfaceId], "the registration did not reach the registry");
    assert.deepEqual(calls.filter(({ name }) => name === "exposureRegister"), [{
      name: "exposureRegister", payload: { kind: "status", name: `${pluginId}.lines`, surface: surfaceId },
    }], "the registration was not relayed to the host");
    assert.equal(await dispatchSurfaceRequest({ surface: surfaceId, id: 7, method: "status.get", params: { name: `${pluginId}.lines` } }),
      true, "the forwarded request was not consumed by the view's port");
    await disposeSurface(surfaceId);
    assert.equal(await dispatchSurfaceRequest({ surface: surfaceId, id: 8, method: "status.get", params: {} }),
      false, "the port survived the surface");
  } finally {
    await disposeSurface(surfaceId);
    dom.window.close();
  }
});

// The declared UI contract binds a registration to its source process. Ending the current view process removes that process's
// registrations; a replacement can register again, while a delayed end from the old generation cannot remove the replacement.
test("a view process end removes its status registrations and preserves replacement registrations", { timeout: 20000 }, async (t) => {
  const dom = new JSDOM("<main><div id=slot></div></main>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  dom.window.ResizeObserver = class { observe() {} disconnect() {} };
  dom.window.requestAnimationFrame = () => 1;
  dom.window.cancelAnimationFrame = () => {};
  const listeners = sourceListenerMap();
  const calls = [];
  const actualHost = await import("../host.js");
  t.mock.module("../host.js", { exports: {
    ...actualHost,
    native: true,
    onSurfacePrepared: () => () => {},
    surfaceContextRuntime: (surface, declarations) => {
      const runtime = actualHost.surfaceContextRuntime(surface, declarations);
      return { ...runtime, native: { ...runtime.native, on: async (name, listener) => {
        listeners.set(name, listener);
        return () => {};
      }, call: async (name, payload) => {
        calls.push({ name, payload: { ...(payload ?? {}), surface: surface.surfaceId } });
        return null;
      } } };
    },
  } });
  const { registry } = await import("../exposure.js");
  const registrationObservations = [];
  const { mountSurface, authorizeSurface, disposeSurface } = await import("../surface-modules.js?view-exposure-generation-end");
  const pluginId = "fixture-view-exposure-generation";
  const surfaceId = "fixture-view-exposure-generation-surface";
  const statusId = `${pluginId}.lines`;
  recordOrigin(surfaceId, null, "test fixture");
  registry.configure({ surfacePlugin: () => pluginId });
  registry.declare(pluginId, { status: [{ name: statusId, description: "Lines.", schema: { type: "array" } }], commands: [], dom: [] });
  registerPlugin({ id: pluginId, surface: () => null });
  const surface = { module: null, surfaceId, pluginId, declarations: { status: [], commands: [], dom: [] }, sidecars: [],
    composition: { kind: "view", page: "ui/page.html" } };
  const registerStatus = (generation, id) => listeners.get("view-call")({ surface: surfaceId, plugin: pluginId, generation, id,
    command: "runtime.native.call", params: { name: "registered", payload: { kind: "status", name: statusId } } });
  const choose = () => chooseSource({ active: surfaceId, activeGeneration: sourceOrigin(pluginId, surfaceId),
    registrants: registry.registrants("status", statusId) });
  const stopRegistrationObservation = registry.onRegistrationChange(() => {
    registrationObservations.push({
      registrants: registry.registrants("status", statusId),
      generation: sourceOrigin(pluginId, surfaceId),
    });
  });
  const settleRegistration = async (present) => {
    for (let turn = 0; turn < 100; turn += 1) {
      if (registry.registrants("status", statusId).includes(surfaceId) === present) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(registry.registrants("status", statusId).includes(surfaceId), present, "the exposure registration did not settle");
  };
  try {
    authorizeSurface(surfaceId);
    seedViewSource(pluginId, surfaceId, 1);
    await mountSurface(document.querySelector("#slot"), surface);
    registerStatus(1, 1);
    await settleRegistration(true);
    assert.deepEqual(choose(), { id: surfaceId, surface: surfaceId, generation: 1 }, "the current registered view was not selected");

    assert.equal(endSourceOrigin(pluginId, surfaceId, 1), true, "the current source generation did not end");
    assert.deepEqual(registry.registrants("status", statusId), [], "the ended view registration remained available before process-end cleanup");
    assert.deepEqual(registrationObservations.at(-1), { registrants: [], generation: undefined }, "observers saw an ended generation with a live registration");
    listeners.get("view-process-ended")({ surface: surfaceId, plugin: pluginId, generation: 1 });
    await settleRegistration(false);
    assert.equal(sourceOrigin(pluginId, surfaceId), undefined, "the ended generation remains current");
    assert.equal(viewCommandGenerationOf(surfaceId), null, "the ended view command layer remains current");
    assert.equal(choose(), null, "an ended view registration remained eligible as a declared UI source");

    assert.equal(registerSourceOrigin(pluginId, surfaceId, 2), true, "the replacement source generation did not register");
    registerStatus(2, 2);
    await settleRegistration(true);
    assert.deepEqual(choose(), { id: surfaceId, surface: surfaceId, generation: 2 }, "the replacement registration was not selected");

    assert.equal(endSourceOrigin(pluginId, surfaceId, 1), false, "a delayed old end retired the replacement generation");
    listeners.get("view-process-ended")({ surface: surfaceId, plugin: pluginId, generation: 1 });
    assert.deepEqual(registry.registrants("status", statusId), [surfaceId], "a delayed old end removed the replacement registration");
    assert.equal(viewCommandGenerationOf(surfaceId), 2, "a delayed old end removed the replacement command layer");
    assert.equal(calls.filter(({ name }) => name === "exposureRegister").length, 2, "both view generations must register the status with the host");
  } finally {
    stopRegistrationObservation();
    await disposeSurface(surfaceId);
    dom.window.close();
  }
});

// A view watches a status only when the exposure declares it: a watch of an undeclared status is refused with its name and
// replies with that refusal (docs/spec/native-surfaces.md#view-surfaces, view calls).
test("a view watch of a status that the exposure does not declare is refused with its name", { timeout: 20000 }, async (t) => {
  const dom = new JSDOM("<main><div id=slot></div></main>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  dom.window.ResizeObserver = class { observe() {} disconnect() {} };
  dom.window.requestAnimationFrame = () => 1;
  dom.window.cancelAnimationFrame = () => {};
  const listeners = sourceListenerMap();
  const calls = [];
  const actualHost = await import("../host.js");
  t.mock.module("../host.js", { exports: {
    ...actualHost,
    native: true,
    onSurfacePrepared: () => () => {},
    surfaceContextRuntime: (surface, declarations) => {
      const runtime = actualHost.surfaceContextRuntime(surface, declarations);
      return { ...runtime, native: { ...runtime.native, on: async (name, listener) => {
        listeners.set(name, listener);
        return () => {};
      }, call: async (name, payload) => {
        calls.push({ name, payload: { ...(payload ?? {}), surface: surface.surfaceId } });
        return null;
      } } };
    },
  } });
  const { registry } = await import("../exposure.js");
  const { mountSurface, authorizeSurface, disposeSurface } = await import("../surface-modules.js?view-status");
  const pluginId = "fixture-status";
  const surfaceId = "fixture-status-surface";
  recordOrigin(surfaceId, null, "test fixture");
  registry.configure({ surfacePlugin: () => pluginId });
  registry.declare(pluginId, { status: [{ name: `${pluginId}.lines`, description: "Lines.", schema: { type: "array" } }], commands: [], dom: [] });
  registerPlugin({ id: pluginId, surface: () => null });
  const composition = { kind: "view", page: "ui/page.html" };
  const surface = { module: null, surfaceId, pluginId, declarations: { status: [], commands: [], dom: [] }, sidecars: [], composition };
  try {
    authorizeSurface(surfaceId);
    seedViewSource(pluginId, surfaceId);
    await mountSurface(document.querySelector("#slot"), surface);
    listeners.get("view-call")({ surface: surfaceId, plugin: pluginId, id: 3, command: "runtime.status.watch", params: { name: `${pluginId}.missing` } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(calls.filter(({ name }) => name === "viewReply"), [{
      name: "viewReply",
      payload: { id: 3, error: { code: -32000, message: `view call runtime.status.watch ${pluginId}.missing is not a declared status` }, generation: 1, surface: surfaceId, page: String(dom.window.performance.timeOrigin) },
    }]);
  } finally {
    await disposeSurface(surfaceId);
    dom.window.close();
  }
});

// A view names the sidecar of each send, and the surface sends only to a sidecar that it declares (docs/spec/native-surfaces.md#view-surfaces).
// A send that names another sidecar is refused with its reason and reaches no sidecar.
test("a view sends only to a sidecar its surface declares and a send to another sidecar is refused", { timeout: 20000 }, async (t) => {
  const dom = new JSDOM("<main><div id=slot></div></main>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  dom.window.ResizeObserver = class { observe() {} disconnect() {} };
  dom.window.requestAnimationFrame = () => 1;
  dom.window.cancelAnimationFrame = () => {};
  const listeners = sourceListenerMap();
  const replies = [];
  const sent = [];
  const actualHost = await import("../host.js");
  t.mock.module("../host.js", { exports: {
    ...actualHost,
    native: true,
    onSurfacePrepared: () => () => {},
    surfaceContextRuntime: (surface, declarations) => {
      const runtime = actualHost.surfaceContextRuntime(surface, declarations);
      return { ...runtime,
        native: { ...runtime.native, on: async (name, listener) => {
          listeners.set(name, listener);
          return () => {};
        }, call: async (name, payload) => {
          if (name === "viewReply") replies.push(payload);
          return null;
        } },
        // The sidecar port of the surface records the sends that reach a sidecar.
        sidecar: () => ({
          send: async (id, body, cids) => {
            sent.push({ id, body, cids });
            return null;
          },
          on: async () => () => {},
          onFailure: async () => () => {},
        }),
      };
    },
  } });
  const { mountSurface, authorizeSurface, disposeSurface } = await import("../surface-modules.js?view-sidecar");
  const pluginId = "fixture-view-sidecar";
  const surfaceId = "fixture-view-sidecar-surface";
  recordOrigin(surfaceId, null, "test fixture");
  registerPlugin({ id: pluginId, surface: () => null });
  const composition = { kind: "view", page: "ui/page.html" };
  const surface = { module: null, surfaceId, pluginId, declarations: { status: [], commands: [], dom: [] }, sidecars: ["fixture-sidecar"], composition };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  const sendFrom = (id, sidecar) => listeners.get("view-call")({ surface: surfaceId, plugin: pluginId, id, command: "runtime.sidecar.send",
    params: { id: "probe", sidecar, body: { n: id }, cids: [] } });
  try {
    authorizeSurface(surfaceId);
    seedViewSource(pluginId, surfaceId);
    await mountSurface(document.querySelector("#slot"), surface);
    sendFrom(1, "other-sidecar");
    await settle();
    assert.deepEqual(replies.at(-1), { id: 1, error: { code: -32000, message: `surface ${surfaceId} cannot send to sidecar other-sidecar` }, generation: 1 },
      "a send to an undeclared sidecar was not refused with its reason");
    assert.deepEqual(sent, [], "a send to an undeclared sidecar reached a sidecar");
    sendFrom(2, "fixture-sidecar");
    await settle();
    assert.deepEqual(replies.at(-1), { id: 2, result: null, generation: 1 }, "a send to the declared sidecar was refused");
    assert.deepEqual(sent, [{ id: "probe", body: { n: 2 }, cids: [] }]);
  } finally {
    await disposeSurface(surfaceId);
    dom.window.close();
  }
});

// The composition and region calls of a view run the page operations of its surface: the attach goes through the region record of
// the memory saver and the placement carries the composition revision of the document (docs/spec/native-surfaces.md#view-surfaces).
test("the region calls of a view run the page operations of its surface", { timeout: 20000 }, async (t) => {
  const dom = new JSDOM("<main><div id=slot></div></main>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  dom.window.ResizeObserver = class { observe() {} disconnect() {} };
  dom.window.requestAnimationFrame = () => 1;
  dom.window.cancelAnimationFrame = () => {};
  const listeners = sourceListenerMap();
  const calls = [];
  const actualHost = await import("../host.js");
  t.mock.module("../host.js", { exports: {
    ...actualHost,
    native: true,
    onSurfacePrepared: () => () => {},
    surfaceContextRuntime: (surface, declarations) => {
      const runtime = actualHost.surfaceContextRuntime(surface, declarations);
      return { ...runtime, native: { ...runtime.native, on: async (name, listener) => {
        listeners.set(name, listener);
        return () => {};
      }, call: async (name, payload) => {
        // The surface runtime scopes every host call with the surface id, as surfaceContextRuntime.invoke does.
        calls.push({ name, payload: { ...(payload ?? {}), surface: surface.surfaceId } });
        return null;
      } } };
    },
  } });
  const { documentRegions } = await import("../document-regions.js");
  // The tab sessions are not open in this test, so the regions attach without a stored session.
  documentRegions.useSessions(null);
  const { mountSurface, authorizeSurface, disposeSurface } = await import("../surface-modules.js?view-region");
  const pluginId = "fixture-region";
  const surfaceId = "fixture-region-surface";
  recordOrigin(surfaceId, null, "test fixture");
  registerPlugin({ id: pluginId, surface: () => null });
  const composition = { kind: "view", page: "ui/page.html", regions: [{ name: "doc", kind: "document", input: "native" }], overlays: [] };
  const surface = { module: null, surfaceId, pluginId, declarations: { status: [], commands: [], dom: [] }, sidecars: [], composition };
  const replies = () => calls.filter(({ name }) => name === "viewReply").map(({ payload }) => payload);
  const settle = async (count) => {
    for (let turn = 0; turn < 100 && replies().length < count; turn += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  };
  try {
    authorizeSurface(surfaceId);
    seedViewSource(pluginId, surfaceId);
    await mountSurface(document.querySelector("#slot"), surface);
    const call = listeners.get("view-call");
    call({ surface: surfaceId, plugin: pluginId, id: 1, command: "composition.declaration", params: null });
    call({ surface: surfaceId, plugin: pluginId, id: 2, command: "document.attach", params: { name: "doc", surface: "other" } });
    await settle(2);
    call({ surface: surfaceId, plugin: pluginId, id: 3, command: "composition.place", params: {
      regions: [{ name: "doc", left: 1, top: 2, right: 3, bottom: 4, visible: true }], overlays: [] } });
    await settle(3);
    assert.deepEqual(replies(), [
      { id: 1, result: { kind: "view", regions: composition.regions, overlays: [] }, generation: 1, surface: surfaceId },
      { id: 2, result: { history: false }, generation: 1, surface: surfaceId },
      { id: 3, result: null, generation: 1, surface: surfaceId },
    ]);
    assert.deepEqual(calls.filter(({ name }) => name === "documentAttach"), [
      { name: "documentAttach", payload: { document: "doc", surface: surfaceId } },
    ]);
    const placed = calls.filter(({ name }) => name === "compositionPlace");
    assert.equal(placed.length, 1);
    assert.ok(Number.isInteger(placed[0].payload.revision) && placed[0].payload.revision > 0, "the placement carries the revision of the document");
    assert.deepEqual(placed[0].payload.regions, [{ name: "doc", left: 1, top: 2, right: 3, bottom: 4, visible: true }]);
    assert.deepEqual(documentRegions.tabs(), [surfaceId], "the attach is recorded by the region record");
  } finally {
    await disposeSurface(surfaceId);
    dom.window.close();
  }
});

// The host reports the end of a view process with view-process-ended, and the host has closed the regions of the surface with it,
// so the region record of the page forgets them before the restarted view attaches them again.
test("a view process end forgets the regions that its surface attached", { timeout: 20000 }, async (t) => {
  const dom = new JSDOM("<main><div id=slot></div></main>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  dom.window.ResizeObserver = class { observe() {} disconnect() {} };
  dom.window.requestAnimationFrame = () => 1;
  dom.window.cancelAnimationFrame = () => {};
  const listeners = sourceListenerMap();
  const calls = [];
  const actualHost = await import("../host.js");
  t.mock.module("../host.js", { exports: {
    ...actualHost,
    native: true,
    onSurfacePrepared: () => () => {},
    surfaceContextRuntime: (surface, declarations) => {
      const runtime = actualHost.surfaceContextRuntime(surface, declarations);
      return { ...runtime, native: { ...runtime.native, on: async (name, listener) => {
        listeners.set(name, listener);
        return () => {};
      }, call: async (name, payload) => {
        calls.push({ name, payload: { ...(payload ?? {}), surface: surface.surfaceId } });
        return null;
      } } };
    },
  } });
  const { documentRegions } = await import("../document-regions.js");
  documentRegions.useSessions(null);
  const { mountSurface, authorizeSurface, disposeSurface } = await import("../surface-modules.js?view-process-end");
  const pluginId = "fixture-region-end";
  const surfaceId = "fixture-region-process-end";
  recordOrigin(surfaceId, null, "test fixture");
  registerPlugin({ id: pluginId, surface: () => null });
  const composition = { kind: "view", page: "ui/page.html", regions: [{ name: "doc", kind: "document", input: "native" }], overlays: [] };
  const surface = { module: null, surfaceId, pluginId, declarations: { status: [], commands: [], dom: [] }, sidecars: [], composition };
  const replies = () => calls.filter(({ name }) => name === "viewReply").map(({ payload }) => payload);
  const settle = async (count) => {
    for (let turn = 0; turn < 100 && replies().length < count; turn += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  };
  try {
    authorizeSurface(surfaceId);
    seedViewSource(pluginId, surfaceId);
    await mountSurface(document.querySelector("#slot"), surface);
    listeners.get("view-call")({ surface: surfaceId, plugin: pluginId, id: 1, command: "document.attach", params: { name: "doc" } });
    await settle(1);
    assert.deepEqual(documentRegions.tabs(), [surfaceId], "the attached region is recorded before the process end");
    const ended = listeners.get("view-process-ended");
    assert.ok(ended, "the view subscribes to view-process-ended");
    ended({ surface: surfaceId });
    assert.deepEqual(documentRegions.tabs(), [], "the process end forgets the regions of the surface");
  } finally {
    await disposeSurface(surfaceId);
    dom.window.close();
  }
});

// The host ends one view document while its calls and subscriptions are in flight. Late work from that document must stay canceled
// after a new document registers its subscriptions, while the new document's live work continues to report refusals.
test("a view process end cancels its pending work across restart and accepts new document subscriptions", { timeout: 20000 }, async (t) => {
  const dom = new JSDOM("<main><div id=slot></div></main>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  dom.window.ResizeObserver = class { observe() {} disconnect() {} };
  dom.window.requestAnimationFrame = () => 1;
  dom.window.cancelAnimationFrame = () => {};
  const nativeListeners = sourceListenerMap();
  const sidecarListeners = [];
  const replies = [];
  const calls = [];
  const emitted = [];
  const reported = [];
  let resolveOldSend;
  let oldSendStarted;
  const oldSendStartedPromise = new Promise((resolve) => { oldSendStarted = resolve; });
  let resolveOldEventStarted;
  const oldEventStartedPromise = new Promise((resolve) => { resolveOldEventStarted = resolve; });
  let oldEventReject;
  let newDocumentReady = false;
  const actualHost = await import("../host.js");
  t.mock.module("../host.js", { exports: {
    ...actualHost,
    native: true,
    onSurfacePrepared: () => () => {},
    surfaceContextRuntime: (surface, declarations) => {
      const runtime = actualHost.surfaceContextRuntime(surface, declarations);
      return { ...runtime,
        native: { ...runtime.native,
          on: async (name, listener) => {
            nativeListeners.set(name, listener);
            return () => nativeListeners.delete(name);
          },
          call: async (name, payload) => {
            calls.push({ name, payload });
            if (name === "viewEvent" && payload.data.body.id === "old") {
              resolveOldEventStarted();
              return new Promise((_resolve, reject) => { oldEventReject = reject; });
            }
            if (name === "viewEvent" && payload.data.body.id === "live-refusal") {
              throw new Error("current view document refused the event");
            }
            if (name === "viewReply") {
              replies.push(payload);
              if (payload.id === 11 && newDocumentReady) calls.push({ name: "staleReplyReachedReplacement", payload });
            }
            return null;
          },
        },
        sidecar: () => ({
          send: async (_id, body) => {
            if (body.id === "old") {
              oldSendStarted();
              return new Promise((resolve) => { resolveOldSend = resolve; });
            }
            return null;
          },
          on: async (id, listener) => {
            const entry = { id, listener, active: true };
            sidecarListeners.push(entry);
            return () => { entry.active = false; };
          },
          onFailure: async () => () => {},
        }),
      };
    },
  } });
  const actualPageLog = await import("../page-log.js");
  t.mock.module("../page-log.js", { exports: { ...actualPageLog, emitEvent: (level, event, fields) => emitted.push({ level, event, fields }) } });
  const previousError = globalThis.ErrorEvent;
  const previousDispatch = globalThis.dispatchEvent;
  globalThis.ErrorEvent = dom.window.ErrorEvent;
  globalThis.dispatchEvent = (event) => { reported.push(event.message); return true; };
  const { mountSurface, authorizeSurface, disposeSurface } = await import("../surface-modules.js?view-process-end-pending-work");
  const pluginId = "fixture-view-process-generation";
  const surfaceId = "fixture-view-process-generation-surface";
  recordOrigin(surfaceId, null, "test fixture");
  registerPlugin({ id: pluginId, surface: () => null });
  const surface = { module: null, surfaceId, pluginId, declarations: { status: [], commands: [], dom: [] },
    sidecars: ["fixture-sidecar"], composition: { kind: "view", page: "ui/page.html" } };
  const settle = async (condition) => {
    for (let turn = 0; turn < 100 && !condition(); turn += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(condition(), "the view-process operation settled");
  };
  try {
    authorizeSurface(surfaceId);
    seedViewSource(pluginId, surfaceId);
    await mountSurface(document.querySelector("#slot"), surface);
    const call = nativeListeners.get("view-call");
    call({ generation: 1, id: 10, command: "runtime.sidecar.on", params: { id: "probe", sidecar: "fixture-sidecar" } });
    await settle(() => sidecarListeners.length === 1);
    call({ generation: 1, id: 11, command: "runtime.sidecar.send", params: { id: "probe", sidecar: "fixture-sidecar", body: { id: "old" } } });
    await oldSendStartedPromise;
    sidecarListeners[0].listener({ id: "old" });
    await oldEventStartedPromise;
    const ended = nativeListeners.get("view-process-ended");
    assert.equal(typeof ended, "function", "the mounted surface listens for host view-process end");
    assert.equal(endSourceOrigin(pluginId, surfaceId, 1), true, "the old source was not retired before its process-ended event");
    ended({ surface: surfaceId, generation: 1 });
    assert.equal(registerSourceOrigin(pluginId, surfaceId, 2), true, "the replacement source generation did not register after the old process ended");

    // A restarted document sends a new subscription before the old handler settles.
    call({ surface: surfaceId, generation: 2, id: 12, command: "runtime.sidecar.on", params: { id: "probe", sidecar: "fixture-sidecar" } });
    await settle(() => replies.some(({ id }) => id === 12));
    newDocumentReady = true;
    resolveOldSend(null);
    oldEventReject(new Error(`surface ${surfaceId} has no ready document`));
    await new Promise((resolve) => setImmediate(resolve));
    sidecarListeners[0].listener({ id: "late-old" });
    await new Promise((resolve) => setImmediate(resolve));

    const currentListener = sidecarListeners.at(-1);
    currentListener.listener({ id: "new" });
    await settle(() => calls.some(({ name, payload }) => name === "viewEvent" && payload.data.body.id === "new"));
    currentListener.listener({ id: "live-refusal" });
    await settle(() => reported.length > 0);
    const sentSidecarMessages = calls.filter(({ name }) => name === "viewEvent")
      .map(({ payload }) => ({ generation: payload.generation, id: payload.data.body.id }));

    assert.deepEqual({
      staleReplies: replies.filter(({ id }) => id === 11),
      staleReplyReachedReplacement: calls.some(({ name }) => name === "staleReplyReachedReplacement"),
      oldListenerActive: sidecarListeners[0].active,
      newListenerActive: sidecarListeners.at(-1).active,
      oldCallCancellation: emitted.filter(({ event, fields }) => event === "page.view.call.cancel" && fields.id === 11)
        .map(({ fields }) => ({ generation: fields.generation, id: fields.id })),
      oldEventCanceled: emitted.some(({ event, fields }) => event === "page.view.event.cancel" && fields.event === "sidecar.message"),
      sidecarEventCancellationCount: emitted.filter(({ event, fields }) => event === "page.view.event.cancel" && fields.event === "sidecar.message").length,
      reports: reported,
      newEventDelivered: calls.some(({ name, payload }) => name === "viewEvent" && payload.data.body.id === "new"),
      sentSidecarMessages,
      lateOldEventDelivered: calls.some(({ name, payload }) => name === "viewEvent" && payload.data.body.id === "late-old"),
    }, {
      staleReplies: [], staleReplyReachedReplacement: false, oldListenerActive: false, newListenerActive: true,
      oldCallCancellation: [{ generation: 1, id: 11 }], oldEventCanceled: true,
      sidecarEventCancellationCount: 2,
      reports: ["view event sidecar.message: current view document refused the event"], newEventDelivered: true,
      sentSidecarMessages: [
        { generation: 1, id: "old" }, { generation: 2, id: "new" }, { generation: 2, id: "live-refusal" },
      ],
      lateOldEventDelivered: false,
    });
  } finally {
    globalThis.dispatchEvent = previousDispatch;
    globalThis.ErrorEvent = previousError;
    await disposeSurface(surfaceId);
    dom.window.close();
  }
});

// The exposure port of a view is released when its surface is disposed, not when the view's listener registrations settle: a
// registration that settles after the dispose (a slow native listener) must not keep the port, or mounting the same surface again
// fails with "already has an exposure port".
test("a view surface mounted again after its dispose registers its port while the earlier listener registrations are pending", { timeout: 5000 }, async (t) => {
  const dom = new JSDOM("<main><div id=slot></div></main>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  dom.window.ResizeObserver = class { observe() {} disconnect() {} };
  dom.window.requestAnimationFrame = () => 1;
  dom.window.cancelAnimationFrame = () => {};
  // The registration of view-call settles only when the test releases it, as a native listener does under load.
  let attempt = 0;
  const releases = [];
  const activeListeners = new Set();
  const actualHost = await import("../host.js");
  t.mock.module("../host.js", { exports: {
    ...actualHost,
    native: true,
    onSurfacePrepared: () => () => {},
    surfaceContextRuntime: (surface, declarations) => {
      const runtime = actualHost.surfaceContextRuntime(surface, declarations);
      return { ...runtime, native: { ...runtime.native, on: (name, listener) => {
        const key = `${attempt}:${name}`;
        if (name !== "view-call") {
          activeListeners.add(key);
          return Promise.resolve(() => activeListeners.delete(key));
        }
        return new Promise((resolve) => releases.push(() => {
          activeListeners.add(key);
          resolve(() => activeListeners.delete(key));
        }));
      }, call: async () => null } };
    },
  } });
  const { mountSurface, authorizeSurface, disposeSurface, waitSurfaceCompositionDeclared } = await import("../surface-modules.js?view-remount");
  const pluginId = "fixture-view-remount";
  const surfaceId = "fixture-view-remount-surface";
  recordOrigin(surfaceId, null, "test fixture");
  registerPlugin({ id: pluginId, surface: () => null });
  const composition = { kind: "view", page: "ui/page.html" };
  const surface = { module: null, surfaceId, pluginId, declarations: { status: [], commands: [], dom: [] }, sidecars: [], composition };
  try {
    attempt = 1;
    authorizeSurface(surfaceId);
    seedViewSource(pluginId, surfaceId);
    const firstMount = mountSurface(document.querySelector("#slot"), surface);
    assert.equal(releases.length, 1, "the first mount did not begin its delayed view-call listener registration");
    assert.equal(viewCommandGenerationOf(surfaceId), 1, "the first mount did not register its view port before waiting for listeners");
    await disposeSurface(surfaceId);
    await firstMount;

    attempt = 2;
    authorizeSurface(surfaceId);
    seedViewSource(pluginId, surfaceId);
    const secondMount = mountSurface(document.querySelector("#slot"), surface);
    assert.equal(releases.length, 2, "the replacement mount did not register while the prior listener remained pending");
    releases[1]();
    await secondMount;
    await waitSurfaceCompositionDeclared(surfaceId);
    assert.ok(activeListeners.has("2:view-call"), "the replacement composition did not wait for its own listener");
    releases[0]();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual([...activeListeners].filter((key) => key.endsWith(":view-call")), ["2:view-call"],
      "the late listener of the disposed mount stayed active or removed the replacement listener");
  } finally {
    for (const release of releases) release();
    await disposeSurface(surfaceId);
    dom.window.close();
  }
});

test("a view reply the host refuses is reported through the page error path", { timeout: 20000 }, async (t) => {
  const dom = new JSDOM("<main><div id=slot></div></main>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  dom.window.ResizeObserver = class { observe() {} disconnect() {} };
  dom.window.requestAnimationFrame = () => 1;
  dom.window.cancelAnimationFrame = () => {};
  const listeners = sourceListenerMap();
  const actualHost = await import("../host.js");
  t.mock.module("../host.js", { exports: {
    ...actualHost,
    native: true,
    onSurfacePrepared: () => () => {},
    surfaceContextRuntime: (surface, declarations) => {
      const runtime = actualHost.surfaceContextRuntime(surface, declarations);
      return { ...runtime, native: { ...runtime.native, on: async (name, listener) => {
        listeners.set(name, listener);
        return () => {};
      }, call: async (name) => {
        // The host refuses every viewReply, so the reply of each view call is rejected.
        if (name === "viewReply") throw new Error("host refused the reply");
        return null;
      } } };
    },
  } });
  // The page error path is the global dispatchEvent of the surface module, so its errors are collected here.
  const reported = [];
  const previousError = globalThis.ErrorEvent;
  const previousDispatch = globalThis.dispatchEvent;
  globalThis.ErrorEvent = dom.window.ErrorEvent;
  globalThis.dispatchEvent = (event) => { reported.push(event.message); return true; };
  const { registry } = await import("../exposure.js");
  const { mountSurface, authorizeSurface, disposeSurface } = await import("../surface-modules.js?view-reply-report");
  const pluginId = "fixture-reply";
  const surfaceId = "fixture-reply-surface";
  recordOrigin(surfaceId, null, "test fixture");
  registry.configure({ surfacePlugin: () => pluginId });
  registry.declare(pluginId, { status: [], commands: [], dom: [] });
  registerPlugin({ id: pluginId, surface: () => null });
  const composition = { kind: "view", page: "ui/page.html" };
  const surface = { module: null, surfaceId, pluginId, declarations: { status: [], commands: [], dom: [] }, sidecars: [], composition };
  try {
    authorizeSurface(surfaceId);
    seedViewSource(pluginId, surfaceId);
    await mountSurface(document.querySelector("#slot"), surface);
    listeners.get("view-call")({ surface: surfaceId, plugin: pluginId, id: 3, command: "runtime.native.call",
      params: { name: "registered", payload: { kind: "status", name: `${pluginId}.none` } } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(reported.includes("view call 3 reply: host refused the reply"),
      `the refused reply was not reported: ${JSON.stringify(reported)}`);
  } finally {
    globalThis.dispatchEvent = previousDispatch;
    globalThis.ErrorEvent = previousError;
    await disposeSurface(surfaceId);
    dom.window.close();
  }
});

test("closing a view cancels a pending call reply and event delivery", { timeout: 20000 }, async (t) => {
  const dom = new JSDOM("<main><div id=slot></div></main>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  dom.window.ResizeObserver = class { observe() {} disconnect() {} };
  dom.window.requestAnimationFrame = () => 1;
  dom.window.cancelAnimationFrame = () => {};
  const listeners = sourceListenerMap();
  const sidecarListeners = new Map();
  const emitted = [];
  const reported = [];
  let resolveSend;
  let sendStarted;
  const sendStartedPromise = new Promise((resolve) => { sendStarted = resolve; });
  let rejectEvent;
  let ended = false;
  const staleHostCalls = [];
  const actualHost = await import("../host.js");
  t.mock.module("../host.js", { exports: {
    ...actualHost,
    native: true,
    onSurfacePrepared: () => () => {},
    surfaceContextRuntime: (surface, declarations) => {
      const runtime = actualHost.surfaceContextRuntime(surface, declarations);
      return { ...runtime,
        native: { ...runtime.native, on: async (name, listener) => {
          listeners.set(name, listener);
          return () => {};
        }, call: async (name) => {
          if (name === "viewEvent") return new Promise((_resolve, reject) => { rejectEvent = reject; });
          if (name === "viewReply" && ended) {
            staleHostCalls.push(name);
            throw new Error(`surface ${surface.surfaceId} has no ready document`);
          }
          return null;
        } },
        sidecar: () => ({
          send: async () => {
            sendStarted();
            return new Promise((resolve) => { resolveSend = resolve; });
          },
          on: async (id, listener) => {
            sidecarListeners.set(id, listener);
            return () => sidecarListeners.delete(id);
          },
          onFailure: async () => () => {},
        }),
      };
    },
  } });
  const actualPageLog = await import("../page-log.js");
  t.mock.module("../page-log.js", { exports: { ...actualPageLog, emitEvent: (level, event, fields) => emitted.push({ level, event, fields }) } });
  const previousError = globalThis.ErrorEvent;
  const previousDispatch = globalThis.dispatchEvent;
  globalThis.ErrorEvent = dom.window.ErrorEvent;
  globalThis.dispatchEvent = (event) => { reported.push(event.message); return true; };
  const { mountSurface, authorizeSurface, disposeSurface } = await import("../surface-modules.js?view-close-pending-delivery");
  const pluginId = "fixture-close-pending-view";
  const surfaceId = "fixture-close-pending-surface";
  recordOrigin(surfaceId, null, "test fixture");
  registerPlugin({ id: pluginId, surface: () => null });
  const surface = { module: null, surfaceId, pluginId, declarations: { status: [], commands: [], dom: [] },
    sidecars: ["fixture-sidecar"], composition: { kind: "view", page: "ui/page.html" } };
  try {
    authorizeSurface(surfaceId);
    seedViewSource(pluginId, surfaceId);
    await mountSurface(document.querySelector("#slot"), surface);
    const call = listeners.get("view-call");
    call({ generation: 1, id: 10, command: "runtime.sidecar.on", params: { id: "probe", sidecar: "fixture-sidecar" } });
    await new Promise((resolve) => setImmediate(resolve));
    sidecarListeners.get("probe")({ n: 1 });
    call({ generation: 1, id: 11, command: "runtime.sidecar.send", params: { id: "probe", sidecar: "fixture-sidecar", body: { n: 2 } } });
    await sendStartedPromise;
    await disposeSurface(surfaceId);
    ended = true;
    rejectEvent(new Error(`surface ${surfaceId} has no ready document`));
    resolveSend(null);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual({
      staleHostCalls,
      reported,
      callCancellation: emitted.filter(({ event, fields }) => event === "page.view.call.cancel" && fields.id === 11)
        .map(({ fields }) => ({ generation: fields.generation, id: fields.id })),
      eventCanceled: emitted.some(({ event, fields }) => event === "page.view.event.cancel" && fields.event === "sidecar.message"),
    }, { staleHostCalls: [], reported: [], callCancellation: [{ generation: 1, id: 11 }], eventCanceled: true });
  } finally {
    globalThis.dispatchEvent = previousDispatch;
    globalThis.ErrorEvent = previousError;
    await disposeSurface(surfaceId);
    dom.window.close();
  }
});

// A view mount that fails releases the exposure port it registered, so the surface can be mounted again. The fault injection
// refuses the first composition declaration of the view; the port of the failed mount must not remain after the failure.
test("a failed view mount releases its exposure port, and a retry mounts the surface", { timeout: 5000 }, async (t) => {
  const dom = new JSDOM("<main><div id=slot></div></main>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  dom.window.ResizeObserver = class { observe() {} disconnect() {} };
  dom.window.requestAnimationFrame = () => 1;
  dom.window.cancelAnimationFrame = () => {};
  let refuseNext = true;
  const actualHost = await import("../host.js");
  t.mock.module("../host.js", { exports: {
    ...actualHost,
    native: true,
    onSurfacePrepared: () => () => {},
    surfaceContextRuntime: (surface, declarations) => {
      const runtime = actualHost.surfaceContextRuntime(surface, declarations);
      return { ...runtime, native: { ...runtime.native, on: async () => () => {}, call: async (name) => {
        if (name === "compositionDeclare" && refuseNext) {
          refuseNext = false;
          throw new Error("the host refused the composition declaration");
        }
        return null;
      } } };
    },
  } });
  const { mountSurface, authorizeSurface, disposeSurface, waitSurfaceCompositionDeclared } = await import("../surface-modules.js?view-failed-mount");
  const { dispatchSurfaceRequest } = await import("../exposure.js");
  const pluginId = "fixture-failed-view";
  const surfaceId = "fixture-failed-view-surface";
  recordOrigin(surfaceId, null, "test fixture");
  registerPlugin({ id: pluginId, surface: () => null });
  const composition = { kind: "view", page: "ui/page.html" };
  const surface = { module: null, surfaceId, pluginId, declarations: { status: [], commands: [], dom: [] }, sidecars: [], composition };
  try {
    authorizeSurface(surfaceId);
    seedViewSource(pluginId, surfaceId);
    await assert.rejects(mountSurface(document.querySelector("#slot"), surface), /composition declaration/);
    assert.equal(await dispatchSurfaceRequest({ surface: surfaceId, id: 1, method: "status.list", params: {} }), false,
      "the failed mount left its exposure port registered");
    seedViewSource(pluginId, surfaceId);
    await mountSurface(document.querySelector("#slot"), surface);
    await waitSurfaceCompositionDeclared(surfaceId);
  } finally {
    await disposeSurface(surfaceId);
    dom.window.close();
  }
});

// A view receives the core declarations at startup and registers them from its own document, never from the main-page placeholder.
test("a view surface mounts with the core surface entries that exposure.json declares", { timeout: 5000 }, async (t) => {
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
      return { ...runtime, native: { ...runtime.native, on: async () => () => {}, call: async (name, payload) => {
        calls.push({ name, payload });
        return null;
      } } };
    },
  } });
  const calls = [];
  const exposureFile = (await import("../exposure.json", { with: { type: "json" } })).default;
  const { installExposure, registry, dispatchSurfaceRequest } = await import("../exposure.js");
  installExposure(structuredClone(exposureFile));
  const { mountSurface, authorizeSurface, disposeSurface, waitSurfaceCompositionDeclared, viewStartValues } = await import("../surface-modules.js?view-core-exposure");
  const pluginId = "fixture-core-view";
  const surfaceId = "fixture-core-view-surface";
  recordOrigin(surfaceId, null, "test fixture");
  registerPlugin({ id: pluginId, surface: () => null });
  const composition = { kind: "view", page: "ui/page.html" };
  const surface = { module: null, surfaceId, pluginId, declarations: { status: [], commands: [], dom: [] }, sidecars: [], composition };
  try {
    authorizeSurface(surfaceId);
    seedViewSource(pluginId, surfaceId);
    await mountSurface(document.querySelector("#slot"), surface);
    await waitSurfaceCompositionDeclared(surfaceId);
    assert.deepEqual(registry.namesOf(surfaceId), [], "the main placeholder registered view document entries");
    const start = viewStartValues(surface, null);
    assert.deepEqual(start.declarations.status.map(({ name }) => name).sort(), ["core.surface.document", "core.surface.input"]);
    assert.deepEqual(start.declarations.commands.map(({ name }) => name), ["core.surface.hit"]);
    assert.equal(await dispatchSurfaceRequest({ surface: surfaceId, id: 7, method: "status.get", params: { name: "core.surface.document" } }),
      true, "the core entry of the view surface is not served by its page");
  } finally {
    await disposeSurface(surfaceId);
    dom.window.close();
  }
});

// A view mount, then the core registration of the surface, then a command that the view registers: all three use the one exposure
// port of the surface, so the mount succeeds and the command reaches the registry of the surface.
test("a view mount, its core registration and its command registration share one exposure port", { timeout: 5000 }, async (t) => {
  const dom = new JSDOM("<main><div id=slot></div></main>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  dom.window.ResizeObserver = class { observe() {} disconnect() {} };
  dom.window.requestAnimationFrame = () => 1;
  dom.window.cancelAnimationFrame = () => {};
  const listeners = sourceListenerMap();
  const actualHost = await import("../host.js");
  t.mock.module("../host.js", { exports: {
    ...actualHost,
    native: true,
    onSurfacePrepared: () => () => {},
    surfaceContextRuntime: (surface, declarations) => {
      const runtime = actualHost.surfaceContextRuntime(surface, declarations);
      return { ...runtime, native: { ...runtime.native, on: async (name, listener) => {
        listeners.set(name, listener);
        return () => {};
      }, call: async () => null } };
    },
  } });
  const exposureFile = (await import("../exposure.json", { with: { type: "json" } })).default;
  const { installExposure, registry, dispatchSurfaceRequest } = await import("../exposure.js");
  // The core declarations are installed once per document; an earlier test of this file may have installed them.
  if (!registry.declared("status", "core.surface.document")) installExposure(structuredClone(exposureFile));
  const { mountSurface, authorizeSurface, disposeSurface, waitSurfaceCompositionDeclared } = await import("../surface-modules.js?view-one-port");
  const pluginId = "fixture-one-port-view";
  const surfaceId = "fixture-one-port-view-surface";
  const command = `${pluginId}.run`;
  const commands = [{ name: command, description: "Runs the fixture.", params: { type: "object" }, result: { type: "null" } }];
  recordOrigin(surfaceId, null, "test fixture");
  registry.configure({ surfacePlugin: () => pluginId });
  registry.declare(pluginId, { status: [], dom: [], commands });
  registerPlugin({ id: pluginId, surface: () => null });
  const composition = { kind: "view", page: "ui/page.html" };
  const surface = { module: null, surfaceId, pluginId, declarations: { status: [], commands, dom: [] }, sidecars: [], composition };
  try {
    authorizeSurface(surfaceId);
    seedViewSource(pluginId, surfaceId);
    await mountSurface(document.querySelector("#slot"), surface);
    await waitSurfaceCompositionDeclared(surfaceId);
    assert.equal(await dispatchSurfaceRequest({ surface: surfaceId, id: 1, method: "status.get", params: { name: "core.surface.document" } }),
      true, "the core entry of the view surface is not served by its page");
    listeners.get("view-call")({ surface: surfaceId, plugin: pluginId, id: 2, command: "runtime.command.register", params: { name: command } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(registry.namesOf(surfaceId).includes(`command ${command}`), `the view command is not registered: ${JSON.stringify(registry.namesOf(surfaceId))}`);
  } finally {
    await disposeSurface(surfaceId);
    dom.window.close();
  }
});
