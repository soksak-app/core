import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { registerPlugin } from "../registry.js";
import { recordOrigin } from "../tab-reports.js";
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
  recordOrigin(surfaceId, null);
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
  recordOrigin(surfaceId, null);
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
  recordOrigin(surfaceId, null);
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

// The start values of a view (docs/spec/native-surfaces.md#view-surfaces): the host injects them as window.sokSurface before the
// page of the view runs. origin is the directory that the tab that opened the tab recorded, and project is the project that the
// window shows, or null.
test("the start values of a view carry its params, origin, project and declarations", async () => {
  const { viewStartValues } = await import("../surface-modules.js?view-start");
  const { reportDirectory } = await import("../tab-reports.js");
  reportDirectory("tab-with-directory", "/work/one");
  recordOrigin("tab-of-directory", "tab-with-directory");
  const surface = { surfaceId: "tab-of-directory", params: { path: "a.md" }, declarations: { commands: [] } };
  assert.deepEqual(viewStartValues(surface, { root: "/work/one" }), {
    params: { path: "a.md" },
    origin: { directory: "/work/one" },
    project: { root: "/work/one" },
    declarations: { commands: [] },
  });
  recordOrigin("tab-without-directory", null);
  assert.deepEqual(viewStartValues({ surfaceId: "tab-without-directory", declarations: {} }, null), {
    params: null,
    origin: { directory: null },
    project: null,
    declarations: {},
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
  recordOrigin(surfaceId, null);
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

// A view names the sidecar of each send, and the surface sends only to a sidecar that it declares (docs/spec/native-surfaces.md#view-surfaces).
// A send that names another sidecar is refused with its reason and reaches no sidecar.
test("a view sends only to a sidecar its surface declares and a send to another sidecar is refused", { timeout: 20000 }, async (t) => {
  const dom = new JSDOM("<main><div id=slot></div></main>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  dom.window.ResizeObserver = class { observe() {} disconnect() {} };
  dom.window.requestAnimationFrame = () => 1;
  dom.window.cancelAnimationFrame = () => {};
  const listeners = new Map();
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
  recordOrigin(surfaceId, null);
  registerPlugin({ id: pluginId, surface: () => null });
  const composition = { kind: "view", page: "ui/page.html" };
  const surface = { module: null, surfaceId, pluginId, declarations: { status: [], commands: [], dom: [] }, sidecars: ["fixture-sidecar"], composition };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  const sendFrom = (id, sidecar) => listeners.get("view-call")({ surface: surfaceId, plugin: pluginId, id, command: "runtime.sidecar.send",
    params: { id: "probe", sidecar, body: { n: id }, cids: [] } });
  try {
    authorizeSurface(surfaceId);
    await mountSurface(document.querySelector("#slot"), surface);
    sendFrom(1, "other-sidecar");
    await settle();
    assert.deepEqual(replies.at(-1), { id: 1, error: { code: -32000, message: `surface ${surfaceId} cannot send to sidecar other-sidecar` } },
      "a send to an undeclared sidecar was not refused with its reason");
    assert.deepEqual(sent, [], "a send to an undeclared sidecar reached a sidecar");
    sendFrom(2, "fixture-sidecar");
    await settle();
    assert.deepEqual(replies.at(-1), { id: 2, result: null }, "a send to the declared sidecar was refused");
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
  const { documentRegions } = await import("../document-regions.js");
  // The tab sessions are not open in this test, so the regions attach without a stored session.
  documentRegions.useSessions(null);
  const { mountSurface, authorizeSurface, disposeSurface } = await import("../surface-modules.js?view-region");
  const pluginId = "fixture-region";
  const surfaceId = "fixture-region-surface";
  recordOrigin(surfaceId, null);
  registerPlugin({ id: pluginId, surface: () => null });
  const composition = { kind: "view", page: "ui/page.html", regions: [{ name: "doc", kind: "document", input: "native" }], overlays: [] };
  const surface = { module: null, surfaceId, pluginId, declarations: { status: [], commands: [], dom: [] }, sidecars: [], composition };
  const replies = () => calls.filter(({ name }) => name === "viewReply").map(({ payload }) => payload);
  const settle = async (count) => {
    for (let turn = 0; turn < 100 && replies().length < count; turn += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  };
  try {
    authorizeSurface(surfaceId);
    await mountSurface(document.querySelector("#slot"), surface);
    const call = listeners.get("view-call");
    call({ surface: surfaceId, plugin: pluginId, id: 1, command: "composition.declaration", params: null });
    call({ surface: surfaceId, plugin: pluginId, id: 2, command: "document.attach", params: { name: "doc", surface: "other" } });
    await settle(2);
    call({ surface: surfaceId, plugin: pluginId, id: 3, command: "composition.place", params: {
      regions: [{ name: "doc", left: 1, top: 2, right: 3, bottom: 4, visible: true }], overlays: [] } });
    await settle(3);
    assert.deepEqual(replies(), [
      { id: 1, result: { kind: "view", regions: composition.regions, overlays: [] }, surface: surfaceId },
      { id: 2, result: { history: false }, surface: surfaceId },
      { id: 3, result: null, surface: surfaceId },
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
  recordOrigin(surfaceId, null);
  registerPlugin({ id: pluginId, surface: () => null });
  const composition = { kind: "view", page: "ui/page.html", regions: [{ name: "doc", kind: "document", input: "native" }], overlays: [] };
  const surface = { module: null, surfaceId, pluginId, declarations: { status: [], commands: [], dom: [] }, sidecars: [], composition };
  const replies = () => calls.filter(({ name }) => name === "viewReply").map(({ payload }) => payload);
  const settle = async (count) => {
    for (let turn = 0; turn < 100 && replies().length < count; turn += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  };
  try {
    authorizeSurface(surfaceId);
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
  const releases = [];
  const actualHost = await import("../host.js");
  t.mock.module("../host.js", { exports: {
    ...actualHost,
    native: true,
    onSurfacePrepared: () => () => {},
    surfaceContextRuntime: (surface, declarations) => {
      const runtime = actualHost.surfaceContextRuntime(surface, declarations);
      return { ...runtime, native: { ...runtime.native, on: (name) => {
        if (name !== "view-call") return Promise.resolve(() => {});
        return new Promise((resolve) => releases.push(() => resolve(() => {})));
      }, call: async () => null } };
    },
  } });
  const { mountSurface, authorizeSurface, disposeSurface, waitSurfaceCompositionDeclared } = await import("../surface-modules.js?view-remount");
  const pluginId = "fixture-view-remount";
  const surfaceId = "fixture-view-remount-surface";
  recordOrigin(surfaceId, null);
  registerPlugin({ id: pluginId, surface: () => null });
  const composition = { kind: "view", page: "ui/page.html" };
  const surface = { module: null, surfaceId, pluginId, declarations: { status: [], commands: [], dom: [] }, sidecars: [], composition };
  try {
    authorizeSurface(surfaceId);
    await mountSurface(document.querySelector("#slot"), surface);
    await waitSurfaceCompositionDeclared(surfaceId);
    await disposeSurface(surfaceId);
    authorizeSurface(surfaceId);
    await mountSurface(document.querySelector("#slot"), surface);
    await waitSurfaceCompositionDeclared(surfaceId);
  } finally {
    for (const release of releases) release();
    await disposeSurface(surfaceId);
    dom.window.close();
  }
});
