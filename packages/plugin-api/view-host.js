// The test host of one view (docs/spec/native-surfaces.md#view-surfaces). A plugin repository tests its view page with it through the SDK
// release that it pins: answerViewCall of this package receives the options that createTestHost builds, from in-memory parts that the
// fixtures define, and the host events of the view reach the view through the subscriptions of createViewSubscriptions.
// The module is not a page module: the page imports no part of it (PAGE_IMPORTS of index.js).
import { checkProjectData, declarationKey, declarationMap, EXPOSE_KINDS, modulePath, resolveContributions, sameJson } from "./index.js";
import { coreExposure } from "./exposure-check.js";
import { checkViewFocus, pluginNativeGate } from "./view-answer.js";
import { createViewSubscriptions } from "./view-events.js";

const subscribeTo = (listeners, listener) => {
  listeners.add(listener);
  return Promise.resolve(() => { listeners.delete(listener); });
};

const listenersOf = (map, key) => {
  if (!map.has(key)) map.set(key, new Set());
  return map.get(key);
};

// Adds fn to the set, and returns the function that removes it.
const addListener = (set, fn) => {
  set.add(fn);
  return () => { set.delete(fn); };
};

// The key of a status value as the fixtures name it: the name, or the surface and the name of a watch on a surface.
const statusKeyOf = (name, surface) => (surface === undefined ? name : `${surface} ${name}`);

// The dependency fixtures by plugin id: a dependency of plugin.json names the package of a plugin, and the view calls name its plugin id
// (docs/spec/plugins.md#pluginjson). A fixture without a plugin id is refused.
const dependencyFixtures = (byPackage) => Object.fromEntries(Object.entries(byPackage).map(([name, entry]) => {
  if (typeof entry?.plugin !== "string" || entry.plugin === "") throw new TypeError(`dependency fixture ${name} requires the plugin id of the package`);
  return [entry.plugin, entry];
}));

const KINDS = Object.values(EXPOSE_KINDS);

