import { LOG_LEVELS, createSurfaceContext, releaseSurfaceReady } from "@soksak/plugin-api";
import { native, onSurfacePrepared, surfaces as hostSurfaces, surfaceContextRuntime } from "./host.js";
import { markViewSurface, registry } from "./exposure.js";
import { answerViewCall, pluginNativeGate, viewStopState } from "./view-calls.js";
import { createViewSubscriptions } from "./view-events.js";
import { createViewCommands, keepViewCommands } from "./view-commands.js";
import { onSourceOriginRegistered, sourceOrigin } from "./source-origins.js";
import { callReporter } from "./plugin-processes.js";
import { plugin } from "./registry.js";
import { pluginDiagnostics } from "./environment.js";
import { onSettingsChange, pluginSettings } from "./settings.js";
import { onTextSize, surfaceTextSize } from "./text-size.js";
import { forgetTab, reportDirectory, reportError, reportFooter, reportKeep, reportModified, reportNotice, reportTitle, originHistory, tabOrigin,
  unloadTab, viewRefusal } from "./tab-reports.js";
import { icon } from "./icons.js";
import { active, tabStateStore, tabStatesReady } from "./projects.js";
import { forgetView, presentationAbandoned, viewResponsiveness } from "./plugin-processes.js";
import { pluginRecords } from "./plugin-records.js";
import { logGate } from "./log-gate.js";
import { emitEvent, eventEnabled } from "./page-log.js";
import shortcutTable from "./shortcuts.json" with { type: "json" };
import { documentRegions } from "./document-regions.js";
import { trace } from "./performance.js";
const mounted = new Map();
const mounting = new Map();
let nextMountAttempt = 0;
/* Placeholder of a surface that is not mounted in a document without a host: one element for each surface id. */
const placeholders = new Map();

const authorization = new Map();
// The listeners (surfaceId, error) of the end of each mount; error is null for a mount that ended.
const mountListeners = new Set();

/** Adds a listener of the end of each mount, which the memory saver reads for a restore; returns its removal. */
export function onSurfaceMounted(listener) {
  mountListeners.add(listener);
  return () => mountListeners.delete(listener);
}

function createMountRegistration() {
  let announce;
  let announced = false;
  const registered = new Promise((resolve) => { announce = resolve; });
  const record = {
    attempt: null, state: "reserved", entry: null, phase: null, reason: null, registered,
    announce(outcome) {
      if (announced) return;
      announced = true;
      record.registered = null;
      announce(outcome);
    },
  };
  return record;
}

function recordMountFailure(entry, phase, error) {
  const record = entry.mountRegistration;
  if (!record || record.attempt === null || record.state === "failed") return;
  const reason = String(error?.message ?? error);
  record.state = "failed";
  record.phase = phase;
  record.reason = reason;
  emitEvent("error", "page.surface.mount.failed", {
    plugin: entry.pluginId, surface: entry.surfaceId, attempt: record.attempt, phase, reason,
  });
}

