// 플러그인 상태 모듈을 창이 보이는 프로젝트마다 마운트한다(docs/spec/plugins.md#plugin-state).
//
// 창이 다른 프로젝트나 라이브러리를 보이면 먼저 모든 상태 모듈을 해제하고 그 등록을 지운다.
import { checkProjectData } from "@soksak/plugin-api";
import { registry } from "./exposure.js";

const states = [];
let options = null;
/* 보이는 프로젝트 id 와 마운트한 상태 모듈. */
let shown = null;
let mounts = [];
let turn = Promise.resolve();

const failed = (plugin) => (error) =>
  dispatchEvent(new ErrorEvent("error", { message: `plugin ${plugin} state: ${error.message}` }));

/**
 * 상태 모듈이 쓰는 호스트 기능을 정한다.
 *   sidecar(name)                      {send(surface, body), on(surface, fn), onFailure(surface, fn)}
 *   data.get(project, plugin)          저장된 플러그인 데이터 객체
 *   data.set(project, plugin, key, v)  값 하나를 저장하는 promise
 */
export function configureStates(values) {
  options = values;
}

/** 상태 모듈 하나를 등록한다. state 는 {plugin, module, sidecars, data} 다. */
export function registerState(state) {
  states.push(state);
}

function contextOf(state, project, table) {
  const session = `state:${state.plugin}:${project.id}`;
  // 기본값: data 는 plugin.json 의 선택 필드이며 없으면 프로젝트 데이터가 없다(docs/spec/plugins.md).
  const declared = state.data ?? {};
  const read = (key) => {
    const stored = options.data.get(project.id, state.plugin);
    if (!Object.hasOwn(declared, key)) throw new Error(`${state.plugin} data ${key} is not declared`);
    return Object.hasOwn(stored, key) ? checkProjectData(state.plugin, declared, key, stored[key]) : structuredClone(declared[key].default);
  };
  const port = state.sidecars?.length === 1 ? options.sidecar(state.sidecars[0]) : null;
  return {
    project: { id: project.id, root: project.root },
    exposure: { status: table.status, command: table.command },
    sidecar: {
      send(body) {
        if (!port) throw new Error(`plugin ${state.plugin} state requires exactly one declared sidecar`);
        return port.send(session, body);
      },
      on(fn) {
        if (!port) throw new Error(`plugin ${state.plugin} state requires exactly one declared sidecar`);
        return port.on(session, fn);
      },
      onFailure(fn) {
        if (!port) throw new Error(`plugin ${state.plugin} state requires exactly one declared sidecar`);
        return port.onFailure(session, fn);
      },
    },
    data: {
      get: read,
      set: async (key, value) => {
        checkProjectData(state.plugin, declared, key, value);
        await options.data.set(project.id, state.plugin, key, value);
      },
    },
  };
}

async function show(project) {
  // 기본값: 프로젝트가 없는 창의 프로젝트 id 는 null 이다.
  if ((project?.id ?? null) === shown) return;
  const previous = mounts;
  mounts = [];
  // 기본값: 프로젝트가 없는 창의 프로젝트 id 는 null 이다.
  shown = project?.id ?? null;
  for (const { state, table, done } of previous) {
    try {
      await (await done)?.dispose();
    } catch (error) {
      failed(state.plugin)(error);
    }
    table.clear();
  }
  if (!project) return;
  for (const state of states) {
    const table = registry.plugin(state.plugin);
    const done = import(state.module).then(async (module) => {
      if (typeof module.mount !== "function") throw new TypeError(`state module of ${state.plugin} has no mount()`);
      const result = await module.mount(contextOf(state, project, table));
      if (!result || typeof result.dispose !== "function") throw new TypeError(`state module of ${state.plugin} must return { dispose() }`);
      return result;
    });
    const entry = { state, table, done: done.catch((error) => { failed(state.plugin)(error); return null; }) };
    mounts.push(entry);
    await entry.done;
  }
}

/** 창이 보이는 프로젝트 {id, root} 또는 null 을 알린다. 받은 순서대로 처리한다. */
export function showStates(project) {
  const done = turn.then(() => show(project));
  turn = done.catch(failed("states"));
  return done;
}
