// Registry of the exposed entries of the main page.
//
// Holds the declarations of the core (exposure.json) and of the loaded plugins (exposes in plugin.json), and
// accepts the registration of core entries and of surface pages. It answers the exposure-request that the native
// host sends and forwards a request for a name that a surface registered to that surface. The specification is
// docs/spec/exposure.md.
//
// In a browser runtime without a host, the registry also works inside this document. Then there is no path that
// receives requests and no surface.
import { host } from "@soksak/runtime";
import { errorText } from "./error-text.js";
import { timed, trace } from "./performance.js";
import { emitEvent } from "./page-log.js";
import {
  EXPOSE_KINDS, EXPOSURE_ERRORS, ExposureError, METHOD_KINDS, inertRefusal, surfaceDocumentEntry, declarationKey, declarationMap,
  exposureEntries, replyPayload, validateExposes, validateExposureFile,
} from "@soksak/plugin-api";

/**
 * The command.run request of a run. A surface and the cids of the cause are members only when given, so a request without them is the
 * same request as before.
 */
const commandRequest = (name, params, surface, cids) => ({
  name, params,
  ...(surface === undefined ? {} : { surface }),
  ...(cids === undefined ? {} : { cids }),
});

/** Elements of a core element entry. They are found in the main document by the data-expose attribute. */
const byAttribute = (name) => () => [...document.querySelectorAll(`[data-expose="${name}"]`)];

const ownerOf = (name) => name.slice(0, name.indexOf("."));

/** Whether the name is registered by a surface document: a plugin name or one of the three core document entries. */
const surfaceName = (name) => ownerOf(name) !== "core" || surfaceDocumentEntry(name);

/**
 * Whether a surface id names a section surface, `<space id>/<sidebar id>/<section id>` (docs/spec/plugins.md#sections). A tab id has no "/",
 * so the form tells the two kinds apart.
 */
export function isSectionSurface(surface) {
  return surface.includes("/");
}

/**
 * The surfaces of owners that a request without surface may choose, in registration order: the tab surfaces. A section surface answers
 * only a request that names it or a command that its own view runs (docs/spec/exposure.md#choosing-a-surface).
 */
// default: a name that no surface registered has no owners, so it has no tab surfaces.
const tabSurfacesOf = (owners) => [...(owners?.keys() ?? [])].filter((surface) => !isSectionSurface(surface));

/** The key of one watch. A watch that names a surface and a watch that does not are different. */
// default: as stated above, the surface of a watch that names no surface is null.
const watchKey = (name, surface) => JSON.stringify([name, surface ?? null]);

// Holds the request receivers of the surface modules mounted in this document.
const surfacePorts = new Map();

// The surfaces whose page is a view. A view answers the forwarded requests of its own names through its exposure-request subscription
// (docs/spec/native-surfaces.md#view-surfaces), including the core document entries. No view request reaches the main-page placeholder.
// Each mount of a view holds its own mark, so the dispose of an earlier mount of the same surface removes only its mark.
const viewSurfaces = new Map();

/**
 * Creates one registry.
 *
 *   call(name, arg)  host call. Used for exposureChanged and exposureForward.
 *   It is null when there is no host.
 *   report(error)    reports the error of a state change that the host refused. Required when call exists.
 *
 * After the connection, configure receives the values that the document knows.
 *
 *   surfacePlugin(surface)  id of the plugin that owns the surface, or null for an unknown surface
 *   preferred()             order to choose from when several surfaces registered a name: an array of surface ids
 *   registrationChanged()   called after the registration of a surface changed
 *   unloaded(surface)       whether the memory saver unloaded the tab of the surface (docs/spec/plugins.md#memory-saver)
 */
