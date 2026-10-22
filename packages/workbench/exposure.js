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
import { errorText, forwardHostExposure, hostKeyOf, hostCommandsOf, listenPluginHostCalls, pluginSidecarsOf } from "./plugin-host.js";
import { SNAPSHOT_REQUEST_COMMAND, createPluginRuntime } from "@soksak/plugin-api";
import { pluginRecords } from "./plugin-records.js";
import { timed, trace } from "./performance.js";
import { emitEvent } from "./page-log.js";
import {
  EXPOSE_KINDS, EXPOSURE_ERRORS, ExposureError, METHOD_KINDS, SURFACE_CORE, declarationKey, declarationMap,
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

/** Elements of a core dom entry. They are found in the main document by the data-expose attribute. */
const byAttribute = (name) => () => [...document.querySelectorAll(`[data-expose="${name}"]`)];

const ownerOf = (name) => name.slice(0, name.indexOf("."));

/** Whether the name is registered by a surface document: a plugin name or core.surface.*. */
const surfaceName = (name) => ownerOf(name) !== "core" || name.startsWith(SURFACE_CORE);

/** The key of one watch. A watch that names a surface and a watch that does not are different. */
// default: as stated above, the surface of a watch that names no surface is null.
const watchKey = (name, surface) => JSON.stringify([name, surface ?? null]);

// Holds the request receivers of the surface modules mounted in this document.
const surfacePorts = new Map();

// The surfaces whose page is a view. A view answers the forwarded requests of its own names through its exposure-request subscription
// (docs/spec/native-surfaces.md#view-surfaces), so a request of a view surface reaches the port of the page only when it names a core
// surface entry, which the page registers for every surface (docs/spec/exposure.md#surface-documents).
const viewSurfaces = new Set();

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
/** Time (ms) to wait for a reply when a command that this document answers declares no timeout. */
const REPLY_TIMEOUT = 10_000;

export function createRegistry({ call = null, report = null } = {}) {
  if (call && typeof report !== "function") throw new TypeError("a registry with a host call needs report(error)");
  const declared = new Map();
  const coreDeclared = new Map();
  const core = exposureEntries(coreDeclared);
  const methods = new Map();
  /* For each declaration key, the surfaces that registered the entry. Registration order is kept. */
  const surfaces = new Map();
  // The plugin of the plugin host that registered each entry, by declaration key; its owner key is plugin:<plugin id>
  // (docs/spec/plugin-host.md#exposure). A host registration is kept apart from the surfaces, so a request that names a
  // surface and a watch of a surface never reach a plugin host.
  const hosts = new Map();
  const surfaceNames = (surface) => [...surfaces].filter(([, owners]) => owners.has(surface)).map(([key]) => key);
  const registrationTrace = (phase, surface, fields = {}) => trace("surface.registration", {
    phase, surface, timeOrigin: performance.timeOrigin, hasPort: surfacePorts.has(surface), ...fields,
    get names() { return surfaceNames(surface); },
  });
  /* Registrations of surfaces whose owner plugin is not known yet. revisit applies them when the layout that holds the surface is loaded. */
  const pending = new Map();
  /* Surface statuses being watched: for each watch key, the followed surface, the requested surface and the last version. */
  const following = new Map();
  let options = {
    surfacePlugin: () => null, preferred: () => [], registrationChanged: () => {}, unloaded: () => false,
    // Work to wait for after a core command ran. The document passes the drawing of the plane, so a command that changed the layout replies after it is drawn.
    settled: () => undefined,
    // Called when an observation inside this document fails. It is reported as a page error (docs/spec/plugins.md#sections).
    failed: (error) => dispatchEvent(new ErrorEvent("error", { message: error.message })),
  };
  let forwards = 0;
  /* Observers that follow a surface status inside this document. Section modules use them. */
  const observers = new Set();
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
   * Sends a request to the plugin host of plugin through its channel (docs/spec/plugin-host.md#exposure). A command runs
   * within its declared time limit, a status get pulls the current value of the status once, and every other request is
   * refused, because the host page pushes its statuses as declared UI snapshots.
   */
  async function forwardHost(plugin, method, params) {
    const commands = hostCommandsOf(plugin);
    if (commands === null) throw new ExposureError(EXPOSURE_ERRORS.unregistered, `plugin host ${plugin} has no channel`);
    try {
      if (method.startsWith("dom.")) {
        // The dom request reaches the host page as exposure-request, which answers it (docs/spec/plugin-host.md#channel).
        const reply = await forwardHostExposure(plugin, method, params);
        if (reply.error !== undefined) throw new ExposureError(reply.error.code, reply.error.message);
        return reply.result;
      }
      // default: a command request without params runs the command with null, the value of no params.
      if (method === "command.run") return await commands.run(params.name, params.params ?? null);
      if (method === "status.get") {
        const reply = await commands.run(SNAPSHOT_REQUEST_COMMAND, { status: params.name });
        // The snapshot reply is {seq, value} (docs/spec/plugin-host.md#declared-ui-snapshots); any other reply is refused.
        if (typeof reply !== "object" || reply === null || !Number.isInteger(reply.seq) || reply.seq < 0 || !("value" in reply)) {
          throw new ExposureError(EXPOSURE_ERRORS.failed, `plugin host ${plugin} answered status ${params.name} without {seq, value}`);
        }
        return { value: reply.value, version: reply.seq };
      }
    } catch (error) {
      if (error instanceof ExposureError) throw error;
      // default: a rejection that is not an Error carries its value as the reason.
      throw new ExposureError(EXPOSURE_ERRORS.failed, errorText(error));
    }
    throw new ExposureError(EXPOSURE_ERRORS.invalidParams, `plugin host ${plugin} does not serve ${method}`);
  }

  /**
   * Forwards a request to a surface. When the command declaration has a timeout, the host waits for that time.
   */
  async function forward(surface, method, params) {
    if (!call) throw new ExposureError(EXPOSURE_ERRORS.gone, `surface ${surface} has no host`);
    const request = { id: ++forwards, surface, method, params };
    const timeout = method === "command.run"
      ? declared.get(declarationKey("command", params?.name))?.declaration.timeout : undefined;
    if (timeout !== undefined) request.timeout = timeout;
    const reply = await call("exposureForward", request);
    if (reply.error) throw new ExposureError(reply.error.code, reply.error.message);
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
    if (!owners?.size) throw new ExposureError(EXPOSURE_ERRORS.unregistered, `${kind} ${name} is not registered`);
    const first = options.preferred().find((surface) => owners.has(surface));
    // default: when the preferred surface has not registered, the surface registered last answers.
    return first ?? [...owners.keys()].at(-1);
  }

  /**
   * Follows the changes of a surface status. It repeats status.next and calls exposureChanged on every
   * answer. The host puts no wait time on status.next.
   * It stops when the watch ends or the forwarding fails (for example when the surface disappeared).
   */
  async function follow(key, name, watch) {
    while (following.get(key) === watch) {
      let answer;
      try {
        answer = await forward(watch.surface, "status.next", { name, version: watch.version });
      } catch (error) {
        // The host fails a pending status.next with 1003 when its surface closes; that ends the watch as stated.
        // Any other failure is reported and also ends the watch, so it is not retried silently.
        if (error?.code === EXPOSURE_ERRORS.gone) {
          trace("surface.watch", { phase: "ended", reason: "surface closed", name, surface: watch.surface });
        } else {
          // default: a failure that is not an Error carries its value as the text.
          report(new Error(`status ${name} watch failed on surface ${watch.surface}: ${errorText(error)}`, { cause: error }));
        }
        break;
      }
      if (following.get(key) !== watch || answer?.closed) break;
      watch.version = answer.version;
      if (watch.external) changed(name, answer.value, watch.requested);
      for (const listener of watch.local) listener(answer.value, watch.surface);
    }
    if (following.get(key) === watch) following.delete(key);
  }

  /** Ends the watch of the surface when no other watch follows the same surface. */
  async function release(watch, name) {
    const shared = [...following.values()].some((other) => other.surface === watch.surface && other.name === name);
    if (!shared) await forward(watch.surface, "status.unwatch", { name });
  }

  /**
   * A command that this document runs fails when it does not finish within the timeout of its declaration (10 seconds when there is none). For a command forwarded to a surface, the host applies the same time. For a core command, this limit applies only to the execution of the handler. The placement display after it is bounded by each wait of the display path with its own limit, so this limit does not intercept that specific failure.
   */
  function bounded(name, entry, run) {
    // default: a command that declares no timeout finishes within 10 seconds (docs/spec/exposure.md).
    const limit = entry?.declaration.timeout ?? REPLY_TIMEOUT;
    let timer;
    const expired = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new ExposureError(EXPOSURE_ERRORS.failed, `command ${name} did not reply within ${limit}ms`)), limit);
    });
    // A synchronous exception of the handler must also become a rejection of this Promise so that the race ends and the timer is cleared. Otherwise the exception goes to the caller first, and the remaining timer makes a no-reply rejection after the limit that nobody receives.
    const running = new Promise((resolve) => { resolve(run()); });
    return Promise.race([running, expired]).finally(() => clearTimeout(timer));
  }

  // Every command request is the event `page.command` (docs/spec/logging.md#automatic-entrances), whether or not the
  // trace is on.
  async function recorded(name, run) {
    const started = performance.now();
    const micros = () => Math.round((performance.now() - started) * 1000);
    try {
      const result = await run();
      emitEvent("debug", "page.command", { name, micros: micros(), ok: true });
      return result;
    } catch (error) {
      // The code is the one that the endpoint answers for the failure (replyPayload of the plugin API).
      emitEvent("warn", "page.command", { name, micros: micros(), ok: false,
        // default: a thrown value that is not an Error is recorded as its own text.
        error: `${error instanceof ExposureError ? error.code : EXPOSURE_ERRORS.failed}: ${errorText(error)}` });
      throw error;
    }
  }

  function answer(method, params) {
    return method === "command.run" && typeof params?.name === "string"
      ? recorded(params.name, () => timed(params.name, () => dispatch(method, params))) : dispatch(method, params);
  }

  async function dispatch(method, params) {
    // default: a request without parameters omits params.
    if (methods.has(method)) return methods.get(method)(params ?? {});
    if (method === "exposure.list") return list();
    const name = params?.name;
    const kind = METHOD_KINDS[method];
    const found = kind && typeof name === "string" ? declared.get(declarationKey(kind, name)) : undefined;
    // For a name that a state module registered, this document answers a request that names no surface (docs/spec/exposure.md#choosing-a-surface).
    const page = found && params.surface === undefined ? pageOf(kind, name) : null;
    if (page) {
      const answering = () => page.entries.answer(method, params, changed);
      return method === "command.run" ? bounded(name, found, answering) : answering();
    }
    if (!found || !surfaceName(name)) return core.answer(method, params, changed);
    const requested = params.surface;
    // A request without surface for a name that no surface page registered is answered by the plugin host that registered
    // it (docs/spec/plugin-host.md#exposure).
    const hostPlugin = requested === undefined && !surfaces.get(declarationKey(kind, name))?.size
      ? hosts.get(declarationKey(kind, name)) : undefined;
    if (hostPlugin !== undefined) return forwardHost(hostPlugin, method, params);
    const key = watchKey(name, requested);
    if (method === "status.unwatch") {
      const watch = following.get(key);
      if (watch?.local.size) {
        watch.external = false;
        return null;
      }
      following.delete(key);
      if (watch) await release(watch, name);
      return null;
    }
    if (method === "status.watch" && following.has(key)) {
      following.get(key).external = true;
      return null;
    }
    const surface = pick(kind, name, requested);
    const result = await forward(surface, method, method === "status.watch" ? { name } : params);
    if (method === "status.watch") {
      // The document of a surface follows one value per name, so each watch receives from version 0.
      const watch = { surface, requested, name, version: 0, external: true, local: new Set() };
      following.set(key, watch);
      follow(key, name, watch);
    }
    return result;
  }

  /** List in the declaration format. registered is added to each entry. */
  function list() {
    const out = { status: [], commands: [], dom: [] };
    const keyOf = Object.fromEntries(Object.entries(EXPOSE_KINDS).map(([key, kind]) => [kind, key]));
    for (const [key, { kind, declaration }] of declared) {
      out[keyOf[kind]].push({
        ...declaration,
        registered: surfaceName(declaration.name)
          // default: when no surface registered the name, the number of registered surfaces is 0.
          ? (surfaces.get(key)?.size ?? 0) > 0 || hosts.has(key) || Boolean(pageOf(kind, declaration.name))
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
    if (wanted && owners.has(wanted)) return wanted;
    if (exact) return null;
    // default: when the preferred surface has not registered, the surface registered last answers.
    return options.preferred().find((surface) => owners.has(surface)) ?? [...owners.keys()].at(-1);
  }

  /** Reports the failure of an observation with the name and the surface attached. */
  const observeFailed = (name, surface) => (error) => options.failed(new Error(`${name} on ${surface}: ${error.message}`));

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
    release(watch, observer.name).catch(observeFailed(observer.name, watch.surface));
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
      Promise.resolve().then(() => pageEntry.read()).then((value) => {
        if (observer.pageEntry === pageEntry) observer.fn(value, "state");
      }, observeFailed(observer.name, "state"));
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
      forward(surface, "status.get", { name }).then((value) => {
        if (observer.watch === watch) observer.fn(value, surface);
      }, observeFailed(name, surface));
      return;
    }
    watch = { surface, requested: surface, name, version: 0, external: false, local: new Set([observer.listener]) };
    following.set(key, watch);
    observer.watch = watch;
    forward(surface, "status.watch", { name }).then(() => follow(key, name, watch), (error) => {
      if (following.get(key) === watch) following.delete(key);
      observeFailed(name, surface)(error);
    });
  }

  const registrationChanged = () => {
    for (const observer of observers) reattach(observer);
    options.registrationChanged();
  };

  return {
    configure(values) {
      options = { ...options, ...values };
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
    // The handler receives the context of the request, {cids} with the correlation identifiers of its cause when the request has them.
    command: (name, run) => core.command(name, async (params, context) => {
      const result = await bounded(name, coreDeclared.get(declarationKey("command", name)), () => run(params, context));
      try {
        await options.settled();
      } catch (error) {
        if (!options.failed(error)) throw error;
      }
      return result;
    }),
    /** Registers a core dom entry. The elements are found by the data-expose attribute when requested. resolve answers an address (plugin-api dom). */
    dom: (name, provide = byAttribute(name), resolve = undefined) => core.dom(name, provide, resolve),

    /**
     * Runs one core command of this document. It is validated by the params schema of the declaration. The UI of the document performs operations through this path, so a human operation and an external request go through the same command. cids are the correlation identifiers of the operation that causes the run; a command of a view receives them (docs/spec/native-surfaces.md#view-surfaces).
     */
    run: (name, params = {}, surface, cids) => answer("command.run", commandRequest(name, params, surface, cids)),

    /**
     * Returns the surface that a request of this document uses for the entry (see target): wanted when it registered the name, otherwise the preferred surface, or null when no surface registered. With exact, only wanted is accepted.
     */
    chosen: (kind, name, wanted, exact = false) => target(kind, name, wanted, exact),

    runOwned(name, params, owner, cids) {
      if (pageOf("command", name)) return answer("command.run", commandRequest(name, params, undefined, cids));
      const surface = target("command", name, owner, true);
      // default: the error sentence writes a missing owner (null) as none.
      if (surface === null) return Promise.reject(new ExposureError(EXPOSURE_ERRORS.unregistered, `owner ${owner ?? "none"} has not registered command ${name}`));
      return answer("command.run", commandRequest(name, params, surface, cids));
    },

    /**
     * Creates the table into which the state module of plugin owner registers entries in this document. There is one per plugin, and clear() removes all entries (docs/spec/plugins.md#plugin-state).
     */
    plugin(owner) {
      if (pages.has(owner)) throw new Error(`plugin ${owner} state is already registered`);
      const page = { entries: exposureEntries(declared), statuses: new Map() };
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

    /** Follows one core status inside this document. fn is called as fn(value, "core"), and the function returns an unsubscribe function. */
    observeCore: (name, fn) => core.follow(name, (value) => fn(value, "core")),

    observe(name, surface, fn, { exact = false } = {}) {
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

    /** Whether the name is declared. */
    declared: (kind, name) => declared.has(declarationKey(kind, name)),

    /** Registers a method that handles a request by its name. Diagnostic methods use it. */
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
     * Registers an entry of the plugin host of plugin under the owner key plugin:<plugin id>
     * (docs/spec/plugin-host.md#exposure). The name must be declared by the plugin.
     */
    hostRegistered({ plugin, kind, name }) {
      const key = declarationKey(kind, name);
      if (!declared.has(key)) throw new Error(`plugin ${plugin} registered undeclared ${kind} ${name}`);
      if (ownerOf(name) !== plugin) throw new Error(`plugin ${plugin} cannot register ${name}`);
      hosts.set(key, plugin);
      registrationTrace("registered", hostKeyOf(plugin), { kind, name });
      registrationChanged();
    },

    /** Removes every registration of the plugin host of plugin, whose channel ended (docs/spec/plugin-host.md#exposure). */
    hostUnregistered(plugin) {
      for (const [key, owner] of [...hosts]) {
        if (owner === plugin) hosts.delete(key);
      }
      registrationTrace("disposed", hostKeyOf(plugin));
      registrationChanged();
    },

    /** The owner key plugin:<plugin id> of the plugin host that registered the entry, or null when none did. */
    hostRegistrant(kind, name) {
      const plugin = hosts.get(declarationKey(kind, name));
      return plugin === undefined ? null : hostKeyOf(plugin);
    },

    /**
     * Runs a command that the plugin host of plugin registered, for a command call of that host (docs/spec/plugin-host.md#command-call).
     * The registration must be under the owner key plugin:<plugin id>, and another owner is refused with the registry error.
     */
    runHosted(name, params, plugin) {
      if (hosts.get(declarationKey("command", name)) !== plugin) {
        return Promise.reject(new ExposureError(EXPOSURE_ERRORS.unregistered, `owner ${hostKeyOf(plugin)} has not registered command ${name}`));
      }
      return forwardHost(plugin, "command.run", { name, params });
    },

    /** The declared time limit of the command name, or undefined when its declaration states none. */
    commandTimeout(name) {
      return declared.get(declarationKey("command", name))?.declaration.timeout;
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
    handle: ({ method, params }) => replyPayload(async () => {
      // Records the time of every core and plugin command in the performance trace (V5-104).
      const result = await answer(method, params);
      // The core and the mounted plugins share the application document. An origin that a separate document specified is kept.
      if (method === "dom.rect" && result && result.document === undefined) return { ...result, document: { x: 0, y: 0 } };
      return result;
    }),

    list,
    /** The declared time limit of a command in milliseconds, or undefined when its declaration has none (docs/spec/exposure.md). */
    commandTimeout: (name) => declared.get(declarationKey("command", name))?.declaration.timeout,
    surfaceDeclarations() {
      const listed = list();
      const onlySurface = (entry) => entry.name.startsWith(SURFACE_CORE);
      return {
        status: listed.status.filter(onlySurface),
        commands: listed.commands.filter(onlySurface),
        dom: listed.dom.filter(onlySurface),
      };
    },
  };
}

/** The registry of this document. A refused state change is reported to the application log and applicationError by the unhandled rejection handler of the page. */
export const registry = createRegistry(host
  ? { call: (name, arg) => host.call(name, arg), report: (error) => Promise.reject(error) }
  : {});

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

/** Resolves when the page has sent the reply of every exposure request that it has received. */
export function whenRepliesSent() {
  return unanswered === 0 ? Promise.resolve() : new Promise((resolve) => answeredWaiters.push(resolve));
}

/** Marks a surface as a view for the lifetime of its mount. The returned function ends the mark. */
export function markViewSurface(surface) {
  viewSurfaces.add(surface);
  return () => { viewSurfaces.delete(surface); };
}

const isCoreSurfaceRequest = ({ params }) => typeof params?.name === "string" && params.name.startsWith(SURFACE_CORE);

export async function dispatchSurfaceRequest(request) {
  // A view answers its own request through its subscription, so the request is consumed here and is not forwarded to the view again.
  if (viewSurfaces.has(request.surface) && !isCoreSurfaceRequest(request)) return true;
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
export async function connectExposure({ report, projectData, ...values }) {
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
      return registry.handle(request).then((payload) => host.call("exposureReply", { id: request.id, ...payload }));
    }).finally(requestAnswered);
  });
  await host.on("exposure-registered", (event) => {
    try {
      registry.registered(event);
    } catch (error) {
      report(`exposure: ${error.message}`);
    }
  });
  listenPluginHostCalls({
    register: (plugin, kind, name) => registry.hostRegistered({ plugin, kind, name }),
    unregister: (plugin) => registry.hostUnregistered(plugin),
    timeoutOf: (name) => registry.commandTimeout(name),
    // default: a rejection that is not an Error is reported with its text.
    report: (error) => report(`plugin host: ${errorText(error)}`),
    // The listing error of a host page is written through the line reporter of the page (docs/spec/plugin-host.md#channel).
    displayError: (line) => report(line),
    // The sidecars that environment.js declared for each plugin (docs/plans/plugin-host-routes.md rule 8).
    sidecarsOf: pluginSidecarsOf,
    // The project data of the shown project, which answers the data calls of a plugin host.
    projectData,
    // A core command runs as the main page runs it, and a command that the host registered runs under its owner check.
    runCore: (name, params) => registry.run(name, params),
    runOwned: (name, params, owner) => registry.runHosted(name, params, owner),
    // The log of the plugin context of the plugin, which writes its records through the event writer of the page (docs/spec/logging.md).
    pluginLog: (plugin) => createPluginRuntime({ pluginId: plugin, hooks: pluginRecords }).log,
  });
}
