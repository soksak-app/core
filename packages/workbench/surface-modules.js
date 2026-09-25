import { createSurfaceCompositionController, createSurfaceContext, mountSurfaceModule, releaseSurfaceReady } from "@soksak/plugin-api";
import { native, onSurfacePrepared, surfaces as hostSurfaces, surfaceContextRuntime } from "./host.js";
import { registry } from "./exposure.js";
import { plugin } from "./registry.js";
import { registerSurfaceExposure } from "./surface-exposure.js";
import { onSettingsChange, pluginSettings } from "./settings.js";
import { onTextSize, surfaceTextSize } from "./text-size.js";
import { forgetTab, reportDirectory, reportNotice, reportTitle, tabOrigin } from "./tab-reports.js";
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

// Start a native surface module only after the host creates its native handle.
// This preparation callback is the production authorization path; without it,
// native mounting waits indefinitely before it can report an attributable error.
if (native) {
  onSurfacePrepared((placements) => {
    for (const placement of placements) authorizeSurface(placement.id);
  });
}

function pageRuntime(surface, scoped, compositionReady) {
  const invoke = (name, payload) => scoped.native.call(name, payload);
  return {
    surfaces: { report: (message) => invoke("report", message) },
    document: {
      attach: (name) => invoke("documentAttach", { document: name }),
      load: (name, url) => invoke("documentLoad", { document: name, url }),
      zoom: (name, zoom) => invoke("documentZoom", { document: name, zoom }),
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
      declare: async (declaration) => {
        try {
          const result = await invoke("compositionDeclare", { composition: declaration });
          compositionReady.resolve();
          return result;
        } catch (error) {
          compositionReady.reject(error);
          throw error;
        }
      },
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
    // 글자 배율은 app.css 의 .surface-module-host 가 정한다(docs/spec/text-size.md).
    host.style.cssText = "position:absolute;inset:0;overflow:hidden";
    slot.append(host);
    const shadow = host.attachShadow({ mode: "open" });
    const scoped = surfaceContextRuntime(surface, surface.declarations ?? {});
    let resolveComposition;
    let rejectComposition;
    const compositionReady = {
      promise: new Promise((resolve, reject) => { resolveComposition = resolve; rejectComposition = reject; }),
      resolve: resolveComposition,
      reject: rejectComposition,
    };
    if (!native) compositionReady.resolve();
    const page = pageRuntime(surface, scoped, compositionReady);
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
    // 마운트는 탭이 판에 있을 때 시작한다. 탭이 판에서 빠지면 해제될 때까지 마지막 배율을 유지한다
    // (docs/spec/text-size.md). 마운트 도중 빠져도 모듈은 마운트를 시작한 때의 배율을 읽는다.
    let factor = surfaceTextSize(surface.surfaceId);
    const context = createSurfaceContext({
      root: shadow, surfaceId: surface.surfaceId, pluginId: surface.pluginId,
      metadata: { home: surface.home },
      declarations: surface.declarations ?? {}, composition, diagnostics: plugin(surface.pluginId).diagnostics,
      tab: { title: (text) => reportTitle(surface.surfaceId, text),
        directory: (path) => reportDirectory(surface.surfaceId, path),
        notify: (text) => reportNotice(surface.surfaceId, text) },
      origin: tabOrigin(surface.surfaceId),
      runtime: { sidecar: scoped.sidecar, native: scoped.native, exposure: scoped.exposure, emit, on,
        clipboard: scoped.clipboard,
        links: scoped.links,
        theme: scoped.theme,
        // 이 표면의 실제 글자 배율(docs/spec/text-size.md). 알림마다 다시 읽고 바뀐 값만 전달한다.
        textSize: { read: () => {
          factor = surfaceTextSize(surface.surfaceId) ?? factor;
          if (factor === null) throw new Error(`surface ${surface.surfaceId} is not in the layout`);
          return factor;
        }, on: (listener) => {
          let last = surfaceTextSize(surface.surfaceId) ?? factor;
          return onTextSize(() => {
            const next = surfaceTextSize(surface.surfaceId);
            if (next === null || next === last) return;
            last = next;
            factor = next;
            listener(next);
          });
        } },
        settings: { read: () => pluginSettings(surface.pluginId), on: (listener) =>
          onSettingsChange(() => listener(pluginSettings(surface.pluginId))) },
      },
    });
    const exposure = registerSurfaceExposure({ root: shadow, expose: context.exposure, view,
      declarations: registry.surfaceDeclarations() });
    const state = context.status.subscribe(onState);
    onState(context.status.read());
    entry = { slot, host, shadow, context, state, exposure, composition: compositionReady.promise,
      mounted: null, ready: null, authorized: false, disposed: false, surfaceId: surface.surfaceId,
      setViewport: (next) => { viewport = next; } };
    mounted.set(surface.surfaceId, entry);
    entry.mounted = Promise.all([exposure.ready, native ? authorizationFor(surface.surfaceId) : Promise.resolve()])
      .then(() => {
        entry.authorized = true;
        // A tab can be removed while its first native authorization is pending. Do not
        // start a module for a surface that the current page no longer owns.
        if (entry.disposed) return null;
        return import(surface.module);
      }).then((module) => {
        return module && mountSurfaceModule(module, shadow, context);
      })
      ;
    entry.ready = entry.mounted.then(async (mountedModule) => {
        if (!mountedModule) return null;
        if (entry.disposed) {
          await mountedModule.dispose();
          return null;
        }
        entry.module = mountedModule;
        // A newly created native surface must declare and place its image before
        // the first presentation can wait for that image raster. Waiting here
        // creates a cycle: presentation waits for the module, while the module's
        // composition is the operation that configures the raster.
        releaseSurfaceReady(context);
        return mountedModule;
      }).catch((error) => {
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

/** Wait until a native surface has declared its composition. */
export async function waitSurfaceCompositionDeclared(surfaceId) {
  const entry = mounted.get(surfaceId);
  if (!entry) throw new Error(`surface ${surfaceId} is not mounted`);
  await entry.composition;
}

/** Give a mounted surface's native input owner focus after its card has settled. */
export async function focusSurface(surfaceId) {
  const entry = mounted.get(surfaceId);
  if (!entry) throw new Error(`surface ${surfaceId} is not mounted`);
  await entry.ready;
  if (typeof entry.module?.focus !== "function") return false;
  if (native) await hostSurfaces.waitPresented();
  await entry.module.focus();
  return true;
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
    else if (entry.authorized) await entry.ready;
    entry.exposure.dispose();
    await entry.context.exposure.dispose();
    entry.state();
    entry.host.removeAttribute("data-surface-suspended");
    entry.host.remove();
    forgetTab(surfaceId);
    authorization.delete(surfaceId);
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