export function createRegistry({ call = null, report = null } = {}) {
  if (call && typeof report !== "function") throw new TypeError("a registry with a host call needs report(error)");
  const declared = new Map();
  const coreDeclared = new Map();
  const core = exposureEntries(coreDeclared, { place: (element) => options.elementPlace(element), inert: (element) => options.elementInert(element) });
  const methods = new Map();
  /* For each declaration key, the surfaces that registered the entry. Registration order is kept. */
  const surfaces = new Map();
  // The entries of a surface as "<kind> <name>" in sorted order, so the timing of the registrations does not decide the order (docs/spec/exposure.md#plugin-processes).
  const surfaceNames = (surface) => [...surfaces].filter(([, owners]) => owners.has(surface)).map(([key]) => key).sort();
  const registrationTrace = (phase, surface, fields = {}) => trace("surface.registration", {
    phase, surface, timeOrigin: performance.timeOrigin, hasPort: surfacePorts.has(surface), ...fields,
    get names() { return surfaceNames(surface); },
  });
  /* Registrations of surfaces whose owner plugin is not known yet. revisit applies them when the layout that holds the surface is loaded. */
  const pending = new Map();
  /* Surface statuses being watched: for each watch key, the followed surface, the requested surface and the last delivered version. */
  const following = new Map();
  let options = {
    surfacePlugin: () => null, preferred: () => [], registrationChanged: () => {}, unloaded: () => false, leftOut: () => false,
    // Work to wait for after a core command ran. The document passes the drawing of the plane, so a command that changed the layout replies after it is drawn.
    settled: () => undefined,
    // default: without a composition source no applied frame is known, and a view rectangle is refused by forward.
    surfaceFrame: () => null, onStoredChange: null,
    // default: without a modal source every core element has the rectangle of its own document.
    elementPlace: () => null,
    // default: without a modal source no element is inert. It takes null for the document of a surface.
    elementInert: () => false,
    // default: without the workbench of a window the snapshot has no layout, no plugin and no surface.
    snapshotParts: () => ({ layout: null, plugins: [], surfaces: [] }),
    // Called when an observation inside this document fails. It is reported as a page error (docs/spec/plugins.md#sections).
    failed: (error) => dispatchEvent(new ErrorEvent("error", { message: error.message })),
  };
  let forwards = 0;
  /* Observers that follow a surface status inside this document. Section modules use them. */
  const observers = new Set();
  /* The observation chains in progress (a watch, a value read or a release that an observer started), and the waits of idle for the last one. */
  let running = 0;
  let idleWaits = [];

  /** Tracks one observation chain until its callbacks have run, and resolves the waits of idle when the last chain ends. */
  function tracked(chain) {
    running++;
    return chain.finally(() => {
      running--;
      if (running > 0) return;
      const waits = idleWaits;
      idleWaits = [];
      for (const resolve of waits) resolve();
    });
  }
  /* Callbacks that reselect sources when an entry registration changes. */
  const registrationListeners = new Set();
  /* Entries that plugin state modules registered in this document: for each plugin id, the entry table and the read and subscribe of statuses. */
  const pages = new Map();
  /** The entry table when a plugin state module registered the name. */
  const pageOf = (kind, name) => {
    const page = pages.get(ownerOf(name));
    return page?.entries.registered(kind, name) ? page : null;
  };

  const changed = (name, value, surface) => {
    if (!call) return;
    call("exposureChanged", surface === undefined ? { name, value } : { name, surface, value }).then(undefined, (error) =>
      // default: a refusal value may not be an Error, so the value itself is written.
      report(new Error(`status ${name} change was refused: ${errorText(error)}`, { cause: error })));
  };

  /**
   * Forwards a request to a surface. The request has no time limit: the reply of the surface document or the end of its peer ends
   * it. origin is the id of the exposure-request that this document handles when it forwards, so the host ends the forward with
   * that request; a forward that this document starts itself has none (exposureForward in docs/spec/exposure.md).
   */
  async function forward(surface, method, params, origin) {
    if (!call) throw new ExposureError(EXPOSURE_ERRORS.gone, `surface ${surface} has no host`);
    const request = origin === undefined ? { id: ++forwards, surface, method, params } : { id: ++forwards, origin, surface, method, params };
    const reply = await call("exposureForward", request);
    if (reply.error) throw new ExposureError(reply.error.code, reply.error.message);
    if (method === "element.rect" && reply.result && viewSurfaces.has(surface)) {
      const frame = options.surfaceFrame(surface);
      if (!frame || ![frame.x, frame.y].every(Number.isFinite)) {
        throw new ExposureError(EXPOSURE_ERRORS.failed, `surface ${surface} has no valid applied frame`);
      }
      // Native view page zoom is 1. CSS sizing is already in the local rectangle, including the plugin's text-size changes.
      return { ...reply.result, x: reply.result.x + frame.x, y: reply.result.y + frame.y, document: { x: 0, y: 0 } };
    }
    // default: a reply that carries no result is the reply of a command whose result is null.
    return reply.result ?? null;
  }

  /** The surface that receives a request among the surfaces that registered the entry. When the request names a surface, it is that surface. */
  function pick(kind, name, requested) {
    const owners = surfaces.get(declarationKey(kind, name));
    if (requested !== undefined) {
      if (typeof requested !== "string") throw new ExposureError(EXPOSURE_ERRORS.invalidParams, "surface must be a string");
      if (!owners?.has(requested)) {
        // The surface of an unloaded tab is released, so it registers nothing until the tab is restored.
        if (options.unloaded(requested)) throw new ExposureError(EXPOSURE_ERRORS.unregistered, `tab ${requested} is unloaded`);
        throw new ExposureError(EXPOSURE_ERRORS.unregistered, `surface ${requested} has not registered ${kind} ${name}`);
      }
      return requested;
    }
    const choices = tabSurfacesOf(owners);
    if (!choices.length) throw new ExposureError(EXPOSURE_ERRORS.unregistered, `${kind} ${name} is not registered`);
    const first = options.preferred().find((surface) => choices.includes(surface));
    // default: when the preferred surface has not registered, the surface registered last answers.
    return first ?? choices.at(-1);
  }

  /**
   * Delivers a value that a surface sent for a watched status (docs/spec/exposure.md#relay) to every watch of that surface and name
   * whose last version is older. The host may reorder the calls that carry the values, so an older version is not delivered after a
   * newer one, and a value can arrive after its watch ended; the trace records each value that no watch takes, with its reason.
   */
  function deliver({ surface, name, value, version }) {
    let watched = false;
    let delivered = false;
    let newest = 0;
    for (const watch of following.values()) {
      if (watch.surface !== surface || watch.name !== name) continue;
      watched = true;
      if (version <= watch.version) {
        newest = Math.max(newest, watch.version);
        continue;
      }
      delivered = true;
      watch.version = version;
      if (watch.external) changed(name, value, watch.requested);
      for (const listener of watch.local) listener(value, watch.surface);
    }
    if (!watched) trace("surface.change.dropped", { surface, name, version, reason: "no watch" });
    else if (!delivered) trace("surface.change.dropped", { surface, name, version, reason: `older than version ${newest}` });
  }

  // The refresh of the core watches of a surface: the change of the stored workspace re-reads each open one, because a role
  // change of any window notifies it. The subscription exists while a core watch is open.
  let stopCoreRefresh = null;
  const startCoreRefresh = () => {
    if (stopCoreRefresh !== null) return;
    // default: a document that passes no stored-change source holds no core watch to refresh.
    const stop = options.onStoredChange?.(async () => {
      for (const watch of [...following.values()]) {
        if (!watch.core) continue;
        try {
          const value = await core.answer("status.get", { name: watch.name, surface: watch.surface });
          deliver({ surface: watch.surface, name: watch.name, value, version: watch.version + 1 });
        } catch (error) {
          report(error);
        }
      }
    });
    if (stop) stopCoreRefresh = stop;
  };

  /** Ends the watch of the surface when no other watch follows the same surface. origin is that of forward. */
  async function release(watch, name, origin) {
    const shared = [...following.values()].some((other) => other.surface === watch.surface && other.name === name);
    if (!shared) await forward(watch.surface, "status.unwatch", { name }, origin);
  }

  // What observes each command request from its start to its answer (watch), or null.
  let watcher = null;
  // The command requests that started and have not written their event, and what waits until there are none (commandsEnded).
  let commanding = 0;
  const commandWaits = [];

  // Every command request is the event `workbench.command` (docs/spec/logging.md#entrances), whether or not the
  // trace is on. The watcher receives the name and the parameters when the command starts and the answer when it succeeded, before
  // that event, for a command that answers at once and for one that answers later.
  async function recorded(name, params, run) {
    const started = performance.now();
    const micros = () => Math.round((performance.now() - started) * 1000);
    const ended = watcher ? watcher(name, params) : null;
    commanding++;
    try {
      const result = await run();
      // default: a command that no watcher follows has no end callback.
      ended?.(result);
      emitEvent("debug", "workbench.command", { name, micros: micros(), ok: true });
      return result;
    } catch (error) {
      // The code is the one that the endpoint answers for the failure (replyPayload of the plugin API).
      emitEvent("warn", "workbench.command", { name, micros: micros(), ok: false,
        // default: a thrown value that is not an Error is recorded as its own text.
        error: `${error instanceof ExposureError ? error.code : EXPOSURE_ERRORS.failed}: ${errorText(error)}` });
      throw error;
    } finally {
      commanding--;
      if (commanding === 0) for (const resolve of commandWaits.splice(0)) resolve();
    }
  }

  /** Answers one request. origin is the id of the exposure-request that it answers, or undefined for a request of this document. */
  function answer(method, params, origin) {
    return method === "command.run" && typeof params?.name === "string"
      // default: a request without parameters runs the command with none, as dispatch gives it.
      ? recorded(params.name, params.params ?? {}, () => timed(params.name, () => dispatch(method, params, origin))) : dispatch(method, params, origin);
  }

  async function dispatch(method, params, origin) {
    // default: a request without parameters omits params.
    const given = params ?? {};
    if (methods.has(method)) return methods.get(method)(given);
    if (method === "exposure.list") return list();
    if (method === "exposure.snapshot") return snapshot(given, origin);
    const name = params?.name;
    const kind = METHOD_KINDS[method];
    const found = kind && typeof name === "string" ? declared.get(declarationKey(kind, name)) : undefined;
    // A core status that a request names a surface for is a watch of that surface: the value is read from the core entry with
    // the surface, and the change of the stored workspace refreshes each open watch (docs/spec/exposure.md, the surface member
    // of a request), so a status of a tab holds the state of that tab alone.
    if (found && !surfaceName(name) && kind === "status" && params.surface !== undefined && (method === "status.watch" || method === "status.unwatch")) {
      const key = watchKey(name, params.surface);
      if (method === "status.unwatch") {
        const watch = following.get(key);
        if (watch?.core) {
          if (watch.local.size) watch.external = false;
          else following.delete(key);
        }
        return null;
      }
      if (!following.has(key)) {
        following.set(key, { surface: params.surface, requested: params.surface, name, version: 0, external: true, local: new Set(), core: true });
        startCoreRefresh();
      }
      following.get(key).external = true;
      const first = await core.answer("status.get", { name, surface: params.surface });
      deliver({ surface: params.surface, name, value: first, version: following.get(key).version + 1 });
      return null;
    }
    // For a name that a state module registered, this document answers a request that names no surface (docs/spec/exposure.md#choosing-a-surface).
    const page = found && params.surface === undefined ? pageOf(kind, name) : null;
    // The entries of this document send a watched value as (name, value, version); the host takes the value of a watch that names
    // no surface.
    const local = (entryName, value) => changed(entryName, value);
    if (page) {
      // A handler of a state module has no time limit: its reply or its error ends the command (docs/spec/exposure.md, command timeout).
      return page.entries.answer(method, params, local);
    }
    if (!found || !surfaceName(name)) return core.answer(method, params, local);
    const requested = params.surface;
    const key = watchKey(name, requested);
    if (method === "status.unwatch") {
      const watch = following.get(key);
      if (watch?.local.size) {
        watch.external = false;
        return null;
      }
      following.delete(key);
      if (watch) await release(watch, name, origin);
      return null;
    }
    if (method === "status.watch" && following.has(key)) {
      following.get(key).external = true;
      return null;
    }
    const surface = pick(kind, name, requested);
    if (method === "element.act" && options.elementInert(null)) throw inertRefusal(name);
    if (method !== "status.watch") return forward(surface, method, params, origin);
    // The watch exists before the surface answers, because the surface sends the current value as it starts the watch. Each watch
    // receives from version 0, so a watch of a name that the surface already follows receives the current value again.
    const watch = { surface, requested, name, version: 0, external: true, local: new Set() };
    following.set(key, watch);
    try {
      return await forward(surface, method, { name }, origin);
    } catch (error) {
      if (following.get(key) === watch) following.delete(key);
      throw error;
    }
  }

  /**
   * The part of the main page in a window snapshot (docs/spec/exposure.md#window-snapshot): the layout and the plugins of the window, the
   * group of the main document, one group per surface in the order of core.surfaces and the declared entries that no owner registered;
   * the host adds the window and its own group. The main document is read in the turn of the request, then each surface document that
   * registered entries is asked in turn. With surface, the groups hold only the group of that surface.
   */
  async function snapshot({ surface: only }, origin) {
    if (only !== undefined && typeof only !== "string") throw new ExposureError(EXPOSURE_ERRORS.invalidParams, "surface must be a string");
    const { layout, plugins, surfaces: listed } = options.snapshotParts();
    const chosen = only === undefined ? listed : listed.filter(({ surface }) => surface === only);
    if (only !== undefined && chosen.length === 0) throw new ExposureError(EXPOSURE_ERRORS.invalidParams, `surface ${only} is not a surface of this window`);
    const unregistered = only === undefined ? unregisteredEntries() : [];
    const own = only === undefined
      ? Promise.all([core.snapshot({ withInert: true }), ...[...pages.values()].map((page) => page.entries.snapshot({ withInert: true }))])
      : null;
    const groups = [];
    if (own) {
      const parts = await own;
      groups.push({ owner: "core", status: parts.flatMap((part) => part.status), commands: parts.flatMap((part) => part.commands),
        element: parts.flatMap((part) => part.element) });
    }
    for (const { surface, plugin, kind, state, visible } of chosen) {
      const group = { owner: "surface", surface, plugin, kind, state, visible };
      // An unloaded surface has no document, and a surface that registered nothing has no entries to read.
      if (state === "unloaded" || surfaceNames(surface).length === 0) {
        groups.push({ ...group, status: [], commands: [], element: [] });
        continue;
      }
      let part;
      try {
        part = await forward(surface, "exposure.snapshot", {}, origin);
      } catch (error) {
        if (error.code !== EXPOSURE_ERRORS.gone) throw error;
        // The document of the surface ended before it answered.
        groups.push({ ...group, error: EXPOSURE_ERRORS.gone, status: [], commands: [], element: [] });
        continue;
      }
      groups.push({ ...group, ...placedPart(surface, part) });
    }
    return { layout, plugins, groups, unregistered };
  }

  /**
   * The group of a surface document with the rectangles of its items in window coordinates and inert: a view answers in its own document
   * coordinates, so the applied frame of the view is added, as for element.rect; only this document knows the open dialog.
   */
  function placedPart(surface, { status, commands, element }) {
    let frame = { x: 0, y: 0 };
    if (viewSurfaces.has(surface)) {
      frame = options.surfaceFrame(surface);
      if (!frame || ![frame.x, frame.y].every(Number.isFinite)) {
        throw new ExposureError(EXPOSURE_ERRORS.failed, `surface ${surface} has no valid applied frame`);
      }
    }
    const inert = options.elementInert(null);
    return {
      status, commands,
      element: element.map((entry) => ({ ...entry, items: entry.items.map(({ rect, command, params, ...item }) => ({
        ...item, rect: { ...rect, x: rect.x + frame.x, y: rect.y + frame.y }, inert, command, params,
      })) })),
    };
  }

  /** The declared entries of this window that no owner registered, {kind, name}, in the order of exposure.list. */
  function unregisteredEntries() {
    const listed = list();
    return [["status", "status"], ["commands", "command"], ["element", "element"]]
      .flatMap(([key, kind]) => listed[key].filter((entry) => !entry.registered).map(({ name }) => ({ kind, name })));
  }

  /** List in the declaration format. registered is added to each entry. */
  function list() {
    const out = { status: [], commands: [], element: [] };
    const keyOf = Object.fromEntries(Object.entries(EXPOSE_KINDS).map(([key, kind]) => [kind, key]));
    for (const [key, { kind, declaration }] of declared) {
      out[keyOf[kind]].push({
        ...declaration,
        registered: surfaceName(declaration.name)
          // default: when no surface registered the name, the number of registered surfaces is 0.
          ? (surfaces.get(key)?.size ?? 0) > 0 || Boolean(pageOf(kind, declaration.name))
          : core.registered(kind, declaration.name),
      });
    }
    return out;
  }

  /** The surface that a request of this document uses among the surfaces that registered the name: wanted when it registered, otherwise null. */
  function target(kind, name, wanted, exact = false) {
    if (pageOf(kind, name)) return null;
    const owners = surfaces.get(declarationKey(kind, name));
    if (!owners?.size) return null;
    // A surface that a drawing or a place left out keeps its registrations until its view end is processed, but the host has closed or
    // will close its view, so no request of this document goes to it (docs/spec/plugins.md#sections).
    if (wanted && owners.has(wanted)) return options.leftOut(wanted) ? null : wanted;
    if (exact) return null;
    const choices = tabSurfacesOf(owners).filter((surface) => !options.leftOut(surface));
    // default: when the preferred surface has not registered, the surface registered last answers.
    return options.preferred().find((surface) => choices.includes(surface)) ?? choices.at(-1) ?? null;
  }

  /** Reports the failure of an observation with the name and the surface attached. */
  // A surface that ended while its watch was requested ends the watch and is no failure of the observation: the registration of the
  // surface decides the observer again.
  const observeFailed = (name, surface) => (error) => {
    if (error.code === EXPOSURE_ERRORS.gone) return;
    options.failed(new Error(`${name} on ${surface}: ${error.message}`));
  };

  /** Ends the watch of an observer. When no other observer or external watch remains, the watch of the surface ends too. */
  function detach(observer) {
    if (observer.stopPage) {
      const stop = observer.stopPage;
      observer.stopPage = null;
      observer.pageEntry = null;
      stop();
    }
    const { watch } = observer;
    observer.watch = null;
    if (!watch) return;
    watch.local.delete(observer.listener);
    if (watch.local.size || watch.external) return;
    const key = watchKey(observer.name, watch.surface);
    if (following.get(key) !== watch) return;
    following.delete(key);
    tracked(release(watch, observer.name).catch(observeFailed(observer.name, watch.surface)));
  }

  /** Decides again which surface an observer follows. When the surface changes, the watch moves. */
  function reattach(observer) {
    const pageEntry = pageOf("status", observer.name)?.statuses.get(observer.name);
    if (pageEntry) {
      if (observer.pageEntry === pageEntry) return;
      detach(observer);
      observer.surface = "state";
      observer.pageEntry = pageEntry;
      observer.stopPage = pageEntry.subscribe((value) => observer.fn(value, "state"));
      tracked(Promise.resolve().then(() => pageEntry.read()).then((value) => {
        if (observer.pageEntry === pageEntry) observer.fn(value, "state");
      }, observeFailed(observer.name, "state")));
      return;
    }
    const surface = target("status", observer.name, observer.wanted, observer.exact);
    const live = observer.watch && following.get(watchKey(observer.name, surface)) === observer.watch;
    if (observer.surface === surface && (surface === null || live)) return;
    detach(observer);
    observer.surface = surface;
    if (surface === null) {
      observer.fn(null, null);
      return;
    }
    const { name } = observer;
    const key = watchKey(name, surface);
    let watch = following.get(key);
    if (watch) {
      watch.local.add(observer.listener);
      observer.watch = watch;
      tracked(forward(surface, "status.get", { name }).then((value) => {
        if (observer.watch === watch) observer.fn(value, surface);
      }, observeFailed(name, surface)));
      return;
    }
    watch = { surface, requested: surface, name, version: 0, external: false, local: new Set([observer.listener]) };
    following.set(key, watch);
    observer.watch = watch;
    tracked(forward(surface, "status.watch", { name }).catch((error) => {
      if (following.get(key) === watch) following.delete(key);
      observeFailed(name, surface)(error);
    }));
  }

  const registrationChanged = () => {
    for (const observer of observers) reattach(observer);
    options.registrationChanged();
    for (const listener of registrationListeners) listener();
  };

  return {
    configure(values) {
      options = { ...options, ...values };
    },

    /** Calls listener after an exposure entry registration changes, and returns its unsubscribe function. */
    onRegistrationChange(listener) {
      if (typeof listener !== "function") throw new TypeError("registration change listener must be a function");
      registrationListeners.add(listener);
      return () => registrationListeners.delete(listener);
    },

    /** Adds declarations. owner is core or a plugin id. */
    declare(owner, exposes) {
      validateExposes(owner, exposes);
      const own = declarationMap(exposes);
      for (const [key, { declaration }] of own) {
        if (declared.has(key)) throw new Error(`${key} is declared twice`);
        if (ownerOf(declaration.name) !== owner) throw new Error(`${key} does not belong to ${owner}`);
      }
      for (const [key, entry] of own) {
        declared.set(key, entry);
        if (owner === "core") coreDeclared.set(key, entry);
      }
    },

    /** Registers a core status. subscribe(fn) returns a function that unsubscribes. */
    status: (name, read, subscribe) => core.status(name, read, subscribe),
    // The handler receives the context of the request, {cids} with the correlation identifiers of its cause when the request has them
    // and {surface} with the surface of the caller when the request names one (a view that runs a core command, docs/spec/exposure.md).
    command: (name, run) => core.command(name, async (params, context) => {
      // A core command has no time limit: its handler's reply or error ends it, and its layout presentation follows by its own events.
      const result = await run(params, context);
      try {
        await options.settled();
      } catch (error) {
        if (!options.failed(error)) throw error;
      }
      return result;
    }),
    /** Registers a core element entry. The elements are found by the data-expose attribute when requested. resolve answers an address (plugin-api element). */
    element: (name, provide = byAttribute(name), resolve = undefined) => core.element(name, provide, resolve),

    /**
     * Runs one core command of this document. It is validated by the params schema of the declaration. The UI of the document performs operations through this path, so a human operation and an external request go through the same command. cids are the correlation identifiers of the operation that causes the run; a command of a view receives them (docs/spec/native-surfaces.md#view-surfaces).
     */
    run: (name, params = {}, surface, cids) => answer("command.run", commandRequest(name, params, surface, cids)),

    /**
     * Installs what observes each command request of this document and of the host: watch(name, params) is called when the command
     * starts and returns null or a function that receives the answer of the command when it succeeded.
     */
    /** Resolves when every command request that started has ended and written its event, at once when none runs. */
    commandsEnded: () => (commanding === 0 ? Promise.resolve() : new Promise((resolve) => commandWaits.push(resolve))),

    watch: (watch) => {
      if (typeof watch !== "function") throw new TypeError("watch requires a function");
      watcher = watch;
    },

    /**
     * Returns the surface that a request of this document uses for the entry (see target): wanted when it registered the name, otherwise the preferred surface, or null when no surface registered. With exact, only wanted is accepted.
     */
    chosen: (kind, name, wanted, exact = false) => target(kind, name, wanted, exact),

    /**
     * Runs a command that a surface of plugin owner registered: on surface when the caller names it, otherwise on caller, the surface
     * of the calling view, when it registered the command, otherwise on the preferred tab surface of the owner
     * (docs/spec/native-surfaces.md#view-surfaces, view calls).
     */
    runOwned(name, params, owner, cids, surface, caller) {
      if (pageOf("command", name)) return answer("command.run", commandRequest(name, params, undefined, cids));
      const owners = surfaces.get(declarationKey("command", name));
      if (surface !== undefined) {
        if (!owners?.has(surface) || options.surfacePlugin(surface) !== owner) {
          return Promise.reject(new ExposureError(EXPOSURE_ERRORS.unregistered, `surface ${surface} has not registered command ${name}`));
        }
        return answer("command.run", commandRequest(name, params, surface, cids));
      }
      // A view runs the commands that it registered itself; a section surface is chosen only this way, as the caller.
      if (caller !== undefined && owners?.has(caller) && options.surfacePlugin(caller) === owner && !options.leftOut(caller)) {
        return answer("command.run", commandRequest(name, params, caller, cids));
      }
      const choices = tabSurfacesOf(owners).filter((candidate) => options.surfacePlugin(candidate) === owner);
      // default: when the preferred surface has not registered, the surface registered last answers.
      const chosen = options.preferred().find((candidate) => choices.includes(candidate)) ?? choices.at(-1);
      // default: the error sentence writes a missing owner (null) as none.
      if (chosen === undefined) return Promise.reject(new ExposureError(EXPOSURE_ERRORS.unregistered, `owner ${owner ?? "none"} has not registered command ${name}`));
      return answer("command.run", commandRequest(name, params, chosen, cids));
    },

    /**
     * Creates the table into which the state module of plugin owner registers entries in this document. There is one per plugin, and clear() removes all entries (docs/spec/exposure.md#registration).
     */
    plugin(owner) {
      if (pages.has(owner)) throw new Error(`plugin ${owner} state is already registered`);
      const page = { entries: exposureEntries(declared, { inert: (element) => options.elementInert(element) }), statuses: new Map() };
      pages.set(owner, page);
      const own = (name) => {
        if (ownerOf(name) !== owner) throw new Error(`${name} does not belong to ${owner}`);
      };
      return {
        status(name, read, subscribe) {
          own(name);
          page.entries.status(name, read, subscribe);
          page.statuses.set(name, { read, subscribe });
          registrationChanged();
        },
        command(name, run) {
          own(name);
          page.entries.command(name, run);
          registrationChanged();
        },
        clear() {
          if (pages.get(owner) !== page) return;
          page.entries.clear();
          pages.delete(owner);
          registrationChanged();
        },
      };
    },

    /**
     * Follows a status: fn(value, from) receives its value and each change, and the function returns an unsubscribe function. A
     * status that the core table of this document registers is followed there when no surface is wanted, because no surface
     * registers it; from is then "core".
     */
    observe(name, surface, fn, { exact = false } = {}) {
      if (surface == null && core.registered("status", name)) return core.follow(name, (value) => fn(value, "core"));
      // default: an observation that names no surface has null as the wanted surface.
      const observer = { name, wanted: surface ?? null, exact, fn, surface: undefined, watch: null, listener: null,
        pageEntry: null, stopPage: null };
      observer.listener = (value, from) => fn(value, from);
      observers.add(observer);
      reattach(observer);
      return () => {
        observers.delete(observer);
        detach(observer);
      };
    },

    /**
     * Resolves when no observation chain is in progress: the watch, the value read or the release that an observer started has
     * ended, after the observer received its value. It resolves at once when no chain is in progress.
     */
    idle: () => (running === 0 ? Promise.resolve() : new Promise((resolve) => idleWaits.push(resolve))),

    /** Whether the name is declared. */
    declared: (kind, name) => declared.has(declarationKey(kind, name)),

    /**
     * Whether surface is a surface of plugin in this window, by the plugin that the workbench reports for the surface
     * (docs/spec/native-surfaces.md#view-surfaces).
     */
    holdsSurface: (plugin, surface) => options.surfacePlugin(surface) === plugin,

    /** The applied frame {x, y, w, h} of surface in the window, or null when the composition has applied none. */
    surfaceFrame: (surface) => options.surfaceFrame(surface),

    /** Registers a method that handles a request by its name: workbench.placement.last and the diagnostic methods. */
    method(name, fn) {
      if (methods.has(name)) throw new Error(`method ${name} is already registered`);
      methods.set(name, fn);
    },

    /**
     * Applies the registration or the removal of a surface. A registration that does not match the declaration is not applied, and an exception is thrown.
     */
    registered({ surface, kind, name, closed }) {
      if (closed) {
        registrationTrace("closed", surface);
        pending.delete(surface);
        for (const owners of surfaces.values()) owners.delete(surface);
        for (const [watched, watch] of following) if (watch.surface === surface) following.delete(watched);
        registrationChanged();
        return;
      }
      const key = declarationKey(kind, name);
      if (!declared.has(key) || !surfaceName(name)) {
        throw new Error(`surface ${surface} registered undeclared ${kind} ${name}`);
      }
      const plugin = options.surfacePlugin(surface);
      if (plugin === null) {
        // When the main page is read again, the host sends the registrations again before it loads the layout.
        if (!pending.has(surface)) pending.set(surface, []);
        pending.get(surface).push({ kind, name });
        registrationTrace("pending", surface, { kind, name });
        return;
      }
      if (ownerOf(name) !== "core" && plugin !== ownerOf(name)) {
        throw new Error(`surface ${surface} of plugin ${plugin} cannot register ${name}`);
      }
      if (!surfaces.has(key)) surfaces.set(key, new Map());
      const owners = surfaces.get(key);
      owners.delete(surface);
      owners.set(surface, kind);
      registrationTrace("registered", surface, { kind, name });
      registrationChanged();
    },

    /**
     * Applies the pending registrations of surfaces whose owner plugin became known. Registrations that do not match the declaration or the plugin are not applied; they are collected and thrown as one exception.
     */
    revisit() {
      const errors = [];
      for (const [surface, list] of [...pending]) {
        if (options.surfacePlugin(surface) === null) continue;
        pending.delete(surface);
        for (const entry of list) {
          try {
            this.registered({ surface, ...entry });
          } catch (error) {
            errors.push(error.message);
          }
        }
      }
      if (errors.length) throw new Error(errors.join("; "));
    },

    /** Ids of the surfaces that registered this entry, in registration order. */
    // default: an entry that no surface registered has no registrants.
    registrants: (kind, name) => [...(surfaces.get(declarationKey(kind, name))?.keys() ?? [])],

    /** Delivers a value that a surface sent for a watched status: {surface, name, value, version} (docs/spec/exposure.md#relay). */
    changed: deliver,

    /** Removes all registrations, pending registrations and watches when a surface is closed. */
    unregisterSurface(surface) {
      registrationTrace("disposed", surface);
      for (const [key, owners] of surfaces) {
        if (!owners.delete(surface)) continue;
        if (owners.size === 0) surfaces.delete(key);
      }
      pending.delete(surface);
      for (const [key, watch] of following) {
        if (watch.surface === surface) following.delete(key);
      }
      registrationChanged();
    },

    /** Entries that a surface registered, in the form `<kind> <name>`. */
    namesOf: surfaceNames,

    /** Answers one request. The result is {result} or {error: {code, message}}. */
    handle: ({ id, method, params }) => replyPayload(async () => {
      // Records the time of every core and plugin command in the performance trace (V5-104).
      const result = await answer(method, params, id);
      // The core and the mounted plugins share the application document. An origin that a separate document specified is kept.
      if (method === "element.rect" && result && result.document === undefined) return { ...result, document: { x: 0, y: 0 } };
      return result;
    }),

    list,
    surfaceDeclarations() {
      const listed = list();
      const onlySurface = (entry) => surfaceDocumentEntry(entry.name);
      return {
        status: listed.status.filter(onlySurface),
        commands: listed.commands.filter(onlySurface),
        element: listed.element.filter(onlySurface),
      };
    },
  };
}

