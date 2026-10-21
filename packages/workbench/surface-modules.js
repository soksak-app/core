import { createSurfaceCompositionController, createSurfaceContext, mountSurfaceModule, releaseSurfaceReady } from "@soksak/plugin-api";
import { native, onSurfacePrepared, surfaces as hostSurfaces, surfaceContextRuntime } from "./host.js";
import { registry, registerSurfacePort } from "./exposure.js";
import { answerViewCall, pluginNativeGate, viewStopState } from "./view-calls.js";
import { createViewSubscriptions } from "./view-events.js";
import { createViewCommands, keepViewCommands } from "./view-commands.js";
import { callReporter } from "./plugin-processes.js";
import { plugin } from "./registry.js";
import { pluginDiagnostics } from "./environment.js";
import { registerSurfaceExposure } from "./surface-exposure.js";
import { onSettingsChange, pluginSettings } from "./settings.js";
import { onTextSize, surfaceTextSize } from "./text-size.js";
import { forgetTab, reportDirectory, reportError, reportFooter, reportKeep, reportModified, reportNotice, reportTitle, tabOrigin,
  unloadTab } from "./tab-reports.js";
import { icon } from "./icons.js";
import { active, tabStateStore, tabStatesReady } from "./projects.js";
import { forgetView, presentationAbandoned, viewResponsiveness } from "./plugin-processes.js";
import { pluginRecords } from "./plugin-records.js";
import { documentRegions } from "./document-regions.js";
import { trace } from "./performance.js";
const mounted = new Map();
/* Placeholder of a surface that is not mounted in a document without a host: one element for each surface id. */
const placeholders = new Map();
const parking = document.createDocumentFragment();

/**
 * The elements of the parked surface hosts and of their shadow roots. A parked host is outside the document, so a count of the
 * document does not reach it; the object counts of diagnostics.objects read it as parkedElements (docs/spec/endpoint.md).
 */
export function parkedElements() {
  const count = (root) => {
    let total = 0;
    for (const element of root.querySelectorAll("*")) total += 1 + (element.shadowRoot ? count(element.shadowRoot) : 0);
    return total;
  };
  return count(parking);
}
const authorization = new Map();
// The listeners (surfaceId, error) of the end of each mount; error is null for a mount that ended.
const mountListeners = new Set();

/** Adds a listener of the end of each mount, which the memory saver reads for a restore; returns its removal. */
export function onSurfaceMounted(listener) {
  mountListeners.add(listener);
  return () => mountListeners.delete(listener);
}

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

/*
 * A place that leaves a surface out closes the document and image regions of that surface in the host
 * (docs/spec/native-surfaces.md#region-lifetime). After it, a detach or an unsubscribe of the release drops only the
 * page-side handle and does not call the host; a region that the page detaches while the surface stays placed calls it.
 */
