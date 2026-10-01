// 플러그인 상태 모듈을 창이 보이는 프로젝트마다 마운트한다(docs/spec/plugins.md#plugin-state).
//
// 창이 다른 프로젝트나 라이브러리를 보이면 먼저 모든 상태 모듈을 해제하고 그 등록을 지운다.
import { checkProjectData } from "@soksak/plugin-api";
import { registry } from "./exposure.js";
import { log } from "./host.js";

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

// 기본값: format 은 plugin.json data 키의 선택 필드이며 없으면 1 이다(docs/spec/plugins.md#project-data).
const formatOf = (entry) => entry.format ?? 1;

/** 현재 형태의 저장 항목인가. 정확히 양의 정수 format 과 value 만 가진 객체다. */
const isEntry = (stored) => stored !== null && typeof stored === "object" && !Array.isArray(stored)
  && Object.keys(stored).sort().join() === "format,value" && Number.isInteger(stored.format) && stored.format > 0;

/**
 * 이전 형태나 format 으로 저장된 선언 키를 한 번 변환해 저장한다. 변환하지 못한 키는 저장 값을 두고, 그 키를
 * 읽을 때 낼 오류를 돌려준다(docs/spec/plugins.md#project-data).
 */
async function convertData(state, project, module, declared) {
  const failures = new Map();
  const stored = options.data.get(project.id, state.plugin);
  const where = (key) => `project ${project.id} plugin ${state.plugin} data ${key}`;
  for (const [key, entry] of Object.entries(declared)) {
    if (!Object.hasOwn(stored, key)) continue;
    const want = formatOf(entry);
    const current = isEntry(stored[key]);
    const format = current ? stored[key].format : 1;
    if (current && format === want) continue;
    if (format > want) {
      failures.set(key, `${where(key)}: stored format ${format} is newer than declared format ${want}`);
      continue;
    }
    let value = current ? stored[key].value : stored[key];
    if (format < want) {
      if (typeof module.convertData !== "function") {
        failures.set(key, `${where(key)}: stored format ${format} needs convertData to reach format ${want}`);
        continue;
      }
      try {
        value = await module.convertData({ key, format, value: structuredClone(value) });
      } catch (error) {
        failures.set(key, `${where(key)}: converting format ${format} to ${want} failed: ${error.message}`);
        continue;
      }
    }
    try {
      checkProjectData(state.plugin, declared, key, value);
    } catch (error) {
      failures.set(key, error.message);
      continue;
    }
    await options.data.set(project.id, state.plugin, key, { format: want, value });
    log(`plugin data: converted ${where(key)} from ${current ? `format ${format}` : "no format"} to format ${want}`);
  }
  return failures;
}

function contextOf(state, project, table, failures) {
  const session = `state:${state.plugin}:${project.id}`;
  // 기본값: data 는 plugin.json 의 선택 필드이며 없으면 프로젝트 데이터가 없다(docs/spec/plugins.md).
  const declared = state.data ?? {};
  const read = (key) => {
    const stored = options.data.get(project.id, state.plugin);
    if (!Object.hasOwn(declared, key)) throw new Error(`${state.plugin} data ${key} is not declared`);
    if (failures.has(key)) throw new Error(failures.get(key));
    if (!Object.hasOwn(stored, key)) return structuredClone(declared[key].default);
    return checkProjectData(state.plugin, declared, key, stored[key].value);
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
        await options.data.set(project.id, state.plugin, key, { format: formatOf(declared[key]), value });
        failures.delete(key);
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
      // 기본값: data 는 plugin.json 의 선택 필드이며 없으면 프로젝트 데이터가 없다(docs/spec/plugins.md).
      const declared = state.data ?? {};
      const failures = await convertData(state, project, module, declared);
      const result = await module.mount(contextOf(state, project, table, failures));
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
