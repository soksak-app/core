// 프로젝트 목록은 공유 저장소에, 활성 프로젝트와 창 소유권은 실행 중인 창에 저장한다.
import { issueId } from "./ids.js";
import { selectProject, value, flushSettings } from "./settings.js";
import { windows } from "@soksak/runtime";
import { retainSidecarSessions, windowSidecar } from "./host.js";
import { configureStates, showStates } from "./plugin-states.js";

let store;
let projects = [];
let activeProjectId = null;
let browsing = true;
let openProjects = new Set();
const owned = new Set();
let listener;
let changed = () => {};
let savedLayout = "";
let writing = Promise.resolve();
let refreshing = Promise.resolve();

export const all = () => projects;

/**
 * 모든 프로젝트의 모든 공간 레이아웃이 가진 탭을 표면과 그 프로젝트 루트로 반환한다. 이 목록에 없는 표면의
 * 사이드카 세션은 다시 붙을 곳이 없다(docs/spec/terminal-runtime.md).
 */
export function layoutSurfaces() {
  return projects.flatMap((project) => project.spaces.flatMap((space) => {
    const cards = space.layout?.state?.cards;
    if (!Array.isArray(cards)) throw new Error(`project ${project.id} space ${space.id} has no layout cards`);
    // 기본값: 자리 카드는 data 가 null 이므로 탭이 없다.
    return cards.flatMap((card) => (card.data?.tabs ?? []).map((tab) => ({ surface: tab.id, root: project.root })));
  }));
}
// 기본값: 활성 프로젝트가 없는 창(라이브러리)은 null 이다.
export const active = () => projects.find((p) => p.id === activeProjectId) ?? null;
export const local = () => projects.filter((p) => owned.has(p.id));
export const inLibrary = () => browsing;
export const isOpen = (id) => openProjects.has(id) || owned.has(id);
/**
 * 판을 바꾸는 전환(라이브러리 열기, 프로젝트 활성화)을 받은 순서대로 끝낸다.
 *
 * 라이브러리 열기는 판을 비우는 동안 기다린다. 그 사이에 시작한 활성화가 먼저 판을 채우면
 * 늦게 끝난 비우기가 활성 프로젝트의 판을 지운다.
 */
let switching = Promise.resolve();
function inTurn(run) {
  const done = switching.then(run);
  switching = done.then(undefined, (error) => {
    failed(error);
    return undefined;
  });
  return done;
}

export function browse() {
  return inTurn(async () => {
    await flush();
    browsing = true;
    await showStates(null);
    await listener.empty();
    await selectProject(null);
    changed();
  });
}
export const newWindow = () => windows.newWindow();
export const pin = (id, pinned) => store.patch(id, { pinned });
export function onSwitch(callbacks) { listener = callbacks; }
export function onChange(fn) { changed = fn; }

/** 프로젝트 id 의 플러그인 plugin 데이터 key 를 value 로 저장한다(docs/spec/plugins.md#project-data). */
async function setPluginData(id, plugin, key, value) {
  const project = projects.find((p) => p.id === id);
  if (!project) throw new Error(`Unknown project: ${id}`);
  // 기본값: 플러그인 데이터를 한 번도 저장하지 않은 프로젝트에는 plugins 가 없다.
  const plugins = { ...(project.plugins ?? {}), [plugin]: { ...(project.plugins?.[plugin] ?? {}), [key]: value } };
  await store.patch(id, { plugins });
  project.plugins = plugins;
}

export async function initialise(storage) {
  store = storage;
  configureStates({
    sidecar: windowSidecar,
    // 기본값: 플러그인 데이터를 저장하지 않은 프로젝트의 데이터는 비어 있다.
    data: { get: (id, plugin) => projects.find((p) => p.id === id)?.plugins?.[plugin] ?? {}, set: setPluginData },
  });
  await refresh();
  store.onChange(() => { refresh().catch(failed); });
  await windows.onActivate((id) => activateHere(id).catch(failed));
  await windows.onCloseRequest(() => closeWindow().catch(failed));
  const requested = new URL(location.href).searchParams.get("project");
  const first = requested ? projects.find((p) => p.id === requested) : null;
  if (first) {
    try { await activate(first.id); } catch (error) { failed(error); }
  }
  await windows.ready();
  changed();
}

function failed(error) { dispatchEvent(new ErrorEvent("error", { message: error.message })); }

function refresh() {
  refreshing = refreshing.then(readProjects, readProjects);
  return refreshing;
}

async function readProjects() {
  const snapshot = await store.snapshot();
  // 기본값: 브라우저 예제의 저장소는 다른 창이 없으므로 open 을 싣지 않는다.
  openProjects = new Set(snapshot.open ?? []);
  const previous = new Map(projects.map((p) => [p.id, p]));
  projects = snapshot.projects.map((p) => {
    const old = previous.get(p.id);
    return owned.has(p.id) && old ? { ...p, spaces: old.spaces, activeSpaceId: old.activeSpaceId, named: old.named } : p;
  });
  const removed = [...owned].filter(id => !projects.some(p => p.id === id));
  for (const id of removed) owned.delete(id);
  if (activeProjectId && !active()) {
    activeProjectId = null;
    browsing = true;
    history.replaceState(null, "", location.pathname);
    savedLayout = "";
    await selectProject(null);
    await showStates(null);
    await listener?.empty();
  } else if (removed.length && !browsing) listener?.update();
  changed();
}

export function keep() {
  const project = active();
  if (!project || !listener || browsing) return writing;
  project.spaces.find((s) => s.id === project.activeSpaceId).layout = listener.save();
  const patch = { spaces: project.spaces, activeSpaceId: project.activeSpaceId, named: project.named };
  const key = JSON.stringify(patch);
  if (key === savedLayout) return writing;
  savedLayout = key;
  const copy = structuredClone(patch);
  writing = writing.then(() => store.patch(project.id, copy));
  return writing;
}

