// The DOM surface module contract. The workbench owns the host element and the lifecycle.
import { createPluginRuntime } from "./plugin-runtime.js";

const callable = (value, name) => {
  if (typeof value !== "function") throw new TypeError(`surface module must export ${name}()`);
  return value;
};
const readyReleases = new WeakMap();

// The one rule of a view origin directory (docs/spec/native-surfaces.md#view-surfaces): an absolute path in the local form. The
// // (UNC) and /<letter>: (drive) prefixes and a NUL byte are refused, so every host applies the same string test on every platform.
export function isLocalAbsolutePath(path) {
  return path.startsWith("/") && !path.startsWith("//") && !/^\/[A-Za-z]:/.test(path) && !path.includes("\u0000");
}

// The fault of the origin of a surface, or null when it has the form {directory} with null or a local absolute path. The texts are
// those of docs/spec/native-surfaces.md#view-surfaces; the checks run in order and the first match gives the text.
export function originFault(surfaceId, origin) {
  const at = `surface "${surfaceId}": view start origin`;
  if (origin === undefined) return `${at} is missing`;
  const isObject = origin !== null && typeof origin === "object" && !Array.isArray(origin);
  if (!isObject || Object.keys(origin).length !== 1 || !("directory" in origin)
    || (origin.directory !== null && typeof origin.directory !== "string")) {
    return `${at} is not {directory} with a path or null`;
  }
  if (origin.directory === "") return `${at} directory is empty`;
  if (origin.directory !== null && !isLocalAbsolutePath(origin.directory)) return `${at} directory is not an absolute path`;
  return null;
}

export function createSurfaceContext({
  root, surfaceId, pluginId, declarations = {}, composition = null, closing, diagnostics = () => null, runtime = {},
  tab, origin, project = null, icon,
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
    || typeof tab?.notify !== "function" || typeof tab?.modified !== "function" || typeof tab?.error !== "function"
    || typeof tab?.keep !== "function") {
    throw new TypeError("surface context requires tab.title, tab.footer, tab.directory, tab.notify, tab.modified, tab.error, and tab.keep");
  }
  if (tab.state !== undefined && (typeof tab.state?.read !== "function" || typeof tab.state?.write !== "function")) {
    throw new TypeError("surface context tab.state requires read and write");
  }
  // The origin is required: a value of another form is refused with the text of its first failed check, and the page never fills it in.
  const fault = originFault(surfaceId, origin);
  if (fault !== null) throw new TypeError(fault);
  if (typeof icon !== "function") throw new TypeError("surface context requires icon(name)");
  if (!(closing instanceof AbortSignal)) throw new TypeError("surface context requires the closing signal");
  if (typeof diagnostics !== "function") throw new TypeError("surface context requires diagnostics()");
  const recording = createPluginRuntime({ pluginId, surfaceId, hooks: runtime });
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
    // keep reports work in progress, and state, present only for a plugin that declares surface.unload as {format, maxBytes},
    // reads and writes the tab state (docs/spec/plugins.md#memory-saver).
    tab: Object.freeze({ title: tab.title, footer: tab.footer, directory: tab.directory, notify: tab.notify, modified: tab.modified, error: tab.error,
      keep: tab.keep,
      ...(tab.state === undefined ? {} : { state: Object.freeze({ read: tab.state.read, write: tab.state.write }) }),
      // default: a tab opened without parameters has none (docs/spec/plugins.md#pluginjson).
      params: tab.params === undefined || tab.params === null ? null : Object.freeze(structuredClone(tab.params)) }),
    // The working directory that the active tab of the card that created this tab recorded at that time, or null when it recorded none.
    origin: Object.freeze({ directory: origin.directory }),
    // The canonical root of the project shown in the surface window. It is null in a window without a project.
    project: project === null ? null : Object.freeze({ id: project.id, root: project.root }),
    // Core icons (docs/spec/plugins.md#icons): the stroke SVG string of a name on a 24-unit grid. A name that does not exist fails.
    icon,
    runtime: Object.freeze({
      sidecar: callable(runtime.sidecar, "runtime.sidecar").bind(runtime),
      // Runs a command that core declares for this surface and answers its result (docs/spec/plugins.md#surface-module-ownership).
      command: callable(runtime.command, "runtime.command"),
      native: runtime.native,
      clipboard: runtime.clipboard,
      // Opening links (docs/spec/plugins.md#opening-links).
      links: runtime.links,
      theme: runtime.theme,
      settings: runtime.settings,
      // The actual text size scale of this surface. read() returns the current scale, and on(fn) calls fn(scale) when the scale changes.
      textSize: runtime.textSize,
      // Writes an event of this surface to the performance trace and to the event log (docs/spec/plugins.md#tracing,
      // docs/spec/plugins.md#logging); the calls and their gates are those of every plugin context.
      trace: recording.trace,
      log: recording.log,
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
