// The test host of one view (docs/spec/native-surfaces.md#view-surfaces). A plugin repository tests its view page with it through the SDK
// release that it pins: answerViewCall of this package receives the options that createTestHost builds, from in-memory parts that the
// fixtures define, and the host events of the view reach the view through the subscriptions of createViewSubscriptions.
// The module is not a page module: the page imports no part of it (PAGE_IMPORTS of index.js).
import { checkProjectData, declarationKey, declarationMap, EXPOSE_KINDS, resolveContributions, sameJson } from "./index.js";
import { coreExposure } from "./exposure-check.js";
import { pluginNativeGate } from "./view-answer.js";
import { createViewSubscriptions } from "./view-events.js";

const subscribeTo = (listeners, listener) => {
  listeners.add(listener);
  return Promise.resolve(() => { listeners.delete(listener); });
};

const listenersOf = (map, key) => {
  if (!map.has(key)) map.set(key, new Set());
  return map.get(key);
};

const KINDS = Object.values(EXPOSE_KINDS);

/**
 * Creates the options of answerViewCall for one view of one plugin, and the observers of what the view did.
 *
 *     plugin, surface   the plugin id and the surface id of the view (required)
 *     declarations      the exposure of the plugin, {status, commands, element} as lists of {name}
 *     contributions     the installed plugins {id, package, version, manifest}, from which the contributions of the view resolve
 *     surfaces          [{surface, plugin}]: the surfaces that the window holds
 *     sidecars          the sidecar names that the plugin declares
 *     commands          {name: fn(params, cids)}: the core commands and the commands of the plugin that the view runs
 *     native            {name: fn(payload)}: the host calls of runtime.native.call
 *     sidecar           {name: fn(body)}: the sends to a declared sidecar
 *     clipboard         {read(type), writeText(text), readPNG(), persistPNG(binary)}
 *     composition       {declaration(), place(regions, overlays), report(text), document: {attach, load, zoom, go, post, subscribe,
 *                       unsubscribe, detach}, image: {attach, focus, caret, text, detach}}
 *     data              the project data declarations {key: {schema, default}}; the values are stored by the host
 *     project           the project {id, root} of the start values of the view, or null
 *     settings, textSize, logLevels   the values that the view reads: the settings of the plugin, the text scale and the log levels
 *     statuses          the values of the statuses by name, and by "<surface> <name>" for a watch on a surface; a status without a value
 *                       delivers nothing
 *     shortcuts         the rows of the shortcut table of the window
 *     state             {read(), write(value)}, present only when the plugin declares surface.unload
 *     menu              {declared, frame}: whether the plugin declares the surface menu, and the applied frame {x, y} or null
 *     faults            {route: message}: the route rejects with the message
 *
 * A route is the name of a host call, of a command or of a fixture: native.<name>, sidecar.<name>, command.<name>, clipboard.<op>,
 * composition.<path>, state.read and state.write, and viewEvent for the pushes of the view. A route whose fixture is missing rejects
 * with the error `view host: <route> has no fixture` and the failure is recorded in observed.failures. A route with a declared
 * fault rejects with the fault message. Every route work is tracked, so settled waits for it.
 *
 * Returns {options, observed, push, settled}.
 *
 *     options   the options of answerViewCall (view-answer.js of this package)
 *     observed  tab: the last title, footer, directory, modified, error and focus, and the lists notify and keep
 *               data: each stored value {key, value}; sidecar: each send {sidecar, id, body, cids}; commands: each run {name, params,
 *               cids, surface}; document: the host calls of the view in order, native calls as {name, payload} and pushes as
 *               {name: "viewEvent", payload: {event, data}}; errors: each report line; links: each opened URL; failures: the missing
 *               fixtures; events: each event record {level, event, fields}; contributions: each refused item {plugin, point, index, reason}
 *     push      push(event, data) delivers a host event to the subscriptions of the view: a native event of the plugin gate, or the
 *               event sidecar-failure with {sidecar, surface, reason} to the failure listeners of its surface; it throws when no
 *               subscription holds the event, as a page-wire notice without a listener is a failure
 *     settled   resolves when every route work that started has ended; a held fixture ends only when the test resolves it
 */
