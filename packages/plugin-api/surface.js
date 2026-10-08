// DOM surface 모듈 계약. Workbench가 host 요소와 lifecycle을 소유한다.

const callable = (value, name) => {
  if (typeof value !== "function") throw new TypeError(`surface module must export ${name}()`);
  return value;
};
const readyReleases = new WeakMap();

export function createSurfaceContext({
  root, surfaceId, pluginId, declarations = {}, composition = null, diagnostics = () => null, runtime = {},
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
    // 진단 빌드에서는 플러그인의 진단 모듈, release 빌드에서는 null 이다. 진단 모듈은 첫 화면 뒤에 불러오므로 workbench 가
    // 모듈을 mount 하기 전에 채운 값을 읽는다.
    get diagnostics() { return diagnostics(); },
    // 탭 알림(docs/spec/plugins.md#tab-reports): 탭에 보일 제목, 카드 발의 하단 글과 작업 디렉터리를 워크벤치에 알린다.
    tab: Object.freeze({ title: tab.title, footer: tab.footer, directory: tab.directory, notify: tab.notify, modified: tab.modified, error: tab.error,
      // default: a tab opened without parameters has none (docs/spec/plugins.md#pluginjson).
      params: tab.params === undefined || tab.params === null ? null : Object.freeze(structuredClone(tab.params)) }),
    // 이 탭을 만든 카드의 활성 탭이 그때 기록한 작업 디렉터리.
    // 기본값: 원래 카드의 활성 탭이 디렉터리를 기록하지 않았으면 origin.directory 는 null 이다.
    origin: Object.freeze({ directory: origin.directory ?? null }),
    // 표면 창이 보이는 프로젝트의 정규 루트. 프로젝트가 없는 창에서는 null 이다.
    project: project === null ? null : Object.freeze({ root: project.root }),
    // 코어 아이콘(docs/spec/plugins.md#icons): 이름의 24 단위 획 SVG 문자열. 없는 이름은 실패한다.
    icon,
    runtime: Object.freeze({
      sidecar: callable(runtime.sidecar, "runtime.sidecar").bind(runtime),
      native: runtime.native,
      clipboard: runtime.clipboard,
      // 링크 열기(docs/spec/plugins.md#opening-links).
      links: runtime.links,
      theme: runtime.theme,
      settings: runtime.settings,
      // 이 표면의 실제 글자 배율. read() 는 현재 배율, on(fn) 은 배율이 바뀔 때 fn(배율) 을 부른다.
      textSize: runtime.textSize,
    }),
    exposure: Object.freeze(runtime.exposure),
    events: Object.freeze({
      emit: (type, detail) => {
        // 기본값: 그 이벤트에 등록한 수신자가 없으면 알릴 곳이 없다.
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
