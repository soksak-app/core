// DOM surface module contract. Workbench owns the host element and lifecycle.

const callable = (value, name) => {
  if (typeof value !== "function") throw new TypeError(`surface module must export ${name}()`);
  return value;
};
const readyReleases = new WeakMap();

export function createSurfaceContext({
  root, surfaceId, pluginId, metadata = {}, declarations = {}, composition = null, diagnostics = null, runtime = {},
} = {}) {
  if (!root || typeof root.appendChild !== "function") throw new TypeError("surface context requires a root element");
  if (typeof surfaceId !== "string" || surfaceId === "") throw new TypeError("surface context requires surfaceId");
  if (!runtime.exposure || typeof runtime.exposure.command !== "function") {
    throw new TypeError("surface context requires scoped exposure");
  }
  if (typeof runtime.emit !== "function") {
    throw new TypeError("surface context requires scoped event routing");
  }
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
    root, surfaceId, pluginId, metadata: Object.freeze(structuredClone(metadata)),
    declarations: Object.freeze(structuredClone(declarations)),
    composition,
    // 진단 빌드에서는 플러그인의 진단 모듈, release 빌드에서는 null 이다.
    diagnostics,
    runtime: Object.freeze({
      sidecar: callable(runtime.sidecar, "runtime.sidecar").bind(runtime),
      native: runtime.native,
      clipboard: runtime.clipboard,
      theme: runtime.theme,
      settings: runtime.settings,
    }),
    exposure: Object.freeze(runtime.exposure),
    events: Object.freeze({
      emit: (type, detail) => {
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
  });
  readyReleases.set(context, () => {
    if (readyRequested && state.phase === "loading") publish("ready");
  });
  return context;
}

export function releaseSurfaceReady(context) {
  readyReleases.get(context)?.();
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