/** The registry of this document. A refused state change is reported to the application log and applicationError by the unhandled rejection handler of the page. */
export const registry = createRegistry(host
  ? { call: (name, arg) => host.call(name, arg), report: (error) => Promise.reject(error) }
  : {});

/* The function that sends the exposure reply of a surface. Only the diagnostic module of a diagnostic build installs it, to intercept the reply of the surface. */
let replyGate = null;
let replyHoldsEnd = null;

/**
 * Sends the exposure reply of a surface through fn(surface, send). send() sends the reply to the host and returns the response, and fn
 * returns that result. endHolds() ends every hold of fn, so the replies it holds are sent; whenRepliesSent calls it, because a reload of
 * the page ends the holds of the page (docs/spec/endpoint.md, diagnostics.surface.hold). null removes the installed functions.
 */
export function gateSurfaceReplies(fn, endHolds = null) {
  replyGate = fn;
  replyHoldsEnd = fn === null ? null : endHolds;
}

/** Sends one exposure reply of surface through the installed gate. A reply without a surface is the reply of the main page and is sent at once. */
export function gatedExposureReply(surface, send) {
  return replyGate === null || surface === undefined ? send() : replyGate(surface, send);
}

export function registerSurfacePort(surface, port) {
  if (surfacePorts.has(surface)) throw new Error(`surface ${surface} already has an exposure port`);
  surfacePorts.set(surface, port);
  return () => { if (surfacePorts.get(surface) === port) surfacePorts.delete(surface); };
}