/**
 * Creates the options of answerViewCall for one view of one plugin, and the observers of what the view did.
 *
 *     plugin, surface   the plugin id and the surface id of the view (required)
 *     declarations      the exposure of the plugin, {status, commands, element} as lists of {name}
 *     dependencies      the plugins that the plugin lists in dependencies, by package as plugin.json names them:
 *                       {package: {plugin, status: [{name}], data: {key: {schema, default}}, values: {key: value}}}, with the plugin id that the
 *                       view calls name, the statuses and the project data each declares, and the values of its data for the start project
 *     contributions     the installed plugins {id, package, version, folder, manifest}, from which the contributions of the view resolve
 *     surfaces          [{surface, plugin}]: the surfaces that the window holds
 *     sidecars          the sidecar names that the plugin declares
 *     commands          {name: fn(params, cids)}: the core commands and the commands of the plugin that the view runs
 *     native            {name: fn(payload)}: the host calls of runtime.native.call
 *     sidecar           {name: fn(body)}: the sends to a declared sidecar
 *     clipboard         {read(type), writeText(text), readPNG(), persistPNG(binary)}
 *     programs          {name: fn(args)}: the reply of each run of a declared program, which runs with the argument texts; the reply is
 *                       {code, stdout, stderr, truncated} (docs/spec/native-surfaces.md#program-runs)
 *     dialogs           {name: fn(params)}: the result of each dialog that the view opens, which receives the params of the open call
 *                       (docs/spec/plugins.md#dialogs)
 *     dialog            the start value dialog {name, opener} of the view, which openView passes, or null: only a dialog view closes itself
 *     composition       {declaration(), place(regions, overlays), report(text), document: {attach, load, zoom, go, post, subscribe,
 *                       unsubscribe, detach}, image: {attach, focus, caret, text, detach}}
 *     data              the project data declarations {key: {schema, default}}; the values are stored by the host
 *     project           the project {id, root} of the start values of the view, or null
 *     settings, textSize, logLevels   the values that the view reads at its start: the settings of the plugin, the text scale and the log levels
 *     statuses          the values of the statuses at the start, by name, and by "<surface> <name>" for a watch on a surface; a status
 *                       without a value delivers nothing until change.status gives it one
 *     run               true when a run continues at the start of the view (false when none)
 *     shortcuts         the rows of the shortcut table of the window
 *     state             {read(), write(value)}, present only when the plugin declares surface.unload
 *     menu              {declared, frame}: whether the plugin declares the surface menu, and the applied frame {x, y} at the start, or null
 *     faults            {route: message}: the route rejects with the message; `command.runtime.log` refuses each batch of the page log with its message, and `command.runtime.data.get` refuses each read of the project data
 *     onDataRead        fn(key, reads, write(value)): runs after each read of a project data key by the view, with the read count of the key;
 *                       write stores a value of the key as another view does, so a replace of the view that follows the read sees it
 *     viewEvent         fn(event, data): the reply of each push of the view, which the host answers; without it the reply is null
 *
 * A route is the name of a host call, of a command or of a fixture: native.<name>, sidecar.<name>, command.<name>, clipboard.<op>, program.<name>,
 * composition.<path>, state.read and state.write, and viewEvent for the pushes of the view. A route whose fixture is missing rejects
 * with the error `view host: <route> has no fixture` and the failure is recorded in observed.failures. A route with a declared
 * fault rejects with the fault message. Every route work is tracked, so settled waits for it.
 *
 * Returns {options, observed, push, sidecarMessage, settled, change, logBatch, contributedModules, close}. logBatch() resolves with null, or
 * rejects with the fault of command.runtime.log; the view host of testing.js calls it for each batch of the page log. contributedModules()
 * returns a Map from each module URL that the host answers (soksak://core/modules/<package>/<module>) to the URL of the file that
 * the installed plugin names for it, which the view host of testing.js maps for the imports of the page. Each installed plugin names its
 * modules in `modules` as {<module of the manifest>: <file or data URL>}. sidecarMessage(name, id, {body, cids}) returns the host message
 * for a sidecar message of a routed session: {event: "sidecar.message", data: {id, cids, body}}, the message that the host posts to the view.
 *
 *     options   the options of answerViewCall (view-answer.js of this package)
 *     observed  page: the lists notify, progress and done of the page notices
     observed  tab: the last title, footer, directory, modified, error and focus, and the lists notify, progress, done and keep
 *               data: each stored value {key, value}; sidecar: each send {sidecar, id, body, cids}; commands: each run {name, params,
 *               cids, surface}; document: the host calls of the view in order, native calls as {name, payload} and pushes as
 *               {name: "viewEvent", payload: {event, data}}; errors: each report line; links: each opened URL; programs: each run {name, args};
 *               dialogs: each open {name, params}; closes: each result of a close;
 *               failures: the missing
 *               fixtures; events: each event record {level, event, fields}; contributions: each refused item {plugin, point, index, reason};
 *               timers: each timer or animation frame that the page window started, {kind, delay} (delay null for an animation frame)
 *     push      push(event, data) delivers a host event to the subscriptions of the view: a native event of the plugin gate, or the
 *               event sidecar-failure with {sidecar, surface, reason} to the failure listeners of its surface; it throws when no
 *               subscription holds the event, as a page-wire notice without a listener is a failure
 *     settled   resolves when every route work that started has ended; a held fixture ends only when the test resolves it
 *     close     ends the subscriptions of the view through the close of createViewSubscriptions, as the page ends them when the view closes;
 *               the events that a change pushes after it reach no subscription
 *     change    the changes of the window that a test makes, each one set as the window sets it: the value that the view reads is
 *               replaced, and the listeners that createViewSubscriptions registered for it are called, so the subscriptions push the
 *               events that follow. settings(values), textSize(value), logLevels(levels), status(name, value, surface), run(active),
 *               data(key, value), which writes the project data as another view does (checked, observed in data), leftOut(value) and
 *               frame(value), which sets the applied frame of the surface of the view
 */