function mountFailureError(surfaceId, record) {
  return new Error(`surface ${surfaceId} mount attempt ${record.attempt} failed during ${record.phase}: ${record.reason}`);
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

// Authorizes the workbench context of a view to install its listeners and declare composition. The plugin page itself remains
// host-created by syncSurfaces after that declaration. A prepared placement also authorizes its surface for later remounts.
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
      // A refused declaration leaves the composition wait pending; the wait ends with the mount error (waitSurfaceCompositionDeclared).
      declare: async (declaration) => {
        const result = await invoke("compositionDeclare", { plugin: surface.pluginId, composition: declaration });
        compositionReady.resolve();
        return result;
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
      other.host.remove();
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
 * The origin of a surface. A tab without one is named with its plugin, space, project and history, so the refusal shows where the tab
 * was created (docs/spec/projects.md#tab-origin).
 */
function originOf(surface) {
  try {
    return tabOrigin(surface.surfaceId);
  } catch (error) {
    const project = active();
    // default: the refusal record names an absent project, space or plugin as none, because a window without them also refuses.
    const space = project?.spaces.find((s) => s.id === project.activeSpaceId) ?? null;
    // default: as above, each absent member of the record is written as none.
    throw new TypeError(`${error.message}: plugin ${surface.pluginId ?? "none"}, space ${space?.id ?? "none"}, project ${project?.id ?? "none"}, ${originHistory(surface.surfaceId)}`);
  }
}

/**
 * The start values of the view of surface (docs/spec/native-surfaces.md#view-surfaces): the members of the surface context that
 * the page receives at start, which the host injects as window.sokSurface before the page of the view runs. project is the
 * project that the window shows, or null in a window without one.
 */
export function viewStartValues(surface, project) {
  // The layout read refuses a view tab first and the place leaves it out; a refusal that reaches this point is a defect, so it throws.
  const refusal = viewRefusal(surface.surfaceId);
  if (refusal !== null) throw new TypeError(refusal);
  return {
    // default: a tab without parameters gives null, as tab.params does (docs/spec/plugins.md).
    params: surface.params ?? null,
    origin: originOf(surface),
    project: project === null ? null : { id: project.id, root: project.root },
    declarations: Object.fromEntries(["status", "commands", "dom"].map((kind) =>
      [kind, [...registry.surfaceDeclarations()[kind], ...(surface.declarations[kind] ?? [])]])),
  };
}

/** Builds the canonical surface descriptor from the tab, including its stored start parameters. */
export function surfaceForTab(tab) {
  return { ...plugin(tab.plugin).surface(tab.id), surfaceId: tab.id, pluginId: tab.plugin, params: tab.params ?? null };
}

/** Adds the document-start values to each view using the descriptor supplied by its slot or stored tab. */
export function surfacePlacementsForHost(surfaces, project) {
  return surfaces.map((entry) => entry.surface.composition?.kind === "view" && native
    ? { ...entry, start: viewStartValues(entry.surface, project) }
    : entry);
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
 * (docs/spec/native-surfaces.md#view-surfaces). It returns a cleanup function and adds listener registrations to registrations.
 * page is the runtime of the surface, whose sidecar send ends with its place. closing is the signal of the mount, which removes the
 * exposure port at its dispose.
 */
function collectNativeListeners(registrations) {
  let active = true;
  let removed = false;
  const offFunctions = [];
  const release = (off) => {
    try {
      off();
    } catch (error) {
      dispatchEvent(new ErrorEvent("error", { message: `native listener cleanup: ${error?.message ?? error}` }));
    }
  };
  const remove = () => {
    if (removed) return;
    removed = true;
    active = false;
    for (const off of offFunctions.splice(0).reverse()) release(off);
  };
  const ready = Promise.all(registrations.map((registration) => Promise.resolve(registration).then((off) => {
    if (typeof off !== "function") throw new TypeError("native listener registration did not return a cleanup function");
    if (active) offFunctions.push(off);
    else release(off);
  })));
  const settled = ready.then(() => null, (error) => {
    remove();
    throw error;
  });
  return { settled, remove };
}

function answerViewCalls(surface, scoped, page, context, closing, registrations) {
  // context.tab holds the tab state only when the plugin declares surface.unload, so a view call reads the same handlers.
  const { tab } = context;
  // The plugin-facing native handle of the view: its region calls and view bridge calls are refused here (view-calls.js).
  const gate = pluginNativeGate(scoped.native);
  // The pending calls of this view, by id. A cancel ends the pending call that it names.
  let pending = new Map();
  let documentGeneration = 0;
  // The event subscriptions of the view. Each event is pushed to the view as viewEvent, and the subscriptions end with the answers.
  const subscriptions = createViewSubscriptions({
    // All exposure requests belong to the actual view document, including its core entries.
    native: (name, listener) => gate.on(name, listener),
    // The declared sidecar is read at each subscription, because a view without a declared sidecar subscribes to none.
    sidecar: {
      on: (id, listener) => page.sidecar().on(id, listener),
      onFailure: (id, listener) => page.sidecar().onFailure(id, listener),
    },
    // The surface runtime returns the off function at once; the view subscriptions take a promise of it (view-events.js).
    textSize: (listener) => Promise.resolve(context.runtime.textSize.on(listener)),
    settings: (listener) => Promise.resolve(context.runtime.settings.on(listener)),
    // The value of a status of the view: the registry follows the status and reports each value to the listener. A status that the
    // exposure declares names no status of the view, so the declaration is checked before the observation (view-calls.js).
    status: (name, listener) => registry.observe(name, undefined, (value) => listener(value)),
    // The stored levels of a record of the plugin, read again at each change of the policy of the page gate.
    logLevels: {
      read: () => LOG_LEVELS.filter((level) => eventEnabled(level)),
      on: (listener) => Promise.resolve(logGate.onChange(listener)),
    },
    push: (event, data) => scoped.native.call("viewEvent", { generation: viewGeneration, event, data }),
    closing,
    cancel: (event) => emitEvent("debug", "page.view.event.cancel", {
      plugin: surface.pluginId, surface: surface.surfaceId, event,
    }),
    report: (text) => dispatchEvent(new ErrorEvent("error", { message: text })),
  });
  // The commands of the view. A command is declared through the exposure of the surface, and each request of it runs in the view.
  // The native view is created by declaring the composition below, so its first source generation may not exist yet.
  // Listener installation is synchronous; the ordered registration event makes the generation available before calls arrive.
  let viewGeneration = sourceOrigin(surface.pluginId, surface.surfaceId);
  let viewCommands;
  let forgetCommands;
  const installViewCommands = (generation) => {
    const commands = createViewCommands({
      plugin: surface.pluginId,
      generation,
      post: (message) => scoped.native.call("viewRequest", message),
      timeoutOf: (name) => registry.commandTimeout(name),
      report: callReporter(surface.pluginId),
    });
    viewCommands = commands;
    forgetCommands = keepViewCommands(surface.surfaceId, commands, generation);
  };
  if (Number.isSafeInteger(viewGeneration) && viewGeneration > 0) installViewCommands(viewGeneration);
  const refreshViewCommands = (generation = sourceOrigin(surface.pluginId, surface.surfaceId)) => {
    if (!Number.isSafeInteger(generation) || generation < 1 || (generation === viewGeneration && viewCommands)) return false;
    if (viewCommands) {
      forgetCommands();
      viewCommands.close();
    }
    viewGeneration = generation;
    installViewCommands(generation);
    return true;
  };
  const stopObservingSource = onSourceOriginRegistered(surface.pluginId, surface.surfaceId, (generation) => {
    if (sourceOrigin(surface.pluginId, surface.surfaceId) === generation) refreshViewCommands(generation);
  });
  const currentSourceGeneration = () => sourceOrigin(surface.pluginId, surface.surfaceId);
  // The exposure of the view. A forwarded exposure request of the view reaches the view through its exposure-request subscription and is
  // answered through exposureReply of the surface (docs/spec/native-surfaces.md#view-surfaces, view exposure), so the page does not
  // forward it again (docs/spec/exposure.md#relay). The mark is set here and not through a main-page placeholder.
  const unmarkView = markViewSurface(surface.surfaceId);
  // The mark ends at the dispose of the mount, which is synchronous. The listener registrations below settle later, so their teardown
  // is not the end of the mark: a mount of the same surface that follows the dispose marks it again.
  closing.addEventListener("abort", unmarkView, { once: true });
  const options = {
    plugin: surface.pluginId,
    surface: surface.surfaceId,
    pending,
    tab,
    contributions: context.contributions,
    shortcuts: shortcutTable.shortcuts,
    emitEvent,
    runCore: (name, params, cids) => scoped.call(name, params, cids),
    runOwned: (name, params, owner, cids) => registry.runOwned(name, params, owner, cids),
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
      // The record path of the error display: the host call report of the surface writes the error line to the application log.
      report: (line) => scoped.native.call("report", line),
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
        logLevels: () => subscriptions.logLevels(),
        statusWatch: (name) => {
          if (!registry.declared("status", name)) throw new Error(`view call runtime.status.watch ${name} is not a declared status`);
          return subscriptions.statusWatch(name);
        },
        statusUnwatch: (name) => subscriptions.statusUnwatch(name),
      },
      command: {
        // The command is declared through the exposure of the surface, so the registry checks its declaration and owner.
        register: (name) => context.exposure.command(name, (params, cause) => viewCommands.run(name, params, cause.cids)),
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
    // The composition of the view runs the page operations of its surface: the revision of the
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
    const currentSource = currentSourceGeneration();
    if (!Number.isSafeInteger(event?.generation) || event.generation < 1 || event.generation !== currentSource) {
      emitEvent("debug", "page.view.call.cancel", {
        plugin: surface.pluginId, surface: surface.surfaceId, id: event?.id, command: String(event?.command ?? ""),
      });
      return;
    }
    refreshViewCommands(currentSource);
    if (event?.cancel === true) {
      // A cancel has no reply: the call that it ends replies cancelled.
      answerViewCall(event, { ...options, pending }).catch((error) => {
        dispatchEvent(new ErrorEvent("error", { message: `view call ${event.id} cancel: ${error.message}` }));
      });
      return;
    }
    if (closing.aborted) {
      emitEvent("debug", "page.view.call.cancel", {
        plugin: surface.pluginId, surface: surface.surfaceId, id: event.id, command: String(event.command),
      });
      return;
    }
    // The receipt of a call and its reply are records of the page at the debug level, so a call that never replies is the last
    // receipt without a reply (docs/spec/logging.md#policy).
    emitEvent("debug", "page.view.call", { plugin: surface.pluginId, surface: surface.surfaceId, id: event.id, command: String(event.command) });
    // A surface that declares surface.unload reads its tab state from the store, which the page opens during its start (projects.js).
    // Its call waits until the store has been tried, as the mount does, so a call during the start is not answered before the store.
    const receivedGeneration = documentGeneration;
    const receivedSourceGeneration = event.generation;
    const receivedPending = pending;
    const receivedOptions = { ...options, pending: receivedPending };
    const runCall = () => {
      if (closing.aborted || receivedGeneration !== documentGeneration ||
          receivedSourceGeneration !== viewGeneration || receivedSourceGeneration !== currentSourceGeneration()) {
        return Promise.reject(new Error("cancelled"));
      }
      return answerViewCall(event, receivedOptions);
    };
    (surface.unload ? tabStatesReady().then(runCall) : runCall()).then(
      // default: a handler that returns no value replies with null, which is the result of a call without a value.
      (result) => ({ id: event.id, result: result ?? null }),
      // default: a rejection that is not an Error replies with its text.
      (error) => ({ id: event.id, error: { code: -32000, message: String(error?.message ?? error) } }),
    ).then((reply) => {
      if (closing.aborted || receivedGeneration !== documentGeneration ||
          receivedSourceGeneration !== viewGeneration || receivedSourceGeneration !== currentSourceGeneration()) {
        emitEvent("debug", "page.view.call.cancel", {
          plugin: surface.pluginId, surface: surface.surfaceId, id: event.id, command: String(event.command),
        });
        return null;
      }
      return scoped.native.call("viewReply", { ...reply, generation: receivedSourceGeneration }).then(() => {
        emitEvent("debug", "page.view.reply", { plugin: surface.pluginId, surface: surface.surfaceId, id: event.id, outcome: "error" in reply ? "error" : "result" });
      });
    }).catch((error) => {
      if (closing.aborted || receivedGeneration !== documentGeneration ||
          receivedSourceGeneration !== viewGeneration || receivedSourceGeneration !== currentSourceGeneration()) {
        emitEvent("debug", "page.view.call.cancel", {
          plugin: surface.pluginId, surface: surface.surfaceId, id: event.id, command: String(event.command),
        });
        return;
      }
      // default: a refusal that is not an Error carries its value as the text.
      dispatchEvent(new ErrorEvent("error", { message: `view call ${event.id} reply: ${error?.message ?? error}` }));
    });
  });
  registrations.push(answering);
  const ending = scoped.native.on("view-process-ended", (event) => {
    if (event?.generation !== viewGeneration) return;
    registry.unregisterSurface(surface.surfaceId);
    documentRegions.released(surface.surfaceId);
    documentGeneration += 1;
    for (const controller of pending.values()) controller.abort();
    pending.clear();
    pending = new Map();
    if (viewCommands) {
      forgetCommands();
      viewCommands.close();
      viewCommands = undefined;
      forgetCommands = undefined;
    }
    viewGeneration = undefined;
    subscriptions.restart().catch((error) => {
      dispatchEvent(new ErrorEvent("error", { message: `view subscriptions restart: ${error.message}` }));
    });
  });
  registrations.push(ending);
  closing.addEventListener("abort", () => {
    for (const controller of pending.values()) controller.abort();
  }, { once: true });
  // The replies of the view to the commands of the page.
  const replies = scoped.native.on("view-reply", (event) => {
    const currentSource = currentSourceGeneration();
    if (!Number.isSafeInteger(event?.generation) || event.generation !== currentSource) return;
    refreshViewCommands(currentSource);
    try {
      viewCommands.receive(event);
    } catch (error) {
      // default: a failure that is not an Error carries its value as the text.
      dispatchEvent(new ErrorEvent("error", { message: `view command reply ${event?.id}: ${error?.message ?? error}` }));
    }
  });
  registrations.push(replies);
  // The answers end with the view: the listeners are removed, the open command runs end, and each page subscription is ended.
  let closed = false;
  return async () => {
    if (closed) return;
    closed = true;
    stopObservingSource();
    if (viewCommands) forgetCommands();
    unmarkView();
    viewCommands?.close();
    await subscriptions.close();
  };
}

export function mountSurface(slot, surface, options = {}) {
  const surfaceId = surface?.surfaceId;
  let registration = null;
  if (typeof surfaceId === "string" && surfaceId) {
    const entry = mounted.get(surfaceId);
    const current = mounting.get(surfaceId);
    if (entry && !entry.disposed && entry.mountRegistration === current && current?.state !== "failed") registration = current;
    else if (current?.state === "reserved" && current.entry === null) registration = current;
    else {
      registration = createMountRegistration();
      mounting.set(surfaceId, registration);
    }
  }
  const pending = mountSurfaceNow(slot, surface, options, registration, () => registration?.announce({ ok: true }));
  if (registration) pending.then(() => {
    if (registration.state === "pending" && registration.entry && !registration.entry.disposed) registration.state = "mounted";
    if (registration.state === "reserved" && registration.attempt === null && mounting.get(surfaceId) === registration) {
      registration.state = "resolved";
      registration.announce({ ok: true });
      mounting.delete(surfaceId);
    }
  }, (error) => {
    if (registration.entry && registration.attempt !== null) recordMountFailure(registration.entry, "mount", error);
    registration.announce({ ok: false, error });
    if (registration.attempt === null && mounting.get(surfaceId) === registration) mounting.delete(surfaceId);
  });
  return pending;
}

async function mountSurfaceNow(slot, surface, { onState = () => {}, retainedTextSize } = {}, registration, registered) {
  // A view surface has no module: its page is loaded by the host into the view (docs/spec/plugins.md#view-surfaces).
  // A surface is a view: its page runs in its view, and the workbench mounts no module (docs/spec/plugins.md#surface-ownership).
  if (!slot) throw new TypeError("surface mount requires a slot");
  if (surface?.composition?.kind !== "view") throw new TypeError(`surface ${surface?.surfaceId} requires a view composition`);
  if (retainedTextSize !== undefined && typeof retainedTextSize !== "function") {
    throw new TypeError(`surface ${surface.surfaceId} retained text size requires a resolver`);
  }
  // The start of the mount for the trace event surface.mount, which covers the wait for the earlier dispose too.
  const started = performance.now();
  // A tab that is restored while its unload still disposes it mounts a new surface after that dispose ends.
  const leaving = mounted.get(surface.surfaceId)?.disposing;
  if (leaving) await leaving;
  clearSlotPlaceholders(slot, surface.surfaceId);
  // Without a host there are no native regions, so a view is not mounted and a placeholder is drawn (docs/spec/plugins.md#runtime-module).
  if (!native) {
    const placeholder = document.createElement("div");
    placeholder.className = "surface-placeholder";
    placeholder.dataset.surfaceId = surface.surfaceId;
    placeholder.style.cssText = "position:absolute;inset:0;display:grid;place-items:center;color:var(--muted)";
    placeholder.textContent = `${plugin(surface.pluginId).name} 표면은 네이티브 호스트가 있어야 열립니다`;
    placeholders.get(surface.surfaceId)?.remove();
    slot.querySelector(":scope > .surface-placeholder")?.remove();
    slot.append(placeholder);
    placeholders.set(surface.surfaceId, placeholder);
    try {
      onState({ phase: "ready" });
    } catch (error) {
      placeholder.remove();
      if (placeholders.get(surface.surfaceId) === placeholder) placeholders.delete(surface.surfaceId);
      throw error;
    }
    registered();
    return null;
  }
  // A view tab whose stored origin is refused does not start its view; the refusal is already shown on the tab by the layout read
  // (docs/spec/projects.md#tab-origin), so mounting it is not an error.
  if (viewRefusal(surface.surfaceId) !== null) return null;
  const view = slot.ownerDocument.defaultView;
  let entry = mounted.get(surface.surfaceId);
  if (entry && entry.slot === slot) {
    if (entry.host.parentNode !== slot) slot.appendChild(entry.host);
    entry.host.removeAttribute("data-surface-suspended");
    registered();
    return entry.ready;
  }
  if (!entry) {
    // A mounted view keeps its last scale after leaving the plane. A cold retained view seeds that value from its owning card
    // once; the live plane scale takes over when the view enters it (docs/spec/text-size.md).
    const initialTextSize = surfaceTextSize(surface.surfaceId);
    let factor = initialTextSize;
    if (factor === null && retainedTextSize !== undefined) {
      const retained = retainedTextSize();
      if (!Number.isFinite(retained) || retained <= 0) {
        throw new TypeError(`surface ${surface.surfaceId} retained text size ${retained} is invalid`);
      }
      factor = retained;
    }
    for (const other of mounted.values()) {
      if (other.slot === slot && other.surfaceId !== surface.surfaceId) {
        other.host.dataset.surfaceSuspended = "true";
        other.host.remove();
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
    const compositionReady = {
      promise: new Promise((resolve) => { resolveComposition = resolve; }),
      resolve: resolveComposition,
    };
    if (!native) compositionReady.resolve();
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
    // Diagnostic module. It is filled before the module is loaded.
    let diagnostics = null;
    const closing = new AbortController();
    const context = createSurfaceContext({
      root: shadow, closing: closing.signal, surfaceId: surface.surfaceId, pluginId: surface.pluginId,
      declarations: surface.declarations, diagnostics: () => diagnostics, contributions: surface.contributions,
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
      origin: originOf(surface),
      // Canonical root of the project that the surface window shows (docs/spec/plugins.md#tab-reports). A library window has none.
      project: active() ? { root: active().root } : null,
      icon,
      runtime: { sidecar: page.sidecar, native: pluginNativeGate(scoped.native), exposure: scoped.exposure, emit, on,
        clipboard: scoped.clipboard,
        links: scoped.links,
        theme: scoped.theme,
        // Actual text scale of this surface (docs/spec/text-size.md). It is read again at each notification and only a changed value is delivered.
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
    let resolveCompositionDisposed;
    const compositionDisposed = new Promise((resolve) => { resolveCompositionDisposed = resolve; });
    entry = { slot, host, shadow, context, closing, lifetime, state, exposure: null, composition: compositionReady.promise,
      compositionDisposed, resolveCompositionDisposed,
      mounted: null, ready: null, authorized: false, disposed: false, compositionDeclared: false,
      surfaceId: surface.surfaceId, pluginId: surface.pluginId, mountRegistration: registration,
      setViewport: (next) => { viewport = next; } };
    if (registration) {
      registration.attempt = ++nextMountAttempt;
      registration.entry = entry;
      registration.state = "pending";
    }
    mounted.set(surface.surfaceId, entry);
    try {
      onState(context.status.read());
      const registrations = [];
      const closeView = answerViewCalls(surface, scoped, page, context, closing.signal, registrations);
      // A view that stopped its restarts shows its reason as the error of the surface (docs/spec/native-surfaces.md#view-surfaces).
      const stopping = scoped.native.on("view-stopped", (event) => onState(viewStopState(event)));
      registrations.push(stopping);
      // The responsiveness of the view is the state of its surface in core.plugin.views, and the surface keeps no state after its dispose.
      const responding = scoped.native.on("view-responsiveness", (event) => {
        if (!Number.isSafeInteger(event?.generation) || event.generation !== sourceOrigin(surface.pluginId, surface.surfaceId)) {
          emitEvent("debug", "page.view.event.cancel", {
            plugin: surface.pluginId, surface: surface.surfaceId, event: "view-responsiveness",
          });
          return;
        }
        viewResponsiveness(surface.pluginId, surface.surfaceId, event.responsive);
      });
      registrations.push(responding);
      // A presentation wait that ended without the presentation of the view counts losses.abandoned of the plugin.
      const abandoning = scoped.native.on("view-presentation-abandoned", () => presentationAbandoned(surface.pluginId));
      registrations.push(abandoning);
      const listenerCollection = collectNativeListeners(registrations);
      const listenerSetup = listenerCollection.settled.then(async () => {
        let closed = false;
        return async () => {
          if (closed) return;
          closed = true;
          listenerCollection.remove();
          await closeView();
        };
      }, async (error) => {
        const cleanup = closeView().catch((cleanupError) => {
          dispatchEvent(new ErrorEvent("error", { message: `view listener cleanup after registration failure: ${cleanupError?.message ?? cleanupError}` }));
        });
        if (entry.disposed) {
          await cleanup;
          dispatchEvent(new ErrorEvent("error", { message: `view listener registration after dispose: ${error?.message ?? error}` }));
        } else if (entry.compositionDeclared) {
          recordMountFailure(entry, "listener-registration", error);
          const releasing = releaseFailedMount(entry, { present: true, value: error }, cleanup);
          context.status.report("error", error);
          for (const listener of mountListeners) listener(surface.surfaceId, error);
          await releasing.catch((releaseError) => {
            dispatchEvent(new ErrorEvent("error", { message: `surface ${surface.surfaceId} release after listener registration failure: ${releaseError?.message ?? releaseError}` }));
          });
        } else await cleanup;
        return null;
      });
      const listenerFailure = listenerCollection.settled.then(
        () => new Promise(() => {}),
        (error) => Promise.reject(error),
      );
      // The host closed the document and image regions of the surface with the ended view, so the region record forgets them
      // until the restarted view attaches them again (docs/spec/native-surfaces.md#view-surfaces).
      closing.signal.addEventListener("abort", () => {
        listenerCollection.remove();
        closeView().catch((error) => {
          dispatchEvent(new ErrorEvent("error", { message: `view listener cleanup: ${error?.message ?? error}` }));
        });
        listenerSetup.then((cleanup) => cleanup?.().catch((error) => {
          dispatchEvent(new ErrorEvent("error", { message: `view listener cleanup: ${error?.message ?? error}` }));
        }), () => {});
        forgetView(surface.surfaceId);
      }, { once: true });
      const mountReadiness = (native ? authorizationFor(surface.surfaceId) : Promise.resolve())
        .then(async () => {
          // Does not start the registration of a surface that was removed while waiting for approval.
          if (entry.disposed) return null;
          entry.authorized = true;
          // The native view registers its own core document entries after its page starts.
          diagnostics = await pluginDiagnostics(surface.pluginId);
          // The tab state of a declaring surface is read after it opens, which the page does after the first plane.
          if (surface.unload) await tabStatesReady();
          if (entry.disposed) return null;
          // The host creates the native view when it receives the composition. Wait until the page has installed the listeners
          // that answer the first view-call and receive its reply; otherwise the new view can call an event with no subscriber.
          const listenersReady = await Promise.race([
            listenerSetup.then((cleanup) => typeof cleanup === "function"),
            entry.compositionDisposed.then(() => false),
          ]);
          if (!listenersReady || entry.disposed) return null;
          // The view declares its composition, which resolves the composition wait of the surface. The surface is ready from that
          // declaration, as a module surface is ready after its module mounts: a view has no module whose mount releases it.
          await page.composition.declare(surface.composition);
          entry.compositionDeclared = true;
          context.status.report("ready");
          releaseSurfaceReady(context);
          return null;
        });
      entry.mounted = Promise.race([mountReadiness, listenerFailure]);
      entry.ready = entry.mounted.catch(async (error) => {
          if (entry.disposed) return null;
          recordMountFailure(entry, "mount", error);
          const releasing = releaseFailedMount(entry, { present: true, value: error });
          context.status.report("error", error);
          for (const listener of mountListeners) listener(surface.surfaceId, error);
          await releasing.catch((releaseError) => {
            dispatchEvent(new ErrorEvent("error", { message: `surface ${surface.surfaceId} release after a failed mount: ${releaseError.message}` }));
          });
          throw error;
        });
      registered();
    } catch (error) {
      recordMountFailure(entry, "mount", error);
      await releaseFailedMount(entry, { present: true, value: error }).catch((releaseError) => {
        dispatchEvent(new ErrorEvent("error", { message: `surface ${surface.surfaceId} release after a failed mount: ${releaseError.message}` }));
      });
      throw error;
    }
  } else {
    for (const other of mounted.values()) {
      if (other.slot === slot && other.surfaceId !== surface.surfaceId) {
        other.host.dataset.surfaceSuspended = "true";
        other.host.remove();
      }
    }
    entry.slot = slot;
    entry.setViewport(slot);
    if (entry.host.parentNode !== slot) slot.appendChild(entry.host);
    entry.host.removeAttribute("data-surface-suspended");
    registered();
  }
  return entry.ready;
}

/**
 * Waits until a native surface declares its composition; a dom surface has declared it when it mounts. A module that
 * fails to mount declares nothing, so the wait also ends with that mount error.
 */
export async function waitSurfaceCompositionDeclared(surfaceId) {
  let entry = mounted.get(surfaceId);
  if (entry && !entry.disposed && entry.ready) {
    if (entry.mountRegistration?.state === "failed") throw mountFailureError(surfaceId, entry.mountRegistration);
    await waitForCompositionEntry(entry);
    return;
  }
  const pending = mounting.get(surfaceId);
  if (pending?.registered) {
    const outcome = await pending.registered;
    if (!outcome.ok) throw outcome.error;
  }
  if (placeholders.has(surfaceId)) return;
  entry = mounted.get(surfaceId);
  if (!entry || entry.disposed) {
    const failed = mounting.get(surfaceId);
    if (failed?.state === "failed") throw mountFailureError(surfaceId, failed);
    throw new Error(`surface ${surfaceId} is not mounted`);
  }
  if (entry.mountRegistration?.state === "failed") throw mountFailureError(surfaceId, entry.mountRegistration);
  await waitForCompositionEntry(entry);
}

async function waitForCompositionEntry(entry) {
  const result = await Promise.race([
    entry.composition,
    entry.ready.then(() => entry.composition),
    entry.compositionDisposed,
  ]);
  if (result?.disposed) {
    if (result.failure?.present) throw result.failure.value;
    throw new Error(`surface ${entry.surfaceId} was disposed before declaring composition`);
  }
}

export function suspendSurface(surfaceId) {
  const entry = mounted.get(surfaceId);
  if (entry) entry.host.dataset.surfaceSuspended = "true";
}

/**
 * Releases what a failed mount registered: the view mark and the exposure of the page end with the mount, and the entry leaves the
 * mounted surfaces, so the next mount of the surface starts a new mount instead of returning this failed one. The approval of the
 * surface stays, because the host still holds the surface, and the tab reports and the error stay for the display.
 */
function releaseFailedMount(entry, failure, beforeRelease = Promise.resolve()) {
  if (entry.disposing) return entry.disposing;
  entry.disposed = true;
  if (!entry.compositionDeclared) entry.resolveCompositionDisposed({ disposed: true, failure });
  const disposing = Promise.resolve().then(async () => {
    await beforeRelease;
    if (entry.exposure) entry.exposure.dispose();
    await entry.context.exposure.dispose();
    entry.state();
    entry.host.remove();
    if (mounted.get(entry.surfaceId) === entry) mounted.delete(entry.surfaceId);
  });
  entry.disposing = disposing;
  entry.closing.abort();
  return disposing;
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
  if (!entry) {
    if (mounting.get(surfaceId)?.state === "failed") mounting.delete(surfaceId);
    return;
  }
  if (released) entry.lifetime.released = true;
  if (entry.disposing) return entry.disposing;
  entry.disposed = true;
  if (!entry.compositionDeclared) entry.resolveCompositionDisposed({ disposed: true, failure: null });
  if (mounting.get(surfaceId) === entry.mountRegistration) mounting.delete(surfaceId);
  entry.disposing = Promise.resolve().then(async () => {
    // It does not wait for approval here. A removed tab must not keep a layout commit alive only because
    // the view was never permitted to mount.
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
  });
  entry.closing.abort();
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
  for (const [id, registration] of mounting) {
    if (!surfaceIds.has(id) && registration.state === "failed") mounting.delete(id);
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
  // The place leaves the regions of the surfaces it leaves out to the host, which closes them before the reply.
  const left = new Set(unload);
  for (const id of mounted.keys()) if (!retain.has(id)) left.add(id);
  const leftOut = [...left].filter((id) => mounted.has(id)).map((id) => mounted.get(id));
  for (const entry of leftOut) entry.lifetime.suspended = true;
  let answer;
  try {
    answer = await place();
  } catch (error) {
    // A failed place keeps the surfaces mounted and resumes their held requests.
    for (const entry of leftOut) {
      entry.lifetime.suspended = false;
      for (const held of entry.lifetime.held.splice(0)) held.run().then(held.resolve, held.reject);
    }
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