// The exposure requests that the page has received and not yet answered. A page reload waits until none remain, because
// a reply that the reload stops is lost (whenRepliesSent).
let unanswered = 0;
let answeredWaiters = [];

function requestAnswered() {
  unanswered--;
  if (unanswered > 0) return;
  const waiters = answeredWaiters;
  answeredWaiters = [];
  for (const resolve of waiters) resolve();
}

/** Resolves when the page has sent the reply of every exposure request that it has received. A reply that a diagnostic hold keeps is sent first. */
export function whenRepliesSent() {
  // default: a page that keeps no diagnostic reply hold has no hold to end.
  replyHoldsEnd?.();
  return unanswered === 0 ? Promise.resolve() : new Promise((resolve) => answeredWaiters.push(resolve));
}

/**
 * Marks a surface as a view for the lifetime of its mount. pageAnswers(request) tells a request that the page answers for the view:
 * the run of a command that the view registered with runtime.command.register, whose forwarding handler is on the surface port. The
 * returned function ends the mark.
 */
export function markViewSurface(surface, pageAnswers = () => false) {
  if (typeof pageAnswers !== "function") throw new TypeError("markViewSurface requires pageAnswers(request)");
  const mark = (request) => pageAnswers(request);
  if (!viewSurfaces.has(surface)) viewSurfaces.set(surface, new Set());
  viewSurfaces.get(surface).add(mark);
  return () => {
    const marks = viewSurfaces.get(surface);
    if (marks === undefined) return;
    marks.delete(mark);
    if (marks.size === 0) viewSurfaces.delete(surface);
  };
}

