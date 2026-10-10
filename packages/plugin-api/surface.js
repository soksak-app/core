// The DOM surface module contract. The workbench owns the host element and the lifecycle.

const callable = (value, name) => {
  if (typeof value !== "function") throw new TypeError(`surface module must export ${name}()`);
  return value;
};
const readyReleases = new WeakMap();

export function createSurfaceContext({
  root, surfaceId, pluginId, declarations = {}, composition = null, closing, diagnostics = () => null, runtime = {},
  tab, origin = { directory: null }, project = null, icon,
  // default: the surface of a plugin without extension points has no contributions, and every point is undeclared.
  contributions = (point) => { throw new Error(`extension point ${point} is not declared by ${pluginId}`); },
} = {}) {
  if (!root || typeof root.appendChild !== "function") throw new TypeError("surface context requires a root element");
  if (typeof surfaceId !== "string" || surfaceId === "") throw new TypeError("surface context requires surfaceId");
  if (!runtime.exposure || typeof runtime.exposure.command !== "function") {
    throw new TypeError("surface context requires scoped exposure");
  }
  if (typeof runtime.emit !== "function") {
    throw new TypeError("surface context requires scoped event routing");
  }
  if (typeof tab?.title !== "function" || typeof tab?.footer !== "function" || typeof tab?.directory !== "function"
    || typeof tab?.notify !== "function" || typeof tab?.modified !== "function" || typeof tab?.error !== "function") {
    throw new TypeError("surface context requires tab.title, tab.footer, tab.directory, tab.notify, tab.modified, and tab.error");
  }
  if (typeof icon !== "function") throw new TypeError("surface context requires icon(name)");
  if (!(closing instanceof AbortSignal)) throw new TypeError("surface context requires the closing signal");
  if (typeof diagnostics !== "function") throw new TypeError("surface context requires diagnostics()");
  const listeners = new Set();
  const eventListeners = new Map();
  const state = { phase: "loading", error: null };
  let readyRequested = false;
  const publish = (phase, error = null) => {
    state.phase = phase; state.error = error;
    for (const listener of listeners) listener({ ...state });
  };
  const report = (phase, error = null) => {
    if (!["loading", "ready", "error"].includes(phase)) throw new Error(`invalid surface phase: ${phase}`);
    if (phase === "ready") {
      readyRequested = true;
      return;
    }
    publish(phase, error);
  };
  const context = Object.freeze({
    root, surfaceId, pluginId,
    declarations: Object.freeze(structuredClone(declarations)),
    composition,
    // Aborts when the removal of the surface starts, before its regions are detached and before dispose runs
    // (docs/spec/plugins.md#surface-module-ownership).
    closing,
    // The diagnostics module of the plugin in a diagnostic build, and null in a release build. The diagnostics module is loaded after the first screen, so the workbench reads the value that it filled in
    // before it mounts the module.
    get diagnostics() { return diagnostics(); },
    // Tab reports (docs/spec/plugins.md#tab-reports): report to the workbench the title shown on the tab, the bottom text of the card header and the working directory.
    tab: Object.freeze({ title: tab.title, footer: tab.footer, directory: tab.directory, notify: tab.notify, modified: tab.modified, error: tab.error,
      // default: a tab opened without parameters has none (docs/spec/plugins.md#pluginjson).
      params: tab.params === undefined || tab.params === null ? null : Object.freeze(structuredClone(tab.params)) }),
    // The working directory that the active tab of the card that created this tab recorded at that time.
    // default: origin.directory is null when the active tab of the original card did not record a directory.
    origin: Object.freeze({ directory: origin.directory ?? null }),
    // The canonical root of the project shown in the surface window. It is null in a window without a project.
    project: project === null ? null : Object.freeze({ root: project.root }),
    // Core icons (docs/spec/plugins.md#icons): the stroke SVG string of a name on a 24-unit grid. A name that does not exist fails.
    icon,
    runtime: Object.freeze({
      sidecar: callable(runtime.sidecar, "runtime.sidecar").bind(runtime),
      native: runtime.native,
      clipboard: runtime.clipboard,
      // Opening links (docs/spec/plugins.md#opening-links).
      links: runtime.links,
      theme: runtime.theme,
      settings: runtime.settings,
      // The actual text size scale of this surface. read() returns the current scale, and on(fn) calls fn(scale) when the scale changes.
      textSize: runtime.textSize,
      // Writes an event of this surface to the performance trace with the plugin and surface ids
      // (docs/spec/plugins.md#tracing). The trace writes nothing while it is off.
      trace: (event, fields = {}) => {
        if (typeof event !== "string" || event === "") throw new TypeError("trace requires an event name");
        if (fields === null || typeof fields !== "object" || Array.isArray(fields)) {
          throw new TypeError("trace requires fields as an object");
        }
        // default: a page without a host (the browser application, a test) has no trace, as a trace that is off.
        runtime.trace?.(event, { ...fields, plugin: pluginId, surface: surfaceId });
      },
      // Stores an event of this plugin in the event log (docs/spec/plugins.md#logging): the name is `plugin.<plugin>.<event>`, the
      // fields carry the surface, and a level has one function. A page without a host has no event log, as a log that is off.
      log: Object.freeze(Object.fromEntries(["error", "warn", "info", "debug", "trace"].map((level) => [level, (event, fields = {}) => {
        if (typeof event !== "string" || !/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/.test(event)) {
          throw new TypeError("log requires an event name of lowercase words separated by dots");
        }
        if (fields === null || typeof fields !== "object" || Array.isArray(fields)) throw new TypeError("log requires fields as an object");
        if ("surface" in fields) throw new TypeError("log fields must not name the surface; the context adds it");
        // default: a page without a host (the browser application, a test) has no event log, as a log that is off.
        runtime.log?.(level, `plugin.${pluginId}.${event}`, { ...fields, surface: surfaceId });
      }]))),
    }),
    exposure: Object.freeze(runtime.exposure),
    events: Object.freeze({
      emit: (type, detail) => {
        // default: when no receiver is registered for that event, there is no place to report.
        for (const listener of eventListeners.get(type) ?? []) listener(detail);
        runtime.emit(type, detail);
      },
      on: (type, fn) => {
        if (typeof type !== "string" || typeof fn !== "function") throw new TypeError("events.on requires a type and listener");
        if (!eventListeners.has(type)) eventListeners.set(type, new Set());
        eventListeners.get(type).add(fn);
        return () => eventListeners.get(type)?.delete(fn);
      },
    }),
    status: Object.freeze({ report, read: () => ({ ...state }), subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); } }),
    // The connected contributions to the extension point point that this plugin declares (docs/spec/plugins.md#extension-points).
    contributions: (point) => {
      if (typeof point !== "string" || point === "") throw new TypeError("contributions requires an extension point name");
      return contributions(point);
    },
  });
  readyReleases.set(context, () => {
    if (readyRequested && state.phase === "loading") publish("ready");
  });
  return context;
}

export function releaseSurfaceReady(context) {
  const release = readyReleases.get(context);
  if (!release) throw new Error("releaseSurfaceReady requires a context from createSurfaceContext");
  release();
}

export async function mountSurfaceModule(module, root, context) {
  const mount = callable(module?.mount, "mount");
  const result = await mount(root, context);
  if (!result || typeof result !== "object" || typeof result.dispose !== "function") {
    throw new TypeError("surface module mount() must return { dispose() }");
  }
  return {
    dispose: result.dispose,
    focus: typeof result.focus === "function" ? result.focus : null,
  };
}
