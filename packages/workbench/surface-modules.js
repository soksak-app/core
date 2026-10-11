import { createSurfaceCompositionController, createSurfaceContext, mountSurfaceModule, releaseSurfaceReady } from "@soksak/plugin-api";
import { native, onSurfacePrepared, surfaces as hostSurfaces, surfaceContextRuntime } from "./host.js";
import { registry } from "./exposure.js";
import { plugin } from "./registry.js";
import { pluginDiagnostics } from "./environment.js";
import { registerSurfaceExposure } from "./surface-exposure.js";
import { onSettingsChange, pluginSettings } from "./settings.js";
import { onTextSize, surfaceTextSize } from "./text-size.js";
import { forgetTab, reportDirectory, reportError, reportFooter, reportModified, reportNotice, reportTitle, tabOrigin } from "./tab-reports.js";
import { icon } from "./icons.js";
import { active } from "./projects.js";
import { emitEvent } from "./page-log.js";
import { trace } from "./performance.js";
const mounted = new Map();
/* Placeholder of a surface that is not mounted in a document without a host: one element for each surface id. */
const placeholders = new Map();
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

// Starts a native surface module only after the host has created the native handle.
// This preparation callback is the production approval path. Without it, the native mount
// waits indefinitely before reporting an error whose cause can be identified.
if (native) {
  onSurfacePrepared((placements) => {
    for (const placement of placements) authorizeSurface(placement.id);
  });
}

// The last composition revision that this document sent to the host. The host requires the revision of each surface to increase, and it clears the value only when the surface is destroyed or
// the document changes. The new composition of a surface mounted again in the same document counts from 1, so every layout of the document
// is sent with one increasing number (docs/spec/surface-composition.md).
let compositionRevision = 0;

function pageRuntime(surface, scoped, compositionReady) {
  const invoke = (name, payload) => scoped.native.call(name, payload);
  return {
    surfaces: { report: (message) => invoke("report", message) },
    document: {
      attach: (name) => invoke("documentAttach", { document: name }),
      load: (name, url) => invoke("documentLoad", { document: name, url }),
      zoom: (name, zoom) => invoke("documentZoom", { document: name, zoom }),
      go: (name, action, offset) => invoke("documentGo", offset === undefined ? { document: name, action } : { document: name, action, offset }),
      detach: (name) => invoke("documentDetach", { document: name }),
      post: (name, message) => invoke("documentPost", { document: name, message }),
      onState: (listener) => scoped.native.on("document-state", (event) => listener(event.document, event.state)),
      onMessage: (listener) => scoped.native.on("document-message", (event) => listener(event.document, event.message)),
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
          const result = await invoke("compositionDeclare", { plugin: surface.pluginId, composition: declaration });
          compositionReady.resolve();
          return result;
        } catch (error) {
          compositionReady.reject(error);
          throw error;
        }
      },
      // The order inside a composition equals the call order, so the next number of the document is sent instead of the revision of the composition.
      place: (_revision, regions, overlays) => {
        const revision = ++compositionRevision;
        return invoke("compositionPlace", { revision, regions, overlays });
      },
    },
    sidecar: scoped.sidecar,
  };
}

/**
 * Puts the placeholder of a plugin tab that is not loaded in the slot (docs/spec/plugins.md). A mounted surface in the same slot
 * is moved to the holding place, as when another surface is mounted. disposeSurface removes the placeholder when the tab is closed.
 */
export function placePluginPlaceholder(slot, surfaceId, element) {
  for (const other of mounted.values()) {
    if (other.slot === slot) {
      other.host.dataset.surfaceSuspended = "true";
      parking.append(other.host);
    }
  }
  clearSlotPlaceholders(slot, surfaceId);
  placeholders.get(surfaceId)?.remove();
  element.classList.add("surface-placeholder");
  element.dataset.surfaceId = surfaceId;
  slot.append(element);
  placeholders.set(surfaceId, element);
}

/** Removes the placeholder of another tab left in the slot. If another tab of the same card is visible, the placeholder of that tab does not remain. */
function clearSlotPlaceholders(slot, surfaceId) {
  for (const [id, element] of placeholders) {
    if (id !== surfaceId && element.parentNode === slot) {
      element.remove();
      placeholders.delete(id);
    }
  }
}

