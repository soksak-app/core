// 설치된 플러그인 작업과 core.plugins status(docs/spec/installation.md 의 Plugin screen 과 애플리케이션 안의 plugin
// 작업). host 는 pluginsState 와 pluginsRun 을 제공하며,
// host 가 없으면 창이 불러온 플러그인만 보이고 작업은 없다.

export const PLUGIN_ACTIONS = ["install", "update", "remove", "enable", "disable"];

/** x.y.z 버전 두 개를 숫자로 비교한다. registry index 는 버전 형식을 검사한 뒤 보낸다. */
function compareVersions(a, b) {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return 0;
}

/**
 * 플러그인이 이름을 댄 사이드카를 이름 순서의 {name, range, version} 으로 만든다. 설치된 플러그인은 installed.json
 * 항목의 범위와 설치된 사이드카 버전을, 아니면 가장 새 registry 버전의 범위를, 아니면 불러온 manifest 의 이름만 쓴다.
 */
function sidecarsOf(record, entry, unit, state) {
  let ranges;
  if (record) ranges = Object.entries(record.sidecars);
  else if (entry) ranges = Object.entries(entry.versions.toSorted((a, b) => compareVersions(a.version, b.version)).at(-1).sidecars);
  else ranges = unit.sidecars.map((name) => [name, null]);
  return ranges.sort(([a], [b]) => a.localeCompare(b)).map(([name, range]) => ({
    name, range,
    // 기본값: host 상태가 없거나 설치되지 않은 사이드카는 버전을 모른다(null).
    version: state?.installed.sidecars[name]?.version ?? null,
  }));
}

/**
 * 목록 행을 id 순서로 만든다. loaded 는 창이 불러온 플러그인 {id, name, description, version, sidecars},
 * state 는 host 의 pluginsState 결과이며 host 가 없으면 null 이다.
 */
export function pluginRows(loaded, state) {
  const byId = new Map(loaded.map((unit) => [unit.id, unit]));
  if (!state) {
    return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)).map((unit) => ({
      id: unit.id, name: unit.name, description: unit.description, state: "loaded", installed: null, latest: null,
      sidecars: sidecarsOf(null, null, unit, null),
    }));
  }
  const installed = state.installed.plugins;
  // index 가 없거나 읽지 못했으면 registry 플러그인이 없다.
  const indexed = new Map(Array.isArray(state.index?.plugins) ? state.index.plugins.map((entry) => [entry.id, entry]) : []);
  const ids = [...new Set([...byId.keys(), ...Object.keys(installed), ...indexed.keys()])].sort();
  return ids.map((id) => {
    const unit = byId.get(id);
    const entry = indexed.get(id);
    const record = Object.hasOwn(installed, id) ? installed[id] : null;
    let status;
    if (unit && record && record.enabled && record.version === unit.version) status = "loaded";
    else if (!unit && record && !record.enabled) status = "disabled";
    else if (!unit && !record) status = "available";
    else status = "restart";
    const latest = entry ? entry.versions.map((v) => v.version).sort(compareVersions).at(-1) : null;
    // 기본값: 이름과 설명은 불러온 manifest, registry 항목, plugin id 순서로 정한다(docs/spec/installation.md).
    const about = unit ?? entry ?? { name: id, description: "" };
    return {
      id, name: about.name, description: about.description, state: status,
      installed: record ? { version: record.version, enabled: record.enabled } : null, latest,
      // installed.json 에만 있는 플러그인도 그 항목이 사이드카를 가진다.
      sidecars: sidecarsOf(record, entry, unit, state),
    };
  });
}

/**
 * 플러그인 작업 상태. host 가 null 이면 작업 없이 불러온 플러그인만 보고한다. changed 는 상태가 바뀔 때마다
 * 불린다.
 */
export function createPluginOperations({ host, loaded, changed }) {
  let state = null;
  // 읽기 실패는 {kind, message} 다. kind 는 registry index 를 읽지 못한 index 나 plugin 상태를 읽지 못한 state 다.
  let failure = null;
  let operation = null;

  /** host 의 상태를 다시 읽는다. 읽지 못하면 그 오류를 failure 로 보고한다. */
  async function refresh() {
    if (!host) return;
    try {
      state = await host.call("pluginsState");
      failure = state.index && typeof state.index.error === "string" ? { kind: "index", message: state.index.error } : null;
    } catch (error) {
      state = null;
      failure = { kind: "state", message: error.message };
    } finally {
      changed();
    }
  }

  /** 작업 하나를 실행한다. 실행 전에 running 으로, 끝난 뒤 done 이나 failed 로 기록한다. */
  async function runAction(action, plugin) {
    if (!PLUGIN_ACTIONS.includes(action)) throw new Error(`unknown plugin action ${action}`);
    if (!host) throw new Error("plugin operations need a native host");
    operation = { action, plugin, state: "running", error: null };
    changed();
    try {
      await host.call("pluginsRun", { action, plugin });
      operation = { action, plugin, state: "done", error: null };
    } catch (error) {
      operation = { action, plugin, state: "failed", error: error.message };
      throw error;
    } finally {
      await refresh();
    }
  }

  /** core.plugins status 의 값. */
  function status() {
    const rows = host && !state ? [] : pluginRows(loaded(), state);
    return {
      // 기본값: 상태를 읽기 전이나 읽지 못했으면 registry 주소가 없다(null).
      registry: state?.registry ?? null,
      // 기본값: 읽기 실패가 없으면 error 는 null 이다(core.plugins).
      error: failure?.message ?? null,
      plugins: rows,
      operation,
      restart: rows.some((row) => row.state === "restart"),
    };
  }

  /**
   * 첫 실행이면 starter pack 의 plugin 을 pack 의 순서대로 설치하고 true 를 돌려준다(docs/spec/installation.md 의 첫
   * 실행). 호출자는 설치한 plugin 을 불러오도록 page 를 다시 불러온다. registry 가 없으면 기록하고, plugin 이 없는 창이
   * 그 이유를 밝히도록 show 로 알린 뒤 false 다.
   */
  async function installStarter(pack, log, show) {
    if (!host || pack === null || !state?.firstRun) return false;
    if (state.registry === null) {
      log(`first run: no registry is set; the starter pack ${pack} was not installed`);
      show(`플러그인 레지스트리가 없어 시작 플러그인 묶음 ${pack}을 설치하지 못했습니다. sok registry use 로 레지스트리를 정한 뒤 다시 시작하세요.`);
      return false;
    }
    if (typeof state.index?.error === "string") throw new Error(`first run: ${state.index.error}`);
    const entry = state.index.packs.find((item) => item.name === pack);
    if (!entry) throw new Error(`first run: the registry has no pack ${pack}`);
    for (const id of entry.plugins) await runAction("install", id);
    return true;
  }

  return { refresh, run: runAction, status, installStarter, failure: () => failure, hosted: Boolean(host) };
}