function pageRuntime(surface, scoped, compositionReady, lifetime) {
  const invoke = (name, payload) => scoped.native.call(name, payload);
  const hostClose = (name, payload) => (lifetime.released ? Promise.resolve(null) : invoke(name, payload));
  // While a place that leaves the surface out runs, the host removes its composition, so a placement is not sent; a failed
  // place resumes the composition, which places its current geometry again (placeSurfaces).
  const composed = (name, payload) => (lifetime.suspended ? Promise.resolve(null) : invoke(name, payload));
  return {
    surfaces: { report: (message) => invoke("report", message) },
    document: {
      attach: (name) => documentRegions.attach(surface.surfaceId, surface.pluginId, name, (request) => invoke("documentAttach", request)),
      load: (name, url) => invoke("documentLoad", { document: name, url }),
      zoom: (name, zoom) => invoke("documentZoom", { document: name, zoom }),
      go: (name, action, offset) => invoke("documentGo", offset === undefined ? { document: name, action } : { document: name, action, offset }),
      detach: async (name) => {
        const reply = await hostClose("documentDetach", { document: name });
        documentRegions.detached(surface.surfaceId, name);
        return reply;
      },
      subscribe: (name, stream) => invoke("documentSubscribe", { document: name, stream }),
      unsubscribe: (name, handle) => hostClose("documentUnsubscribe", { document: name, handle }),
      onStream: (listener) => scoped.native.on("document-stream", (event) => listener(event.document, event.handle, event.message)),
      post: (name, message) => invoke("documentPost", { document: name, message }),
      onState: (listener) => scoped.native.on("document-state", (event) => listener(event.document, event.state)),
      onMessage: (listener) => scoped.native.on("document-message", (event) => listener(event.document, event.message)),
    },
    image: {
      attach: (name, sidecar) => invoke("imageAttach", { name, sidecar }),
      focus: (name) => invoke("imageFocus", { name }),
      caret: (name, x, y, width, height) => invoke("imageCaret", { name, x, y, width, height }),
      text: (name, text) => invoke("imageText", { name, text }),
      detach: (name) => hostClose("imageDetach", { name }),
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
        return composed("compositionPlace", { revision, regions, overlays });
      },
    },
    sidecar: (...args) => {
      const port = scoped.sidecar(...args);
      return { ...port, send: (id, body, cids) => {
        // A place that leaves the surface out ends its sidecar sessions in the host, so a send after the release, such as the end
        // of the session that the dispose of the module sends, has no session and is not sent; a host send would open a session
        // without a project root. A send while that place runs waits for its outcome (placeSurfaces).
        if (lifetime.released) return Promise.resolve(null);
        if (lifetime.suspended) return new Promise((resolve, reject) => lifetime.held.push({ run: () => port.send(id, body, cids), resolve, reject }));
        return port.send(id, body, cids);
      } };
    },
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

/** The store of the tab state store; the page opens it before it mounts a surface. */
function tabStates() {
  const store = tabStateStore();
  if (!store) throw new Error("the tab state store is not open");
  return store;
}

/**
 * The start values of the view of surface (docs/spec/native-surfaces.md#view-surfaces): the members of the surface context that
 * the page receives at start, which the host injects as window.sokSurface before the page of the view runs. project is the
 * project that the window shows, or null in a window without one.
 */
export function viewStartValues(surface, project) {
  return {
    // default: a tab without parameters gives null, as tab.params does (docs/spec/plugins.md).
    params: surface.params ?? null,
    origin: tabOrigin(surface.surfaceId),
    project: project === null ? null : { root: project.root },
    declarations: surface.declarations,
  };
}

/**
 * context.tab.state of a surface whose plugin declares surface.unload as {format, maxBytes} (docs/spec/plugins.md#memory-saver).
 * isDisposed tells whether the surface of this context was disposed; a write after it is refused and reported once.
 */
function tabState(surface, isDisposed) {
  const { surfaceId: tab } = surface;
  const { format, maxBytes } = surface.unload;
  let refused = false;
  return {
    read() {
      // default: a tab without an entry or without a state reads null (docs/spec/plugins.md#memory-saver).
      const stored = tabStates().entry(tab)?.state ?? null;
      if (stored === null) return null;
      if (stored.format !== format) throw new Error(`tab ${tab} state format ${JSON.stringify(stored.format)} is not ${format}`);
      return stored.value;
    },
    write(value) {
      if (isDisposed()) {
        if (!refused) {
          refused = true;
          dispatchEvent(new ErrorEvent("error", { message: `tab ${tab} state write refused: disposed` }));
        }
        return;
      }
      let text;
      try {
        text = JSON.stringify(value);
      } catch (error) {
        throw new TypeError(`tab ${tab} state is not JSON: ${error.message}`);
      }
      if (text === undefined) throw new TypeError(`tab ${tab} state is not JSON: ${typeof value}`);
      const bytes = new TextEncoder().encode(text).length;
      if (bytes > maxBytes) throw new RangeError(`tab ${tab} state of ${bytes} bytes exceeds ${maxBytes}`);
      tabStates().write(tab, { format, value: JSON.parse(text) });
    },
  };
}

/**
 * Answers the call requests and the cancels of the view of surface with the handlers of its context, and sends each reply to the view
 * (docs/spec/native-surfaces.md#view-surfaces). It resolves with the function that ends the answers. page is the runtime of the
 * surface, whose sidecar send ends with its place.
 */
function answerViewCalls(surface, scoped, page, context) {
  // context.tab holds the tab state only when the plugin declares surface.unload, so a view call reads the same handlers.
  const { tab } = context;
  // The plugin-facing native handle of the view: its region calls and view bridge calls are refused here (view-calls.js).
  const gate = pluginNativeGate(scoped.native);
  // The pending calls of this view, by id. A cancel ends the pending call that it names.
  const pending = new Map();
  // The event subscriptions of the view. Each event is pushed to the view as viewEvent, and the subscriptions end with the answers.
  const subscriptions = createViewSubscriptions({
    native: (name, listener) => gate.on(name, listener),
    // The declared sidecar is read at each subscription, because a view without a declared sidecar subscribes to none.
    sidecar: {
      on: (id, listener) => page.sidecar().on(id, listener),
      onFailure: (id, listener) => page.sidecar().onFailure(id, listener),
    },
    textSize: (listener) => context.runtime.textSize.on(listener),
    settings: (listener) => context.runtime.settings.on(listener),
    push: (event, data) => scoped.native.call("viewEvent", { event, data }),
    report: (text) => dispatchEvent(new ErrorEvent("error", { message: text })),
  });
  // The commands of the view. A command is declared through the exposure of the surface, and each request of it runs in the view.
  const viewCommands = createViewCommands({
    plugin: surface.pluginId,
    post: (message) => scoped.native.call("viewRequest", message),
    timeoutOf: (name) => registry.commandTimeout(name),
    report: callReporter(surface.pluginId),
  });
  // The declared UI pull of a declared section sends through this layer, so it is kept by surface until the answers end.
  const forgetCommands = keepViewCommands(surface.surfaceId, viewCommands);
  // The exposure of the view. A forwarded exposure request reaches the view through its exposure-request subscription and is
  // answered through exposureReply of the surface (docs/spec/native-surfaces.md#view-surfaces, view exposure), so the port
  // only consumes the request: without it the page would forward the request to the view again (docs/spec/exposure.md#relay).
  const removeExposurePort = registerSurfacePort(surface.surfaceId, () => {});
  const options = {
    plugin: surface.pluginId,
    pending,
    tab,
    runCore: (name, params) => scoped.call(name, params),
    runOwned: (name, params, owner) => registry.runOwned(name, params, owner),
    runtime: {
      native: gate,
      sidecar: {
        // A view names the sidecar of its send; the name must be the one the surface declares, so no other sidecar is reached.
        send: (id, body, cids, name) => {
          if (!surface.sidecars.includes(name)) throw new Error(`surface ${surface.surfaceId} cannot send to sidecar ${name}`);
          return page.sidecar().send(id, body, cids);
        },
      },
      clipboard: scoped.clipboard,
      links: scoped.links,
      // The log levels of the surface context: the level gate of the page applies at delivery, and a gated record is counted there.
      log: context.runtime.log,
      textSize: context.runtime.textSize,
      settings: context.runtime.settings,
      subscribe: {
        native: (name) => subscriptions.native(name),
        sidecarMessage: (id) => subscriptions.sidecarMessage(id),
        sidecarFailure: (id) => subscriptions.sidecarFailure(id),
        textSize: () => subscriptions.textSize(),
        settings: () => subscriptions.settings(),
      },
      command: {
        // The command is declared through the exposure of the surface, so the registry checks its declaration and owner.
        register: (name) => context.exposure.command(name, (params) => viewCommands.run(name, params)),
      },
      exposure: {
        // A status or dom registration of the view: the registry validates the declaration and applies it, then the host
        // records it, so a reloaded main page receives it again (docs/spec/exposure.md#relay).
        registered: async ({ kind, name }) => {
          registry.registered({ surface: surface.surfaceId, kind, name });
          await scoped.native.call("exposureRegister", { kind, name });
          return null;
        },
      },
    },
    // The composition of the view runs the page operations of the surface that a hybrid composition uses: the revision of the
    // document, the region lifetime of a place and the region record (docs/spec/native-surfaces.md#view-surfaces, regions).
    composition: {
      // default: a view without regions or overlays declares none of them.
      declaration: () => ({ kind: surface.composition.kind, regions: surface.composition.regions ?? [], overlays: surface.composition.overlays ?? [] }),
      place: (regions, overlays) => page.composition.place(0, regions, overlays),
      report: (text) => page.surfaces.report(text),
      document: page.document,
      image: page.image,
    },
  };
  const answering = scoped.native.on("view-call", (event) => {
    if (event?.cancel === true) {
      // A cancel has no reply: the call that it ends replies cancelled.
      answerViewCall(event, options).catch((error) => {
        dispatchEvent(new ErrorEvent("error", { message: `view call ${event.id} cancel: ${error.message}` }));
      });
      return;
    }
    answerViewCall(event, options).then(
      // default: a handler that returns no value replies with null, which is the result of a call without a value.
      (result) => ({ id: event.id, result: result ?? null }),
      // default: a rejection that is not an Error replies with its text.
      (error) => ({ id: event.id, error: { code: -32000, message: String(error?.message ?? error) } }),
    ).then((reply) => scoped.native.call("viewReply", reply));
  });
  // The replies of the view to the commands of the page.
  const replies = scoped.native.on("view-reply", (event) => {
    try {
      viewCommands.receive(event);
    } catch (error) {
      // default: a failure that is not an Error carries its value as the text.
      dispatchEvent(new ErrorEvent("error", { message: `view command reply ${event?.id}: ${error?.message ?? error}` }));
    }
  });
  // The answers end with the view: the listeners are removed, the open command runs end, and each page subscription is ended.
  return Promise.all([answering, replies]).then(([offCall, offReply]) => () => {
    offCall();
    offReply();
    forgetCommands();
    removeExposurePort();
    viewCommands.close();
    return subscriptions.close();
  });
}

export async function mountSurface(slot, surface, { onState = () => {} } = {}) {
  // A view surface has no module: its page is loaded by the host into the view (docs/spec/plugins.md#view-surfaces).
  const viewSurface = surface?.composition?.kind === "view";
  if (!slot || (!surface?.module && !viewSurface)) throw new TypeError("surface module mount requires a slot and module");
  // The start of the mount for the trace event surface.mount, which covers the wait for the earlier dispose too.
  const started = performance.now();
  // A tab that is restored while its unload still disposes it mounts a new surface after that dispose ends.
  const leaving = mounted.get(surface.surfaceId)?.disposing;
  if (leaving) await leaving;
  clearSlotPlaceholders(slot, surface.surfaceId);
  // Without a host there are no sidecars and no native regions. A surface that needs them is not mounted and a placeholder is drawn.
  // (docs/spec/plugins.md#runtime-module).
  if (!native && (surface.sidecars.length > 0 || surface.composition?.kind === "hybrid" || viewSurface)) {
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
    // A right click and a command of an element find the surface that holds the element through this attribute.
    host.dataset.surface = surface.surfaceId;
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
    // released becomes true when a place left the surface out; the host then owns the end of its regions.
    const lifetime = { released: false, suspended: false, held: [] };
    const page = pageRuntime(surface, scoped, compositionReady, lifetime);
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
      tab: { title: (text) => {
        reportTitle(surface.surfaceId, text);
        if (surface.unload) tabStates().cacheLabel(surface.surfaceId, surface.pluginId, text);
      },
        footer: (text) => reportFooter(surface.surfaceId, text),
        directory: (path) => reportDirectory(surface.surfaceId, path),
        notify: (text, policy) => reportNotice(surface.surfaceId, text, policy),
        modified: (value) => reportModified(surface.surfaceId, value), error: (text) => reportError(surface.surfaceId, text),
        keep: (reason, on) => reportKeep(surface.surfaceId, reason, on),
        ...(surface.unload ? { state: tabState(surface, () => entry.disposed) } : {}),
        params: surface.params },
      origin: tabOrigin(surface.surfaceId),
      // Canonical root of the project that the surface window shows (docs/spec/plugins.md#tab-reports). A library window has none.
      project: active() ? { root: active().root } : null,
      icon,
      runtime: { sidecar: page.sidecar, native: pluginNativeGate(scoped.native), exposure: scoped.exposure, emit, on,
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
        // A command that core declares, run for this surface (docs/spec/plugins.md#surface-module-ownership). A command of a
        // plugin is refused: a plugin connects its own commands through its exposure.
        command: (name, params) => (typeof name === "string" && name.startsWith("core.")
          ? scoped.call(name, params)
          : Promise.reject(new Error(`runtime.command: ${name} is not a command of core`))),
        // The event log and the performance trace of the page, with their gates (docs/spec/plugins.md#tracing, #logging).
        ...pluginRecords,
      },
    });
    const state = context.status.subscribe(onState);
    onState(context.status.read());
    entry = { slot, host, shadow, context, closing, lifetime, state, exposure: null, composition: compositionReady.promise, compositions,
      mounted: null, ready: null, authorized: false, disposed: false, surfaceId: surface.surfaceId,
      setViewport: (next) => { viewport = next; } };
    mounted.set(surface.surfaceId, entry);
    if (viewSurface) {
      const answering = answerViewCalls(surface, scoped, page, context);
      // A view that stopped its restarts shows its reason as the error of the surface (docs/spec/native-surfaces.md#view-surfaces).
      const stopping = scoped.native.on("view-stopped", (event) => onState(viewStopState(event)));
      // The responsiveness of the view is the state of its surface in core.plugin.views, and the surface keeps no state after its dispose.
      const responding = scoped.native.on("view-responsiveness", (event) => viewResponsiveness(surface.pluginId, surface.surfaceId, event.responsive));
      // A presentation wait that ended without the presentation of the view counts losses.abandoned of the plugin.
      const abandoning = scoped.native.on("view-presentation-abandoned", () => presentationAbandoned(surface.pluginId));
      // The host closed the document and image regions of the surface with the ended view, so the region record forgets them
      // until the restarted view attaches them again (docs/spec/native-surfaces.md#view-surfaces).
      const ending = scoped.native.on("view-process-ended", () => documentRegions.released(surface.surfaceId));
      closing.signal.addEventListener("abort", () => {
        answering.then((off) => off());
        stopping.then((off) => off());
        responding.then((off) => off());
        abandoning.then((off) => off());
        ending.then((off) => off());
        forgetView(surface.surfaceId);
      }, { once: true });
    }
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
        // The module of a declaring surface reads and writes its tab state, which the page opens after the first plane.
        if (surface.unload) await tabStatesReady();
        if (entry.disposed) return null;
        // The workbench mounts no module for a view. It declares the view composition, which resolves the composition wait of the surface.
        if (viewSurface) {
          await page.composition.declare(surface.composition);
          return null;
        }
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
        trace("surface.mount", { plugin: surface.pluginId, surface: surface.surfaceId, ms: performance.now() - started });
        // A newly created native surface must declare and lay out its image before its first presentation can wait for the raster of that image.
        // Waiting here creates a cycle: the presentation waits for the module, and the
        // composition of the module is the work that builds the raster.
        releaseSurfaceReady(context);
        for (const listener of mountListeners) listener(surface.surfaceId, null);
        return mountedModule;
      }).catch((error) => {
        if (entry.disposed) return null;
        context.status.report("error", error);
        for (const listener of mountListeners) listener(surface.surfaceId, error);
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

/**
 * Releases the surface of a tab. The close (no mode) forgets the tab reports; the mode "unload" keeps them and clears only
 * the error, because the tab stays in the layout (docs/spec/plugins.md#memory-saver). released states that a place already
 * left the surface out, so the host closed its regions and the release drops only the page-side handles.
 */
export async function disposeSurface(surfaceId, { mode, released = false } = {}) {
  if (mode !== undefined && mode !== "unload") throw new TypeError(`unknown dispose mode: ${String(mode)}`);
  placeholders.get(surfaceId)?.remove();
  placeholders.delete(surfaceId);
  const entry = mounted.get(surfaceId);
  if (!entry) return;
  if (released) entry.lifetime.released = true;
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
    // The host closes the document regions of a released surface.
    documentRegions.released(surfaceId);
    if (mode === "unload") unloadTab(surfaceId);
    else forgetTab(surfaceId);
    authorization.delete(surfaceId);
    if (mounted.get(surfaceId) === entry) mounted.delete(surfaceId);
  })();
  return entry.disposing;
}

