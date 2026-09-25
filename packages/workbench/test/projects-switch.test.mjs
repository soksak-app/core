// 라이브러리 열기와 프로젝트 전환이 받은 순서대로 끝나는지 검사한다.
import assert from "node:assert/strict";
import { mock, test } from "node:test";

const PROJECT = {
  id: "prj-one", root: "/work/one", identity: "1:1", title: "one", color: "#fff", named: 1,
  activeSpaceId: "spc-one", spaces: [{ id: "spc-one", title: "SPACE1", layout: { state: "one" } }], settings: {},
};

mock.module("@soksak/runtime", {
  namedExports: {
    windows: {
      folder: async (root) => ({ root, identity: PROJECT.identity }),
      openProject: async () => ({ local: true }),
      releaseProject: async () => {},
      state: async () => null,
      close: async () => {},
      ready: async () => {},
      onActivate: async () => {},
      onCloseRequest: async () => {},
    },
  },
});
// 사이드카 세션 정리 호출을 기록한다.
const retained = [];
mock.module("../host.js", {
  namedExports: {
    retainSidecarSessions: async (surfaces) => { retained.push(surfaces); return { closed: 0 }; },
    windowSidecar: () => null,
  },
});
/* 창이 보인 프로젝트를 상태 모듈에 알린 순서. */
const shownStates = [];
let stateOptions = null;
mock.module("../plugin-states.js", {
  namedExports: {
    configureStates: (values) => { stateOptions = values; },
    showStates: async (project) => { shownStates.push(project?.id ?? null); },
  },
});
mock.module("../settings.js", {
  namedExports: {
    selectProject: async () => {},
    value: () => "tabs",
    flushSettings: async () => {},
  },
});

// 프로젝트 모듈이 쓰는 문서 전역.
globalThis.location = new URL("http://soksak.test/index.html");
globalThis.history = { replaceState: (state, title, url) => { globalThis.location = new URL(url, globalThis.location); } };

const projects = await import("../projects.js");

/** 판의 역할을 하는 기록기. hold() 뒤의 비우기는 release() 할 때까지 끝나지 않는다. */
const plane = { layout: null, events: [], gate: Promise.resolve() };
plane.hold = () => {
  plane.gate = new Promise((resolve) => { plane.release = resolve; });
};
projects.onSwitch({
  save: () => {
    if (plane.layout === null) throw new Error("the plane has no layout to save");
    return plane.layout;
  },
  load: (layout) => { plane.layout = layout; plane.events.push("load"); },
  update: () => {},
  presented: async () => {},
  empty: async () => {
    plane.events.push("empty started");
    await plane.gate;
    plane.layout = null;
    plane.events.push("emptied");
  },
});

const store = {
  snapshot: async () => ({ common: {}, projects: [structuredClone(PROJECT)], open: [] }),
  add: async () => { throw new Error("not used"); },
  patch: async () => {},
  remove: async () => {},
  onChange: () => {},
};

test("opening a project while the library is still clearing the plane loads it after the clearing", async () => {
  await projects.initialise(store);
  await projects.activate(PROJECT.id);
  assert.deepEqual(plane.layout, PROJECT.spaces[0].layout);

  plane.events.length = 0;
  plane.hold();
  const browsing = projects.browse();
  const opening = projects.activate(PROJECT.id);
  // 가짜 저장소와 런타임은 모두 마이크로태스크 안에서 끝난다. 다음 매크로태스크까지 기다리면
  // 비우기에 막히지 않은 작업은 모두 끝난 상태다.
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(plane.events, ["empty started"], "the project was loaded while the plane was being cleared");
  plane.release();
  await Promise.all([browsing, opening]);
  assert.deepEqual(plane.events, ["empty started", "emptied", "load"]);
  assert.deepEqual(plane.layout, PROJECT.spaces[0].layout);
  await projects.flush();
});

test("plugin states follow the shown project and project data is patched under plugins", async () => {
  const patches = [];
  await projects.initialise({ ...store, patch: async (id, patch) => { patches.push([id, patch]); } });
  await projects.browse();
  shownStates.length = 0;
  await projects.activate(PROJECT.id);
  await projects.browse();
  await projects.activate(PROJECT.id);
  assert.deepEqual(shownStates, [PROJECT.id, null, PROJECT.id]);
  assert.deepEqual(stateOptions.data.get(PROJECT.id, "probe"), {});
  await stateOptions.data.set(PROJECT.id, "probe", "marks", ["a"]);
  assert.deepEqual(patches.at(-1), [PROJECT.id, { plugins: { probe: { marks: ["a"] } } }]);
  assert.deepEqual(stateOptions.data.get(PROJECT.id, "probe"), { marks: ["a"] });
  await projects.flush();
});

test("the surfaces of every layout are listed with their project root, and removing a project retains the rest", async () => {
  const layout = { state: { cards: [
    { id: "left" },
    { id: "right", data: { tabs: [{ id: "tab-a" }, { id: "tab-b" }] } },
  ] } };
  const two = {
    ...structuredClone(PROJECT), id: "prj-two", root: "/work/two",
    spaces: [{ id: "spc-two", title: "SPACE1", layout }],
  };
  const one = { ...structuredClone(PROJECT), id: "prj-three" };
  let listed = [one, two];
  const local = { ...store, snapshot: async () => ({ common: {}, projects: listed.map((item) => structuredClone(item)), open: [] }),
    remove: async (id) => { listed = listed.filter((item) => item.id !== id); } };
  await projects.initialise(local);
  assert.throws(() => projects.layoutSurfaces(), /has no layout cards/, "a layout without cards is an explicit error");
  listed[0].spaces[0].layout = { state: { cards: [{ id: "one", data: { tabs: [{ id: "tab-one" }] } }] } };
  await projects.initialise(local);
  assert.deepEqual(projects.layoutSurfaces(), [
    { surface: "tab-one", root: "/work/one" },
    { surface: "tab-a", root: "/work/two" },
    { surface: "tab-b", root: "/work/two" },
  ]);
  retained.length = 0;
  await projects.close("prj-two");
  assert.deepEqual(retained, [[{ surface: "tab-one", root: "/work/one" }]],
    "removing a project retains only the surfaces of the remaining layouts");
});