export async function dispatchSurfaceRequest(request) {
  // A view answers its own request through its subscription, so the request is consumed here and is not forwarded to the view again;
  // a request that the page answers for the view runs on the surface port.
  const marks = viewSurfaces.get(request.surface);
  if (marks !== undefined && ![...marks].some((pageAnswers) => pageAnswers(request))) return true;
  const port = surfacePorts.get(request.surface);
  if (!port) return false;
  await port(request);
  return true;
}

/** Applies the pending surface registrations. A registration that does not match the declaration leaves an error line through report(line). */
export function revisitRegistrations(report) {
  if (typeof report !== "function") throw new TypeError("revisitRegistrations requires report(line)");
  try {
    registry.revisit();
  } catch (error) {
    report(`exposure: ${error.message}`);
  }
}

/** Validates the content of the core declaration file (exposure.json) and adds it to the registry. The page imports it as a JSON module before the first screen. */
export function installExposure(document) {
  registry.declare("core", validateExposureFile(document).exposes);
}

/**
 * Connects the registry to the host. Without a host, it receives only the values that the document knows.
 *
 * When a registration does not match the declaration, values.report(line) leaves an error line. The host has already received the call of the surface, so there is no path that returns the failure to that surface.
 */
export async function connectExposure({ report, ...values }) {
  if (typeof report !== "function") throw new TypeError("connectExposure requires report(line)");
  registry.configure({
    ...values,
    // default: when the caller gives no failure hook, the workbench handles the report.
    failed: values.failed ?? ((error) => {
      if (!host) return false;
      // default: a rejection that is not an Error carries its value as the diagnostic reason.
      report(`exposure settled failed: ${errorText(error)}`);
      return true;
    }),
  });
  if (!host) return;
  await host.on("exposure-request", (request) => {
    unanswered++;
    dispatchSurfaceRequest(request).then((handled) => {
      if (handled) return;
      return registry.handle(request)
        .then((payload) => gatedExposureReply(request.surface, () => host.call("exposureReply", { id: request.id, ...payload })))
        // default: a request whose answer fails, or whose reply the host refuses, is reported with its text, as the other failures of the page are.
        .catch((error) => report(`exposure reply: ${errorText(error)}`));
    }).finally(requestAnswered);
  });
  await host.on("exposure-registered", (event) => {
    try {
      registry.registered(event);
    } catch (error) {
      report(`exposure: ${error.message}`);
    }
  });
}