// default: a surface that is not mounted is null.
export const mountedSurface = (surfaceId) => mounted.get(surfaceId) ?? null;

/** Disposes the modules of the tabs that the current workspace no longer declares. */
export async function disposeSurfacesExcept(surfaceIds, { released = false } = {}) {
  for (const [id, placeholder] of placeholders) {
    if (surfaceIds.has(id)) continue;
    placeholder.remove();
    placeholders.delete(id);
  }
  const stale = [...mounted.keys()].filter((id) => !surfaceIds.has(id));
  await Promise.all(stale.map((id) => disposeSurface(id, { released })));
}

/**
 * Runs a place, and only after it succeeds releases the surfaces it left out: the ids of unload in the unload mode and
 * every other surface outside retain. The place closed their regions in the host (docs/spec/native-surfaces.md#region-lifetime),
 * so the release drops only the page-side handles. A failed place releases nothing, so its surfaces stay mounted.
 * Resolves the reply of the place.
 */
export async function placeSurfaces(place, { retain, unload = [] }) {
  // The place removes the compositions of the surfaces it leaves out before it replies, so their compositions stop sending
  // placements first; the release that follows a successful place does not detach them.
  const left = new Set(unload);
  for (const id of mounted.keys()) if (!retain.has(id)) left.add(id);
  const leftOut = [...left].filter((id) => mounted.has(id)).map((id) => mounted.get(id));
  for (const entry of leftOut) entry.lifetime.suspended = true;
  let answer;
  try {
    answer = await place();
  } catch (error) {
    // A failed place keeps the surfaces mounted, so their compositions resume and place their current geometry. A resume that
    // fails is part of the failure of the place, which the caller reports.
    const resumed = [];
    for (const entry of leftOut) {
      entry.lifetime.suspended = false;
      for (const held of entry.lifetime.held.splice(0)) held.run().then(held.resolve, held.reject);
      for (const composition of entry.compositions) resumed.push(composition.update(() => {}));
    }
    const failures = (await Promise.allSettled(resumed)).filter((result) => result.status === "rejected").map((result) => result.reason);
    if (failures.length) throw new AggregateError([error, ...failures], `${error.message}; ${failures.length} compositions did not resume`);
    throw error;
  }
  for (const entry of leftOut) {
    entry.lifetime.released = true;
    for (const held of entry.lifetime.held.splice(0)) held.resolve(null);
  }
  await Promise.all(unload.map((id) => disposeSurface(id, { mode: "unload", released: true })));
  await disposeSurfacesExcept(retain, { released: true });
  return answer;
}
