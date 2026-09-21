import { createSurfaceCompositionController, createSurfaceContext, mountSurfaceModule, releaseSurfaceReady } from "@soksak/plugin-api";
import { native, surfaces as hostSurfaces, surfaceContextRuntime } from "./host.js";
import { registry } from "./exposure.js";
import { registerSurfaceExposure } from "./surface-exposure.js";
const mounted = new Map();
const parking = document.createDocumentFragment();
const authorization = new Map();

function authorizationFor(id) {
  let gate = authorization.get(id);
  if (!gate) {
    let resolve;
    gate = { promise: new Promise((done) => { resolve = done; }), resolve };
    authorization.set(id, gate);
  }
  return gate.promise;
}

export function authorizeSurface(id) {
  const gate = authorization.get(id);
  if (gate) gate.resolve();
  else authorization.set(id, { promise: Promise.resolve(), resolve() {} });
}

function pageRuntime(surface, scoped) {
  const invoke = (name, payload) => scoped.native.call(name, payload);
  return {
    surfaces: { report: (message) => invoke("report", message) },
    document: {
      attach: (name) => invoke("documentAttach", { document: name }),
      load: (name, url) => invoke("documentLoad", { document: name, url }),
      go: (name, action) => invoke("documentGo", { document: name, action }),
      detach: (name) => invoke("documentDetach", { document: name }),
      onState: (listener) => scoped.native.on("document-state", (event) => listener(event.document, event.state)),
    },
    image: {
      attach: (name, sidecar) => invoke("imageAttach", { name, sidecar }),
      place: (name, insets, visible) => invoke("imagePlace", { name, insets, visible }),
      focus: (name) => invoke("imageFocus", { name }),
      caret: (name, x, y, width, height) => invoke("imageCaret", { name, x, y, width, height }),
      text: (name, text) => invoke("imageText", { name, text }),
      detach: (name) => invoke("imageDetach", { name }),
      on: (listener) => scoped.native.on("image-event", (event) => listener(event.name, event.event)),
    },
    composition: {
      declare: (declaration) => invoke("compositionDeclare", { composition: declaration }),
      place: (revision, regions, overlays) => invoke("compositionPlace", { revision, regions, overlays }),
    },
    sidecar: scoped.sidecar,
  };
}

export async function mountSurface(slot, surface, { onState = () => {} } = {}) {
  if (!slot || !surface?.module) throw new TypeError("surface module mount requires a slot and module");
  const view = slot.ownerDocument?.defaultView ?? globalThis;
  let entry = mounted.get(surface.surfaceId);
  if (entry && entry.slot === slot) {
    if (entry.host.parentNode !== slot) slot.appendChild(entry.host);
    entry.host.removeAttribute("data-surface-suspended");
    return entry.ready;
  }
  if (!entry) {
    for (const other of mounted.values()) {
      if (other.slot === slot && other.surfaceId !== surface.surfaceId) {
        other.host.dataset.surfaceSuspended = "true";
        parking.append(other.host);
      }
    }
    const host = document.createElement("div");
    host.className = "surface-module-host";
    host.style.cssText = "position:absolute;inset:0;overflow:hidden";
    slot.append(host);
    const shadow = host.attachShadow({ mode: "open" });
    const scoped = surfaceContextRuntime(surface, surface.declarations ?? {});
    const page = pageRuntime(surface, scoped);
    let viewport = slot;
    const eventListeners = new Map();
    const emit = (type, detail) => {
      for (const listener of eventListeners.get(type) ?? []) listener(detail);
    };
    const on = (type, listener) => {
      if (!eventListeners.has(type)) eventListeners.set(type, new Set());
      eventListeners.get(type).add(listener);
      return () => eventListeners.get(type)?.delete(listener);
    };
    const composition = {
      create: async (elements) => {
        await page.composition.declare(surface.composition);
        return createSurfaceCompositionController(page, surface.composition, elements, view, () => viewport);
      },
    };
    const context = createSurfaceContext({
      root: shadow, surfaceId: surface.surfaceId, pluginId: surface.pluginId,
      metadata: { home: surface.home },
      declarations: surface.declarations ?? {}, composition,
      runtime: { sidecar: scoped.sidecar, native: scoped.native, exposure: scoped.exposure, emit, on },
    });
    const exposure = registerSurfaceExposure({ root: shadow, expose: context.exposure, view,
      declarations: registry.surfaceDeclarations() });
    const state = context.status.subscribe(onState);
    onState(context.status.read());
    entry = { slot, host, shadow, context, state, exposure, ready: null, disposed: false, surfaceId: surface.surfaceId,
      setViewport: (next) => { viewport = next; } };
    mounted.set(surface.surfaceId, entry);
    entry.ready = Promise.all([exposure.ready, native ? authorizationFor(surface.surfaceId) : Promise.resolve()])
      .then(() => {
        // A tab can be removed while its first native authorization is pending. Do not
        // start a module for a surface that the current page no longer owns.
        if (entry.disposed) return null;
        return import(surface.module);
      }).then((module) => module && mountSurfaceModule(module, shadow, context))
      .then(async (mountedModule) => {
        if (!mountedModule) return null;
        entry.module = mountedModule;
        if (native) await hostSurfaces.waitPresented();
        releaseSurfaceReady(context);
        return mountedModule;
      })
      .catch((error) => {
        if (entry.disposed) return null;
        context.status.report("error", error);
        throw error;
      });
  } else {
    for (const other of mounted.values()) {
      if (other.slot === slot && other.surfaceId !== surface.surfaceId) {
        other.host.dataset.surfaceSuspended = "true";
        parking.append(other.host);
      }
    }
    entry.slot = slot;
    entry.setViewport(slot);
    if (entry.host.parentNode !== slot) slot.appendChild(entry.host);
    entry.host.removeAttribute("data-surface-suspended");
  }
  return entry.ready;
}

export function suspendSurface(surfaceId) {
  const entry = mounted.get(surfaceId);
  if (entry) entry.host.dataset.surfaceSuspended = "true";
}

export async function disposeSurface(surfaceId) {
  const entry = mounted.get(surfaceId);
  if (!entry) return;
  if (entry.disposing) return entry.disposing;
  entry.disposed = true;
  entry.disposing = (async () => {
    // Do not wait for authorization here. A removed tab must not keep a layout
    // commit alive merely because its module has never been allowed to mount.
    if (entry.module) await entry.module.dispose();
    entry.exposure.dispose();
    await entry.context.exposure.dispose();
    entry.state();
    entry.host.removeAttribute("data-surface-suspended");
    entry.host.remove();
    if (mounted.get(surfaceId) === entry) mounted.delete(surfaceId);
  })();
  return entry.disposing;
}

export const mountedSurface = (surfaceId) => mounted.get(surfaceId) ?? null;

/** Dispose modules whose tabs are no longer declared by the current workspace. */
export async function disposeSurfacesExcept(surfaceIds) {
  const stale = [...mounted.keys()].filter((id) => !surfaceIds.has(id));
  await Promise.all(stale.map((id) => disposeSurface(id)));
}