export function createTestHost(fixtures) {
  if (typeof fixtures?.plugin !== "string" || fixtures.plugin === "") throw new TypeError("createTestHost requires the plugin id of the view");
  if (typeof fixtures.surface !== "string" || fixtures.surface === "") throw new TypeError("createTestHost requires the surface id of the view");
  const { plugin, surface } = fixtures;
  const faults = fixtures.faults ?? {};
  const pluginDeclared = declarationMap(fixtures.declarations ?? {});
  const core = coreExposure();
  const coreDeclared = declarationMap({ status: core.status.map((name) => ({ name })), commands: core.commands.map((name) => ({ name })) });
  const declares = (kind, name) => pluginDeclared.has(declarationKey(kind, name)) || coreDeclared.has(declarationKey(kind, name));
  const observed = {
    tab: { title: null, footer: null, directory: null, modified: null, error: null, focus: null, notify: [], keep: [] },
    data: [], sidecar: [], commands: [], document: [], errors: [], links: [], failures: [], events: [], contributions: [],
  };
  const works = new Set();
  const track = (promise) => {
    works.add(promise);
    const done = () => works.delete(promise);
    promise.then(done, done);
    return promise;
  };
  const settled = async () => {
    while (works.size > 0) await Promise.allSettled([...works]);
  };
  const at = (...path) => path.reduce((node, key) => node?.[key], fixtures);

  // A route answers with its fixture, or rejects with its declared fault. A missing fixture is recorded and rejects.
  const route = (name, fixture, args) => {
    if (Object.hasOwn(faults, name)) return track(Promise.reject(new Error(faults[name])));
    if (typeof fixture !== "function") {
      const message = `view host: ${name} has no fixture`;
      observed.failures.push(message);
      return track(Promise.reject(new Error(message)));
    }
    return track(new Promise((resolve) => resolve(fixture(...args))));
  };
  // A route that the page answers synchronously, as the tab state is read and written; a fault or a missing fixture throws.
  const routeSync = (name, fixture, args) => {
    if (Object.hasOwn(faults, name)) throw new Error(faults[name]);
    if (typeof fixture !== "function") {
      const message = `view host: ${name} has no fixture`;
      observed.failures.push(message);
      throw new Error(message);
    }
    return fixture(...args);
  };
  const compositionCall = (path) => (...args) => route(["composition", ...path].join("."), at("composition", ...path), args);

  // The native events of the plugin and the failure listeners of the sidecars, by name and by surface id.
  const nativeListeners = new Map();
  const failureListeners = new Map();
  const native = {
    call: (name, payload) => {
      observed.document.push({ name, payload });
      return route(`native.${name}`, at("native", name), [payload]);
    },
    on: (name, listener) => subscribeTo(listenersOf(nativeListeners, name), listener),
  };
  // The plugin-facing native handle is the gate of view-answer.js, so the refusals of the region and bridge calls apply here too.
  const gate = pluginNativeGate(native);

  // The stored project data of each project, and the listeners of its changes.
  const declaredData = fixtures.data ?? {};
  const stores = new Map();
  const dataListeners = new Set();
  const storeOf = (project) => {
    if (!stores.has(project.id)) stores.set(project.id, new Map());
    return stores.get(project.id);
  };
  const dataOf = (project, owner) => {
    if (owner !== plugin) throw new Error(`data of ${owner} is not served to ${plugin}`);
    const store = storeOf(project);
    const get = (key) => (store.has(key) ? store.get(key) : declaredData[key]?.default);
    const write = (key, value) => {
      const checked = checkProjectData(plugin, declaredData, key, value);
      store.set(key, checked);
      observed.data.push({ key, value: checked });
      for (const listener of [...dataListeners]) listener(key);
    };
    return {
      declares: (key) => Object.hasOwn(declaredData, key),
      get,
      set: async (key, value) => write(key, value),
      // replace stores the value and answers true only when the stored value (or the default) equals base, as JSON values.
      replace: (key, base, value) => {
        if (!sameJson(get(key), base)) return false;
        write(key, value);
        return true;
      },
    };
  };

  const settingListeners = new Set();
  const textSizeListeners = new Set();
  const logListeners = new Set();
  const statuses = fixtures.statuses ?? {};
  const installed = fixtures.contributions ?? [];
  const resolved = resolveContributions(installed);
  const connected = (point) => {
    const provider = installed.find((entry) => entry.id === plugin);
    if (!provider?.manifest.extends?.[point]) throw new Error(`extension point ${point} is not declared by ${plugin}`);
    const id = `${plugin}.${point}`;
    return resolved.filter((entry) => entry.state === "connected" && entry.point === id).map((entry) => ({
      plugin: entry.plugin,
      index: entry.index,
      item: entry.item,
      module: entry.module,
      fail: (reason) => observed.contributions.push({ plugin: entry.plugin, point: entry.point, index: entry.index, reason }),
    }));
  };

  // A view has no run of the workbench, so the run state is idle and no run event is delivered.
  const run = { active: () => false, onStart: () => () => {}, onEnd: () => () => {} };
  const sidecar = {
    // The message route of a session is a registration of the host; no message is delivered through the subscriptions.
    route: () => Promise.resolve(() => {}),
    onFailure: (id, listener) => subscribeTo(listenersOf(failureListeners, id), listener),
  };
  const subscriptions = createViewSubscriptions({
    native: (name, listener) => gate.on(name, listener),
    sidecar,
    textSize: (listener) => subscribeTo(textSizeListeners, listener),
    settings: (listener) => subscribeTo(settingListeners, listener),
    data: (listener) => subscribeTo(dataListeners, listener),
    logLevels: { read: () => fixtures.logLevels ?? {}, on: (listener) => subscribeTo(logListeners, listener) },
    // A status value is delivered once, when its fixture is present; a watch on a surface reads the value of that surface.
    status: (name, watched, listener) => {
      const key = watched === undefined ? name : `${watched} ${name}`;
      if (Object.hasOwn(statuses, key)) listener(statuses[key]);
      return () => {};
    },
    run,
    push: (event, data) => {
      observed.document.push({ name: "viewEvent", payload: { event, data } });
      return route("viewEvent", () => null, []);
    },
    report: (text) => observed.errors.push(text),
    cancel: () => {},
    leftOut: () => false,
  });
  const registeredCommands = new Set();

  const tab = {
    title: (text) => { observed.tab.title = text; },
    footer: (text) => { observed.tab.footer = text; },
    directory: (path) => { observed.tab.directory = path; },
    modified: (value) => { observed.tab.modified = value; },
    error: (text) => { observed.tab.error = text; },
    notify: (text, policy) => { observed.tab.notify.push({ text, policy }); },
    keep: (reason, on) => { observed.tab.keep.push({ reason, on }); },
    focus: (value) => { observed.tab.focus = value; },
  };
  if (fixtures.state !== undefined) {
    tab.state = {
      read: () => routeSync("state.read", at("state", "read"), []),
      write: (value) => { routeSync("state.write", at("state", "write"), [value]); },
    };
  }

  // A host event reaches the view through the subscription that holds it, as the host posts it to the page.
  const push = (event, data) => {
    if (event === "sidecar-failure") {
      const listeners = failureListeners.get(data.surface);
      if (!listeners || listeners.size === 0) throw new Error(`view host: no subscription for ${event} of ${data.surface}`);
      for (const listener of [...listeners]) listener(data.reason);
      return;
    }
    const listeners = nativeListeners.get(event);
    if (!listeners || listeners.size === 0) throw new Error(`view host: no subscription for ${event}`);
    for (const listener of [...listeners]) listener(data);
  };

  const options = {
    plugin,
    surface,
    pending: new Map(),
    tab,
    contributions: connected,
    shortcuts: fixtures.shortcuts ?? [],
    emitEvent: (level, event, fields) => { observed.events.push({ level, event, fields }); },
    runCore: (name, params, cids) => {
      observed.commands.push({ name, params, cids });
      return route(`command.${name}`, at("commands", name), [params, cids]);
    },
    runOwned: (name, params, owner, cids, chosen, caller) => {
      if (owner !== plugin || !pluginDeclared.has(declarationKey("command", name))) throw new Error(`command ${name} is not declared by ${owner}`);
      observed.commands.push({ name, params, cids, surface: chosen ?? caller });
      return route(`command.${name}`, at("commands", name), [params, cids]);
    },
    startProject: () => fixtures.project ?? null,
    runtime: {
      native: gate,
      holdsSurface: (owner, name) => (fixtures.surfaces ?? []).some((entry) => entry.plugin === owner && entry.surface === name),
      menu: { declared: () => fixtures.menu?.declared === true, frame: () => fixtures.menu?.frame ?? null },
      data: { of: dataOf },
      clipboard: {
        read: (type) => route("clipboard.read", at("clipboard", "read"), [type]),
        writeText: (text) => route("clipboard.writeText", at("clipboard", "writeText"), [text]),
        readPNG: () => route("clipboard.readPNG", at("clipboard", "readPNG"), []),
        persistPNG: (binary) => route("clipboard.persistPNG", at("clipboard", "persistPNG"), [binary]),
      },
      links: { open: (url) => { observed.links.push(url); return Promise.resolve(null); } },
      report: (line) => { observed.errors.push(line); return Promise.resolve(null); },
      textSize: { read: () => fixtures.textSize ?? 1, on: (listener) => subscribeTo(textSizeListeners, listener) },
      settings: { read: () => fixtures.settings ?? {}, on: (listener) => subscribeTo(settingListeners, listener) },
      subscribe: {
        native: (name) => subscriptions.native(name),
        sidecarMessage: (id, name) => {
          if (!(fixtures.sidecars ?? []).includes(name)) throw new Error(`view call runtime.sidecar.on: ${plugin} declares no sidecar ${name}`);
          return subscriptions.sidecarMessage(id, name);
        },
        sidecarFailure: (id) => subscriptions.sidecarFailure(id),
        textSize: () => subscriptions.textSize(),
        settings: () => subscriptions.settings(),
        data: () => subscriptions.data(),
        logLevels: () => subscriptions.logLevels(),
        statusWatch: (name, watched) => {
          if (!declares("status", name)) throw new Error(`view call runtime.status.watch ${name} is not a declared status`);
          return subscriptions.statusWatch(name, watched);
        },
        statusUnwatch: (name, watched) => subscriptions.statusUnwatch(name, watched),
      },
      command: {
        // A command of the plugin is registered only when the plugin declares it, and once.
        register: async (name) => {
          if (!pluginDeclared.has(declarationKey("command", name))) throw new Error(`command ${name} is not declared by ${plugin}`);
          if (registeredCommands.has(name)) throw new Error(`command ${name} is already registered`);
          registeredCommands.add(name);
        },
      },
      exposure: {
        // A status, command or element registration names a declared entry of the plugin or of the core.
        registered: async ({ kind, name }) => {
          if (!KINDS.includes(kind)) throw new Error(`exposure kind ${kind} is not a kind of the exposure`);
          if (!declares(kind, name)) throw new Error(`${kind} ${name} is not declared`);
          observed.document.push({ name: "exposureRegister", payload: { kind, name } });
          return null;
        },
        changed: ({ name, value, version }) => {
          if (!declares("status", name)) throw new Error(`status ${name} is not declared`);
          observed.document.push({ name: "exposureChanged", payload: { name, value, version } });
          return null;
        },
      },
      sidecar: {
        send: (id, body, cids, name) => {
          observed.sidecar.push({ sidecar: name, id, body, cids });
          return route(`sidecar.${name}`, at("sidecar", name), [body]);
        },
      },
    },
    composition: {
      declaration: compositionCall(["declaration"]),
      place: compositionCall(["place"]),
      report: compositionCall(["report"]),
      document: Object.fromEntries(["attach", "load", "zoom", "go", "post", "subscribe", "unsubscribe", "detach"]
        .map((op) => [op, compositionCall(["document", op])])),
      image: Object.fromEntries(["attach", "focus", "caret", "text", "detach"].map((op) => [op, compositionCall(["image", op])])),
    },
  };

  return { options, observed, push, settled };
}
