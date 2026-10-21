import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { registerPlugin } from "../registry.js";
import { setSurfaceTextSize } from "../text-size.js";

setSurfaceTextSize(() => 1);

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
  registerPlugin({ id: pluginId, surface: () => null });
  const composition = { kind: "view", page: "ui/page.html" };
  const surface = { module: null, surfaceId, pluginId, declarations: { status: [], commands: [], dom: [] }, sidecars: [], composition };
  try {
    authorizeSurface(surfaceId);
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

// contract: view.restart.limit-shows-error
// The view-stopped event of the surface is shown as the error state of the surface, and mounting the surface again replaces that state.
test("a view that stopped its restarts shows its reason as the error state of its surface until it is mounted again", { timeout: 5000 }, async (t) => {
  const dom = new JSDOM("<main><div id=slot></div></main>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  dom.window.ResizeObserver = class { observe() {} disconnect() {} };
  dom.window.requestAnimationFrame = () => 1;
  dom.window.cancelAnimationFrame = () => {};
  const listeners = new Map();
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
  registerPlugin({ id: pluginId, surface: () => null });
  const composition = { kind: "view", page: "ui/page.html" };
  const surface = { module: null, surfaceId, pluginId, declarations: { status: [], commands: [], dom: [] }, sidecars: [], composition };
  const reason = "the view failed 4 times within 300 seconds and is created again when its tab is reopened";
  try {
    authorizeSurface(surfaceId);
    const states = [];
    await mountSurface(document.querySelector("#slot"), surface, { onState: (state) => states.push(state) });
    await waitSurfaceCompositionDeclared(surfaceId);
    listeners.get("view-stopped")({ surface: surfaceId, plugin: pluginId, reason });
    const stopped = states.at(-1);
    assert.equal(stopped.phase, "error");
    assert.equal(stopped.error.message, reason);

    await disposeSurface(surfaceId);
    authorizeSurface(surfaceId);
    const reopened = [];
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
  const listeners = new Map();
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
  const { mountSurface, authorizeSurface, disposeSurface, waitSurfaceCompositionDeclared } = await import("../surface-modules.js?view-responsive");
  const { views } = await import("../plugin-processes.js");
  const pluginId = "fixture-responsive-view";
  const surfaceId = "fixture-responsive-view-surface";
  registerPlugin({ id: pluginId, surface: () => null });
  const composition = { kind: "view", page: "ui/page.html" };
  const surface = { module: null, surfaceId, pluginId, declarations: { status: [], commands: [], dom: [] }, sidecars: [], composition };
  const ofSurface = () => views().filter((entry) => entry.surface === surfaceId);
  try {
    authorizeSurface(surfaceId);
    await mountSurface(document.querySelector("#slot"), surface, { onState: () => {} });
    await waitSurfaceCompositionDeclared(surfaceId);
    listeners.get("view-responsiveness")({ surface: surfaceId, plugin: pluginId, responsive: false });
    assert.deepEqual(ofSurface(), [{ plugin: pluginId, surface: surfaceId, responsive: false }]);
    listeners.get("view-responsiveness")({ surface: surfaceId, plugin: pluginId, responsive: true });
    assert.deepEqual(ofSurface(), [{ plugin: pluginId, surface: surfaceId, responsive: true }]);
    await disposeSurface(surfaceId);
    assert.deepEqual(ofSurface(), [], "dispose removes the responsiveness of the surface");
  } finally {
    await disposeSurface(surfaceId);
    dom.window.close();
  }
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
  const listeners = new Map();
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