export async function mountSurface(slot, surface, { onState = () => {} } = {}) {
  if (!slot || !surface?.module) throw new TypeError("surface module mount requires a slot and module");
  clearSlotPlaceholders(slot, surface.surfaceId);
  // Without a host there are no sidecars and no native regions. A surface that needs them is not mounted and a placeholder is drawn.
  // (docs/spec/plugins.md#runtime-module).
  if (!native && (surface.sidecars.length > 0 || surface.composition?.kind === "hybrid")) {
    const placeholder = document.createElement("div");
    placeholder.className = "surface-placeholder";
    placeholder.dataset.surfaceId = surface.surfaceId;
    placeholder.style.cssText = "position:absolute;inset:0;display:grid;place-items:center;color:var(--muted)";
    placeholder.textContent = `${plugin(surface.pluginId).name} 표면은 네이티브 호스트가 있어야 열립니다`;
    placeholders.get(surface.surfaceId)?.remove();
    slot.querySelector(":scope > .surface-placeholder")?.remove();
    slot.append(placeholder);
    placeholders.set(surface.surfaceId, placeholder);
    onState({ phase: "ready" });
    return null;
  }
  const view = slot.ownerDocument.defaultView;
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
    // The text scale is set by .surface-module-host in app.css (docs/spec/text-size.md).
    host.style.cssText = "position:absolute;inset:0;overflow:hidden";
    slot.append(host);
    const shadow = host.attachShadow({ mode: "open" });
    const scoped = surfaceContextRuntime(surface, surface.declarations);
    let resolveComposition;
    let rejectComposition;
    const compositionReady = {
      promise: new Promise((resolve, reject) => { resolveComposition = resolve; rejectComposition = reject; }),
      resolve: resolveComposition,
      reject: rejectComposition,
    };
    // A dom composition has no native region; plugin.json declares it, and its module does not create one.
    if (!native || surface.composition?.kind === "dom") compositionReady.resolve();
    const page = pageRuntime(surface, scoped, compositionReady);
    let viewport = slot;
    const eventListeners = new Map();
    const emit = (type, detail) => {
      // default: an event kind that nothing listens to has no receiver to notify.
      for (const listener of eventListeners.get(type) ?? []) listener(detail);
    };
    const on = (type, listener) => {
      if (!eventListeners.has(type)) eventListeners.set(type, new Set());
      eventListeners.get(type).add(listener);
      return () => eventListeners.get(type)?.delete(listener);
    };
    // The composition that the module created. When a surface is removed, it is released before the dispose of the module (disposeModule).
    const compositions = [];
    const composition = {
      create: async (elements) => {
        if (entry.disposed) throw new Error(`surface ${surface.surfaceId} closed before it created its composition`);
        await page.composition.declare(surface.composition);
        const controller = await createSurfaceCompositionController(page, surface.composition, elements, view,
          () => viewport);
        compositions.push(controller);
        return controller;
      },
    };
    // The mount starts when the tab is in the plane. When the tab leaves the plane, it keeps the last scale until it is released
    // (docs/spec/text-size.md). Even if it leaves during the mount, the module reads the scale from the time the mount started.
    let factor = surfaceTextSize(surface.surfaceId);
    // Diagnostic module. It is filled before the module is loaded.
    let diagnostics = null;
    const closing = new AbortController();
    const context = createSurfaceContext({
      root: shadow, closing: closing.signal, surfaceId: surface.surfaceId, pluginId: surface.pluginId,
      declarations: surface.declarations, composition, diagnostics: () => diagnostics, contributions: surface.contributions,
      tab: { title: (text) => reportTitle(surface.surfaceId, text),
        footer: (text) => reportFooter(surface.surfaceId, text),
        directory: (path) => reportDirectory(surface.surfaceId, path),
        notify: (text, policy) => reportNotice(surface.surfaceId, text, policy),
        modified: (value) => reportModified(surface.surfaceId, value), error: (text) => reportError(surface.surfaceId, text),
        params: surface.params },
      origin: tabOrigin(surface.surfaceId),
      // Canonical root of the project that the surface window shows (docs/spec/plugins.md#tab-reports). A library window has none.
      project: active() ? { root: active().root } : null,
      icon,
      runtime: { sidecar: scoped.sidecar, native: scoped.native, exposure: scoped.exposure, emit, on,
        clipboard: scoped.clipboard,
        links: scoped.links,
        theme: scoped.theme,
        // Actual text scale of this surface (docs/spec/text-size.md). It is read again at each notification and only a changed value is delivered.
        textSize: { read: () => {
          // default: the scale of a tab that is not in the plane is null, so the last notified scale is kept.
          factor = surfaceTextSize(surface.surfaceId) ?? factor;
          if (factor === null) throw new Error(`surface ${surface.surfaceId} is not in the layout`);
          return factor;
        }, on: (listener) => {
          // default: the scale of a tab that is not in the plane is null, so the last notified scale is kept.
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
        // The page trace writes the event while the performance trace is on (docs/spec/plugins.md#tracing).
        trace: (event, fields) => { trace(event, fields); },
        // events: forwarded
        log: (level, event, fields) => { emitEvent(level, event, fields); },
      },
    });
    const state = context.status.subscribe(onState);
    onState(context.status.read());
    entry = { slot, host, shadow, context, closing, state, exposure: null, composition: compositionReady.promise, compositions,
      mounted: null, ready: null, authorized: false, disposed: false, surfaceId: surface.surfaceId,
      setViewport: (next) => { viewport = next; } };
    mounted.set(surface.surfaceId, entry);
    entry.mounted = (native ? authorizationFor(surface.surfaceId) : Promise.resolve())
      .then(async () => {
        // Does not start the registration and module of a surface that was removed while waiting for approval.
        if (entry.disposed) return null;
        entry.authorized = true;
        // Starts the registrations of the core and the plugin after the same native approval.
        entry.exposure = registerSurfaceExposure({ root: shadow, expose: context.exposure, view,
          declarations: registry.surfaceDeclarations() });
        await entry.exposure.ready;
        diagnostics = await pluginDiagnostics(surface.pluginId);
        if (entry.disposed) return null;
        return import(surface.module);
      }).then((module) => {
        return module && mountSurfaceModule(module, shadow, context);
      })
      ;
    entry.ready = entry.mounted.then(async (mountedModule) => {
        if (!mountedModule) return null;
        if (entry.disposed) {
          await disposeModule(entry, mountedModule);
          return null;
        }
        entry.module = mountedModule;
        // A newly created native surface must declare and lay out its image before its first presentation can wait for the raster of that image.
        // Waiting here creates a cycle: the presentation waits for the module, and the
        // composition of the module is the work that builds the raster.
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

/**
 * Waits until a native surface declares its composition; a dom surface has declared it when it mounts. A module that
 * fails to mount declares nothing, so the wait also ends with that mount error.
 */
export async function waitSurfaceCompositionDeclared(surfaceId) {
  if (placeholders.has(surfaceId)) return;
  const entry = mounted.get(surfaceId);
  if (!entry) throw new Error(`surface ${surfaceId} is not mounted`);
  await Promise.race([entry.composition, entry.ready.then(() => entry.composition)]);
}

/**
 * After the card of the mounted surface has settled, gives focus to its native input owner. If the tab is closed while waiting and the release of the surface
 * starts, the region of the released module does not receive focus, so it gives no focus and returns false.
 */
export async function focusSurface(surfaceId) {
  if (placeholders.has(surfaceId)) return false;
  const entry = mounted.get(surfaceId);
  if (!entry) throw new Error(`surface ${surfaceId} is not mounted`);
  await entry.ready;
  if (typeof entry.module?.focus !== "function") return false;
  if (native) await hostSurfaces.waitPresented();
  if (entry.disposed) return false;
  await entry.module.focus();
  return true;
}

export function suspendSurface(surfaceId) {
  const entry = mounted.get(surfaceId);
  if (entry) entry.host.dataset.surfaceSuspended = "true";
}

/**
 * Detaches the region of the surface and releases the module. The dispose of the module ends the sidecar session, and the provider releases the transfer image when it ends the session.
 * The region is detached first, so a frame that the provider sent before that is answered as stale, and the attached region does not show the released image
 * (docs/spec/plugins.md#surface-module-ownership). Repeating the release of a composition waits for the same cleanup, so the module may release it again.
 */
async function disposeModule(entry, module) {
  for (const composition of entry.compositions) await composition.dispose();
  await module.dispose();
}

export async function disposeSurface(surfaceId) {
  placeholders.get(surfaceId)?.remove();
  placeholders.delete(surfaceId);
  const entry = mounted.get(surfaceId);
  if (!entry) return;
  if (entry.disposing) return entry.disposing;
  entry.disposed = true;
  entry.closing.abort();
  entry.disposing = (async () => {
    // It does not wait for approval here. A removed tab must not keep a layout commit alive only because
    // the module was never permitted to mount.
    // A module that has not finished mounting is not waited for: closing removes the surface at once, the compositions
    // that the module created are released here, and a mount that ends later disposes its module (entry.ready).
    if (entry.module) await disposeModule(entry, entry.module);
    else for (const composition of entry.compositions) await composition.dispose();
    if (entry.exposure) entry.exposure.dispose();
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

// default: a surface that is not mounted is null.
export const mountedSurface = (surfaceId) => mounted.get(surfaceId) ?? null;

/** Disposes the modules of the tabs that the current workspace no longer declares. */
export async function disposeSurfacesExcept(surfaceIds) {
  for (const [id, placeholder] of placeholders) {
    if (surfaceIds.has(id)) continue;
    placeholder.remove();
    placeholders.delete(id);
  }
  const stale = [...mounted.keys()].filter((id) => !surfaceIds.has(id));
  await Promise.all(stale.map((id) => disposeSurface(id)));
}