export function createTestHost(fixtures) {
  if (typeof fixtures?.plugin !== "string" || fixtures.plugin === "") throw new TypeError("createTestHost requires the plugin id of the view");
  if (typeof fixtures.surface !== "string" || fixtures.surface === "") throw new TypeError("createTestHost requires the surface id of the view");
  const { plugin, surface } = fixtures;
  // default: a fixture without faults declares no fault, so every route answers with its fixture.
  const faults = fixtures.faults ?? {};
  // default: a fixture without declarations means the plugin declares no exposure entry.
  const pluginDeclared = declarationMap(fixtures.declarations ?? {});
  const core = coreExposure();
  const coreDeclared = declarationMap({ status: core.status.map((name) => ({ name })), commands: core.commands.map((name) => ({ name })) });
  // default: a fixture without dependencies lists no plugin in dependencies, so the view follows no status of another plugin.
  const dependencies = dependencyFixtures(fixtures.dependencies ?? {});
  // default: a dependency fixture without a status list declares no status.
  const dependencyDeclared = declarationMap({ status: Object.values(dependencies).flatMap((entry) => entry.status ?? []) });
  // default: a name is declared when the plugin, core or a dependency of the plugin declares it.
  const declares = (kind, name) => pluginDeclared.has(declarationKey(kind, name)) || coreDeclared.has(declarationKey(kind, name)) || dependencyDeclared.has(declarationKey(kind, name));
  const observed = {
    tab: { title: null, footer: null, directory: null, modified: null, error: null, focus: null, notify: [], progress: [], done: [], keep: [] },
    page: { notify: [], progress: [], done: [] },
    data: [], sidecar: [], commands: [], document: [], errors: [], links: [], programs: [], dialogs: [], closes: [], failures: [], events: [], contributions: [], timers: [],
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
  // default: a fixture without data declares no project data key.
  const declaredData = fixtures.data ?? {};
  const stores = new Map();
  const dataListeners = new Set();
  // The listeners of the changes of the data of each dependency, by plugin id.
  const dependencyDataListeners = new Map();
  // The number of reads of each key by the view, which fixtures.onDataRead receives.
  const dataReads = new Map();
  // The stored values of the plugin and of each dependency for a project; a dependency starts with the values of its fixture.
  // The declared scope of a key of the plugin or of a dependency: plugin for a key that belongs to no project, project otherwise
  // (docs/spec/plugins.md#plugin-data).
  const scopeOf = (owner, key) => {
    // default: a dependency fixture without data declares no key.
    const declared = owner === plugin ? declaredData : dependencies[owner]?.data ?? {};
    return declared[key]?.scope ?? "project"; // default: a key without a scope is a project key.
  };
  // The store of a key: the store of the project for a project key, and the one store of no project for a plugin key, which every
  // project and a view without a project share.
  const storeOf = (project, owner = plugin, key = undefined) => {
    if (key !== undefined && scopeOf(owner, key) === "plugin") project = { id: null };
    if (!stores.has(project.id)) stores.set(project.id, new Map());
    const byOwner = stores.get(project.id);
    // default: a dependency fixture without values starts with empty project data.
    if (!byOwner.has(owner)) byOwner.set(owner, new Map(Object.entries(owner === plugin ? {} : dependencies[owner]?.values ?? {})));
    return byOwner.get(owner);
  };
  // A change of a dependency's data as its own view makes it: the value is checked against the declaration of the dependency, stored,
  // and each listener of the changes of that dependency is called with the key.
  const writeDependencyData = (project, owner, key, value) => {
    // default: a dependency fixture without data declares no key, which checkProjectData refuses.
    storeOf(project, owner, key).set(key, checkProjectData(owner, dependencies[owner]?.data ?? {}, key, value));
    for (const listener of [...listenersOf(dependencyDataListeners, owner)]) listener(key);
  };
  // The data of a dependency for a project, which the view reads and does not write.
  const dependencyDataOf = (project, owner) => {
    // default: a dependency fixture without data declares no key.
    const declared = dependencies[owner]?.data ?? {};
    return {
      declares: (key) => Object.hasOwn(declared, key),
      scope: (key) => scopeOf(owner, key),
      get: (key) => {
        if (!Object.hasOwn(declared, key)) throw new Error(`${owner} data ${key} is not declared`);
        return storeOf(project, owner, key).has(key) ? storeOf(project, owner, key).get(key) : structuredClone(declared[key].default);
      },
    };
  };
  // A write of the project data, as any view makes it: the value is checked against its declaration, stored, recorded in observed.data,
  // and each listener of the data is called with the key.
  const writeData = (project, key, value) => {
    const checked = checkProjectData(plugin, declaredData, key, value);
    storeOf(project, plugin, key).set(key, checked);
    observed.data.push({ key, value: checked });
    for (const listener of [...dataListeners]) listener(key);
  };
  const dataOf = (project, owner) => {
    if (owner !== plugin) {
      if (!Object.hasOwn(dependencies, owner)) throw new Error(`data of ${owner} is not served to ${plugin}`);
      return dependencyDataOf(project, owner);
    }
    const current = (key) => (storeOf(project, plugin, key).has(key) ? storeOf(project, plugin, key).get(key) : declaredData[key]?.default);
    const write = (key, value) => writeData(project, key, value);
    return {
      declares: (key) => Object.hasOwn(declaredData, key),
      scope: (key) => scopeOf(plugin, key),
      // A read answers the stored value, then fixtures.onDataRead runs with the read count of the key and a writer of another view, so a
      // write made there lands between this read and the replace that follows it.
      get: (key) => {
        if (Object.hasOwn(faults, "command.runtime.data.get")) throw new Error(faults["command.runtime.data.get"]);
        const value = current(key);
        // default: a key not read before has read count zero.
        const reads = (dataReads.get(key) ?? 0) + 1;
        dataReads.set(key, reads);
        // default: onDataRead is an optional fixture; without it no other view writes between a read and its replace.
        fixtures.onDataRead?.(key, reads, (next) => write(key, next));
        return value;
      },
      set: async (key, value) => write(key, value),
      // replace stores the value and answers true only when the stored value (or the default) equals base, as JSON values.
      replace: (key, base, value) => {
        if (!sameJson(current(key), base)) return false;
        write(key, value);
        return true;
      },
    };
  };

  // The values that the view reads from the window, and the listeners of their changes. The change methods set a value and call the
  // listeners that the subscriptions registered, as the window does when its state changes.
  // default: a fixture without settings has no setting value.
  let settingValues = fixtures.settings ?? {};
  // default: the text size of a window without a change is 1, as the host starts it.
  let textSizeValue = fixtures.textSize ?? 1;
  // default: a fixture without log levels sets no level.
  let logLevelValues = fixtures.logLevels ?? {};
  let runActive = fixtures.run === true;
  let leftOutNow = false;
  // default: a fixture without a menu frame has no applied frame, as the host before its first frame.
  let appliedFrame = fixtures.menu?.frame ?? null;
  const settingListeners = new Set();
  const textSizeListeners = new Set();
  const logListeners = new Set();
  const runStartListeners = new Set();
  const runEndListeners = new Set();
  // The value of each status by its key, and the listeners of each key.
  // default: a fixture without statuses has no status value at the start.
  const statusValues = new Map(Object.entries(fixtures.statuses ?? {}));
  const statusListeners = new Map();
  // default: a fixture without contributions installs no contribution.
  const installed = fixtures.contributions ?? [];
  const resolved = resolveContributions(installed);
  // The module URLs that the host answers for the contributions of the installed plugins, each mapped to the module URL that the fixture
  // names. An installed plugin names its modules as {<module of its manifest>: <file or data URL>}; the host answers each one as
  // soksak://core/<modulePath of the package>, the form that the page imports.
  // default: a contribution without modules contributes no module.
  const contributedModules = () => new Map(installed.flatMap((entry) => Object.entries(entry.modules ?? {}).map(
    ([module, target]) => [`soksak://core/${modulePath(entry.package, module)}`, target],
  )));
  const connected = (point) => {
    const provider = installed.find((entry) => entry.id === plugin);
    if (!provider?.manifest.extends?.[point]) throw new Error(`extension point ${point} is not declared by ${plugin}`);
    const id = `${plugin}.${point}`;
    return resolved.filter((entry) => entry.state === "connected" && entry.point === id).map((entry) => ({
      plugin: entry.plugin,
      index: entry.index,
      item: entry.item,
      module: entry.module,
      folder: entry.folder,
      fail: (reason) => observed.contributions.push({ plugin: entry.plugin, point: entry.point, index: entry.index, reason }),
    }));
  };

  // The run state of the window: whether a run continues, and the listeners of each start and end of a run.
  const run = { active: () => runActive, onStart: (fn) => addListener(runStartListeners, fn), onEnd: (fn) => addListener(runEndListeners, fn) };
  // The sessions whose messages the host routes to the view, by the key of the sidecar name and the session id.
  const sidecarRoutes = new Set();
  const sidecar = {
    // The route of a session is the registration that the view makes for its sidecar messages; its off function removes the route.
    route: (id, name) => {
      const key = JSON.stringify([name, id]);
      sidecarRoutes.add(key);
      return Promise.resolve(() => { sidecarRoutes.delete(key); });
    },
    onFailure: (id, listener) => subscribeTo(listenersOf(failureListeners, id), listener),
  };
  const subscriptions = createViewSubscriptions({
    native: (name, listener) => gate.on(name, listener),
    sidecar,
    textSize: (listener) => subscribeTo(textSizeListeners, listener),
    settings: (listener) => subscribeTo(settingListeners, listener),
    data: (owner, listener) => subscribeTo(owner === undefined ? dataListeners : listenersOf(dependencyDataListeners, owner), listener),
    logLevels: { read: () => logLevelValues, on: (listener) => subscribeTo(logListeners, listener) },
    // A status value is delivered when the watch starts, if the value is present; each later value comes from change.status.
    status: (name, watched, listener) => {
      const key = statusKeyOf(name, watched);
      if (statusValues.has(key)) listener(statusValues.get(key));
      return addListener(listenersOf(statusListeners, key), listener);
    },
    run,
    push: (event, data) => {
      observed.document.push({ name: "viewEvent", payload: { event, data } });
      // default: without a viewEvent fixture the host answers each push of the view with null, as the host whose window has no reply.
      return route("viewEvent", fixtures.viewEvent ?? (() => null), [event, data]);
    },
    report: (text) => observed.errors.push(text),
    cancel: () => {},
    leftOut: () => leftOutNow,
  });
  const registeredCommands = new Set();

  // default: the notice ids follow the order of the notices, as the workbench assigns them, so a test names the notice it updates.
  let noticeCount = 0;
  const page = {
    notify: (fields) => { observed.page.notify.push(fields); noticeCount += 1; return `notice-${noticeCount}`; },
    progress: (id, progress) => { observed.page.progress.push({ id, progress }); },
    done: (id, kind, title) => { observed.page.done.push({ id, kind, title }); },
  };
  const tab = {
    title: (text) => { observed.tab.title = text; },
    footer: (text) => { observed.tab.footer = text; },
    directory: (path) => { observed.tab.directory = path; },
    modified: (value) => { observed.tab.modified = value; },
    error: (text) => { observed.tab.error = text; },
    notify: (fields) => { observed.tab.notify.push(fields); noticeCount += 1; return `notice-${noticeCount}`; },
    progress: (id, progress) => { observed.tab.progress.push({ id, progress }); },
    done: (id, kind, title) => { observed.tab.done.push({ id, kind, title }); },
    keep: (reason, on) => { observed.tab.keep.push({ reason, on }); },
    focus: (value) => { observed.tab.focus = checkViewFocus(value); },
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
    page,
    contributions: connected,
    // default: a fixture without shortcuts declares no shortcut.
    shortcuts: fixtures.shortcuts ?? [],
    emitEvent: (level, event, fields) => { observed.events.push({ level, event, fields }); },
    runCore: (name, params, cids) => {
      observed.commands.push({ name, params, cids });
      return route(`command.${name}`, at("commands", name), [params, cids]);
    },
    runOwned: (name, params, owner, cids, chosen, caller) => {
      if (owner !== plugin || !pluginDeclared.has(declarationKey("command", name))) throw new Error(`command ${name} is not declared by ${owner}`);
      // default: a command run without a chosen surface runs for the caller surface, as the host relays it.
      observed.commands.push({ name, params, cids, surface: chosen ?? caller });
      return route(`command.${name}`, at("commands", name), [params, cids]);
    },
    // default: a fixture without a project opens the view without a project, as the host for a window without a project.
    startProject: () => fixtures.project ?? null,
    runtime: {
      native: gate,
      // default: a fixture without surfaces holds no surface of another plugin.
      holdsSurface: (owner, name) => (fixtures.surfaces ?? []).some((entry) => entry.plugin === owner && entry.surface === name),
      // default: a fixture without dependencies lists no plugin of the view in dependencies.
      dependsOn: (viewPlugin, dependency) => viewPlugin === plugin && Object.hasOwn(dependencies, dependency),
      menu: { declared: () => fixtures.menu?.declared === true, frame: () => appliedFrame },
      data: { of: dataOf },
      clipboard: {
        read: (type) => route("clipboard.read", at("clipboard", "read"), [type]),
        writeText: (text) => route("clipboard.writeText", at("clipboard", "writeText"), [text]),
        readPNG: () => route("clipboard.readPNG", at("clipboard", "readPNG"), []),
        persistPNG: (binary) => route("clipboard.persistPNG", at("clipboard", "persistPNG"), [binary]),
      },
      links: { open: (url) => { observed.links.push(url); return Promise.resolve(null); } },
      program: {
        run: (name, args) => {
          observed.programs.push({ name, args });
          return route(`program.${name}`, at("programs", name), [args]);
        },
      },
      dialog: {
        open: (name, params) => {
          observed.dialogs.push({ name, params });
          return route(`dialog.${name}`, at("dialogs", name), [params]);
        },
        close: (result) => {
          if (fixtures.dialog == null) return Promise.reject(new Error("view call runtime.dialog.close is served only to a dialog"));
          observed.closes.push(result);
          return Promise.resolve(null);
        },
      },
      report: (line) => { observed.errors.push(line); return Promise.resolve(null); },
      textSize: { read: () => textSizeValue, on: (listener) => subscribeTo(textSizeListeners, listener) },
      settings: { read: () => settingValues, on: (listener) => subscribeTo(settingListeners, listener) },
      subscribe: {
        native: (name) => subscriptions.native(name),
        sidecarMessage: (id, name) => {
          // default: a fixture without sidecars declares no sidecar, so each sidecar route is refused.
          if (!(fixtures.sidecars ?? []).includes(name)) throw new Error(`view call runtime.sidecar.on: ${plugin} declares no sidecar ${name}`);
          return subscriptions.sidecarMessage(id, name);
        },
        sidecarFailure: (id) => subscriptions.sidecarFailure(id),
        textSize: () => subscriptions.textSize(),
        settings: () => subscriptions.settings(),
        data: (owner) => subscriptions.data(owner),
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

  // The changes of the window that a test makes. Each one sets the value that the view reads, then calls the listeners that the
  // subscriptions registered for it.
  const change = {
    settings(values) {
      settingValues = values;
      for (const listener of [...settingListeners]) listener(values);
    },
    textSize(value) {
      textSizeValue = value;
      for (const listener of [...textSizeListeners]) listener(value);
    },
    logLevels(levels) {
      logLevelValues = levels;
      for (const listener of [...logListeners]) listener();
    },
    status(name, value, surface) {
      const key = statusKeyOf(name, surface);
      statusValues.set(key, value);
      // default: a status without a listener has no listener to call.
      for (const listener of [...(statusListeners.get(key) ?? [])]) listener(value);
    },
    run(active) {
      if (typeof active !== "boolean") throw new TypeError("change.run requires true or false");
      if (active === runActive) return;
      runActive = active;
      for (const listener of [...(active ? runStartListeners : runEndListeners)]) listener();
    },
    data(key, value) {
      if (!fixtures.project) throw new TypeError("change.data requires the start project of the view");
      writeData(fixtures.project, key, value);
    },
    dependencyData(owner, key, value) {
      if (!fixtures.project) throw new TypeError("change.dependencyData requires the start project of the view");
      writeDependencyData(fixtures.project, owner, key, value);
    },
    leftOut(value) {
      if (typeof value !== "boolean") throw new TypeError("change.leftOut requires true or false");
      leftOutNow = value;
    },
    frame(value) {
      appliedFrame = value;
    },
  };

  // The message that the host posts to the view for a sidecar message of the session id: the view event sidecar.message with {id, cids, body},
  // which the subscription of the page receives. A session without a route is refused, because the host posts only to a routed view.
  const sidecarMessage = (name, id, { body, cids }) => {
    if (!sidecarRoutes.has(JSON.stringify([name, id]))) {
      throw new Error(`view host: no route for sidecar ${name} session ${id}: the view has no subscription for it`);
    }
    return { event: "sidecar.message", data: { id, ...(cids === undefined ? {} : { cids }), body } };
  };

  // The writer of the page: a batch of the page log is refused with the fault of command.runtime.log, and accepted otherwise.
  const logBatch = () => (Object.hasOwn(faults, "command.runtime.log")
    ? Promise.reject(new Error(faults["command.runtime.log"]))
    : Promise.resolve(null));

  return { options, observed, push, sidecarMessage, settled, change, logBatch, contributedModules, close: () => subscriptions.close() };
}