function activateHere(id) {
  return inTurn(() => showProject(id));
}

async function showProject(id) {
  if (id === activeProjectId && !browsing) { await selectProject(id); return; }
  await keep();
  await refresh();
  const project = projects.find((p) => p.id === id);
  if (!project) throw new Error(`Unknown project: ${id}`);
  checkProject(project);
  await selectProject(id);
  owned.add(id);
  activeProjectId = id;
  browsing = false;
  history.replaceState(null, "", `${location.pathname}?project=${encodeURIComponent(id)}`);
  await showStates({ id, root: project.root });
  changed();
  savedLayout = "";
  listener.load(project.spaces.find((s) => s.id === project.activeSpaceId).layout);
  changed();
  // 불러온 레이아웃이 네이티브 합성기에 도달한 뒤에만 프로젝트 명령이 완료된다.
  // 먼저 반환하면 이전 프레임이 호출자에게 노출되고 영역이 비어 있는 상태를
  // 프로젝트 복원 성공으로 보고하게 된다.
  await listener.presented();
}

export function activate(id) {
  return inTurn(() => activateInTurn(id));
}

/** 프로젝트의 활성 스페이스 배치를 판이 열 수 있는지 검사한다. 실패하면 프로젝트·창·저장 기록을 바꾸기 전에 그 오류를 던진다. */
function checkProject(project) {
  listener.check(project.spaces.find((s) => s.id === project.activeSpaceId).layout);
}

async function activateInTurn(id) {
  const project = projects.find((p) => p.id === id);
  if (!project) throw new Error(`Unknown project: ${id}`);
  checkProject(project);
  await keep();
  await saveGeometry();
  const folder = await windows.folder(project.root);
  if (folder.identity !== project.identity) throw new Error(`Project directory has changed: ${project.root}`);
  const result = await windows.openProject({
    // 기본값: 창을 한 번도 닫지 않은 프로젝트는 저장된 창 자리가 없다(null).
    id, root: project.root, title: project.title, geometry: project.geometry ?? null,
    separate: value("projectOpening") === "windows", current: active() && !owned.has(id) ? activeProjectId : null,
  });
  await store.patch(id, { lastOpened: Date.now() });
  if (!result.local) { if (active()) await showProject(activeProjectId); return; }
  await showProject(id);
}

export async function open({ root, color, layout }) {
  if (!root.trim()) throw new Error("Project directory is empty");
  const folder = await windows.folder(root);
  const space = { id: issueId("space"), title: "SPACE1", layout };
  const project = await store.add({
    id: issueId("project"), ...folder, title: folder.root.split(/[\\/]/).filter(Boolean).at(-1), color,
    named: 1, spaces: [space], activeSpaceId: space.id, settings: {},
  });
  await refresh();
  await activate(project.id);
  return project;
}

export async function close(id) {
  if (id === activeProjectId) await keep();
  await windows.releaseProject(id);
  owned.delete(id);
  await store.remove(id);
  await refresh();
  // 지운 프로젝트의 탭은 어떤 레이아웃에도 없으므로 그 사이드카 세션을 끝낸다.
  await retainSidecarSessions(layoutSurfaces());
  if (active() && !browsing) listener.update();
  if (!active()) {
    const next = local()[0];
    if (next) await activate(next.id);
  }
}

export const rename = (id, title) => store.patch(id, { title });
export const move = (id, delta) => store.move(id, delta);

function restore() {
  const p = active();
  listener.load(p.spaces.find((s) => s.id === p.activeSpaceId).layout);
  changed();
  keep();
}

export function addSpace(layout) {
  const project = active();
  keep();
  const space = { id: issueId("space"), title: `SPACE${++project.named}`, layout };
  project.spaces.push(space);
  project.activeSpaceId = space.id;
  restore();
  return space;
}

export function activateSpace(id) {
  const project = active();
  if (id === project.activeSpaceId) return;
  const space = project.spaces.find((s) => s.id === id);
  if (!space) throw new Error(`Unknown space: ${id}`);
  // 판이 열 수 없는 배치면 활성 스페이스를 바꾸기 전에 실패한다.
  listener.check(space.layout);
  keep();
  project.activeSpaceId = id;
  restore();
}

export function closeSpace(id) {
  const project = active();
  if (project.spaces.length === 1) return;
  const at = project.spaces.findIndex((s) => s.id === id);
  if (at < 0) throw new Error(`Unknown space: ${id}`);
  // 활성 스페이스를 닫으면 다음 스페이스를 연다. 판이 그 배치를 열 수 없으면 아무것도 지우기 전에 실패한다.
  const rest = project.spaces.filter((s) => s.id !== id);
  const next = id === project.activeSpaceId ? rest[Math.min(at, rest.length - 1)] : null;
  if (next) listener.check(next.layout);
  keep();
  project.spaces.splice(at, 1);
  if (next) project.activeSpaceId = next.id;
  restore();
  // 닫은 공간의 탭은 어떤 레이아웃에도 없으므로 그 사이드카 세션을 끝낸다.
  retainSidecarSessions(layoutSurfaces()).catch(failed);
}

export function renameSpace(id, title) {
  active().spaces.find((s) => s.id === id).title = title;
  keep();
}

export async function saveGeometry() {
  const id = activeProjectId;
  if (!id || browsing) return;
  const geometry = await windows.state();
  if (geometry) await store.patch(id, { geometry });
}

export async function flush() {
  await keep();
  await flushSettings();
  await saveGeometry();
}

async function closeWindow() {
  await flush();
  await windows.close();
}
