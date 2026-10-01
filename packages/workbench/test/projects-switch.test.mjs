// 라이브러리 열기와 프로젝트 전환이 받은 순서대로 끝나는지 검사한다.
import assert from "node:assert/strict";
import { mock, test } from "node:test";

const PROJECT = {
  id: "prj-one", root: "/work/one", identity: "1:1", title: "one", color: "#fff", named: 1,
  activeSpaceId: "spc-one", spaces: [{ id: "spc-one", title: "SPACE1", layout: { state: "one" } }], settings: {},
};

// 창 열기 요청을 받은 프로젝트.
const openRequests = [];
mock.module("@soksak/runtime", {
  namedExports: {
    windows: {
      folder: async (root) => ({ root, identity: PROJECT.identity }),
      openProject: async (request) => { openRequests.push(request.id); return { local: true }; },
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

// 프로젝트 모듈이 쓰는 문서 전역. 창 오류 이벤트로 보고한 실패를 기록한다.
const reported = [];
globalThis.dispatchEvent = (event) => { reported.push(event.message); return true; };
globalThis.location = new URL("http://soksak.test/index.html");
globalThis.history = { replaceState: (state, title, url) => { globalThis.location = new URL(url, globalThis.location); } };

const projects = await import("../projects.js");

/** 판의 역할을 하는 기록기. hold() 뒤의 비우기는 release() 할 때까지 끝나지 않는다. rejected 배치는 검사에서 거부한다. */
const plane = { layout: null, events: [], gate: Promise.resolve(), rejected: null };
plane.hold = () => {
  plane.gate = new Promise((resolve) => { plane.release = resolve; });
};
projects.onSwitch({
  check: (layout) => { if (layout === plane.rejected) throw new Error("fixture layout cannot be opened"); },
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

test("a saved layout that fails the plane check rejects the open before any project or window change", async () => {
  const patches = [];
  const other = { ...structuredClone(PROJECT), id: "prj-bad", root: "/work/bad",
    spaces: [{ id: "spc-bad", title: "SPACE1", layout: { state: "bad" } }], activeSpaceId: "spc-bad" };
  const listed = [structuredClone(PROJECT), other];
  await projects.initialise({ ...store, snapshot: async () => ({ common: {}, projects: listed.map((item) => structuredClone(item)), open: [] }),
    patch: async (id, patch) => { patches.push([id, patch]); } });
  await projects.activate(PROJECT.id);
  const shown = plane.layout;
  plane.rejected = projects.all().find((item) => item.id === "prj-bad").spaces[0].layout;
  patches.length = 0;
  openRequests.length = 0;
  plane.events.length = 0;
  await assert.rejects(projects.activate("prj-bad"), /fixture layout cannot be opened/);
  assert.equal(projects.active().id, PROJECT.id, "the rejected open replaced the active project");
  assert.deepEqual(openRequests, [], "the rejected open asked the host for a window");
  assert.deepEqual(patches.filter(([id]) => id === "prj-bad"), [], "the rejected open changed the saved record");
  assert.deepEqual(plane.events, [], "the rejected open replaced the plane");
  assert.equal(plane.layout, shown);
  await projects.flush();
  assert.deepEqual(reported, ["fixture layout cannot be opened"], "the rejected open was not reported as a window error");
  plane.rejected = null;
  await projects.flush();
});

test("switching to or closing into a space that fails the plane check changes neither the active space nor the plane", async () => {
  // 이 창이 소유한 프로젝트는 메모리의 스페이스를 유지하므로 앞선 검사와 다른 프로젝트를 쓴다.
  const project = { ...structuredClone(PROJECT), id: "prj-spaces", root: "/work/spaces", spaces: [
    { id: "spc-one", title: "SPACE1", layout: { state: "one" } },
    { id: "spc-bad", title: "SPACE2", layout: { state: "bad" } },
  ] };
  await projects.initialise({ ...store, snapshot: async () => ({ common: {}, projects: [structuredClone(project)], open: [] }) });
  await projects.activate(project.id);
  plane.rejected = projects.active().spaces[1].layout;
  plane.events.length = 0;
  assert.throws(() => projects.activateSpace("spc-bad"), /fixture layout cannot be opened/);
  assert.equal(projects.active().activeSpaceId, "spc-one", "the rejected switch changed the active space");
  // 활성 스페이스를 닫으면 다음 스페이스로 이동한다. 그 스페이스가 검사에서 실패하면 닫기도 실패한다.
  assert.throws(() => projects.closeSpace("spc-one"), /fixture layout cannot be opened/);
  assert.deepEqual(projects.active().spaces.map((space) => space.id), ["spc-one", "spc-bad"], "the rejected close removed a space");
  assert.equal(projects.active().activeSpaceId, "spc-one");
  assert.deepEqual(plane.events, [], "the rejected switch replaced the plane");
  plane.rejected = null;
  await projects.flush();
});
