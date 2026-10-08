// 프로젝트 목록은 공유 저장소에, 활성 프로젝트와 창 소유권은 실행 중인 창에 저장한다.
import { issueId } from "./ids.js";
import { beginSettings, selectProject, value, flushSettings } from "./settings.js";
import { windows } from "@soksak/runtime";
import { log, retainSidecarSessions, windowSidecar } from "./host.js";
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
/* 첫 화면에 그렸고 아직 활성화하지 않은 프로젝트. initialise 의 활성화가 이어받는다. */
let begun = null;

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
  // 실패는 done 을 받은 호출자가 보고한다(명령, 라이브러리, 창 활성화, 시작 문서). 다음 전환은 앞의 실패와
  // 상관없이 실행한다.
  switching = done.then(undefined, () => undefined);
  return done;
}

/*
 * 라이브러리 상태와 화면은 판을 비우는 그리기에서 함께 바뀐다(showLibrary). 그 그리기는 관찰 round 보다 먼저 실행되는
 * animation frame 이므로, 판이 비고 라이브러리가 보이는 것이 한 frame 에 함께 나타나고 작업 영역을 숨기는 전환이 round
 * 안에서 실행되지 않는다. 측정한 사실: 이전에는 이 전환이 files 트리 observer 의 callback slot 안에서 실행되었다(F43).
 * 그 slot 에서 전환을 시작한 경로는 진단 기록기(resize-loop.js)가 body dataset 쓰기의 stack 으로 보고한다.
 */
function showLibrary() {
  browsing = true;
  changed();
}

/** 판을 비우고 그 그리기에서 라이브러리를 보인다. 그리기가 실패해도 전환은 라이브러리로 끝난다. 실패는 배치 대기열이 보였다. */
async function emptyToLibrary() {
  await listener.empty(showLibrary);
  browsing = true;
}

export function browse() {
  return inTurn(async () => {
    await flush();
    await showStates(null);
    await emptyToLibrary();
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

/**
 * Draws the first screen from the snapshot of the start document (docs/spec/native-host.md#page-start): the layout of
 * the active space of the project in the address when the plane can open it, or else the library. The activation of
 * initialise then checks the folder, owns the window and reports its failures.
 */
export function begin(snapshot) {
  // 기본값: 브라우저 예제의 저장소는 다른 창이 없으므로 open 을 싣지 않는다.
  openProjects = new Set(snapshot.open ?? []);
  projects = snapshot.projects;
  // 기본값: project 를 지정하지 않았거나 등록부에 없는 project 를 지정한 창은 라이브러리로 시작한다.
  const requested = projects.find((p) => p.id === new URL(location.href).searchParams.get("project")) ?? null;
  const layout = requested?.spaces.find((s) => s.id === requested.activeSpaceId)?.layout;
  let opened = null;
  if (layout) {
    try {
      checkSpace(requested, requested.activeSpaceId);
      opened = requested;
    } catch {
      // 판이 열 수 없는 배치는 initialise 의 활성화가 그 오류를 보고하고 라이브러리에 남는다.
    }
  }
  // 기본값: 연 project 가 없으면 설정에도 project 가 없다.
  beginSettings(snapshot, opened?.id ?? null);
  if (!opened) {
    changed();
    return;
  }
  activeProjectId = opened.id;
  browsing = false;
  begun = opened.id;
  // 작업 공간 화면이 판에 크기를 주므로 화면을 먼저 바꾸고 판을 그린다. 크기 없이 그린 판은 다음 frame 에 다시 그려진다.
  changed();
  listener.load(layout);
  opened.spaces.find((s) => s.id === opened.activeSpaceId).layout = listener.save();
  savedLayout = JSON.stringify({ spaces: opened.spaces, activeSpaceId: opened.activeSpaceId, named: opened.named });
}

export async function initialise(storage) {
  store = storage;
  configureStates({
    sidecar: windowSidecar,
    // 기본값: 플러그인 데이터를 저장하지 않은 프로젝트의 데이터는 비어 있다.
    data: { get: (id, plugin) => projects.find((p) => p.id === id)?.plugins?.[plugin] ?? {}, set: setPluginData },
  });
  await refresh();
  store.onChange(() => { reread().catch(failed); });
  await windows.onActivate((id) => activateHere(id).catch(failed));
  await windows.onCloseRequest(() => closeWindow().catch(failed));
  await windows.onRemoveProjectRequest((id) => answerRemoval(id).catch(failed));
  const requested = new URL(location.href).searchParams.get("project");
  const first = requested ? projects.find((p) => p.id === requested) : null;
  if (first) {
    try { await activate(first.id); } catch (error) { failed(error); }
  }
  // 첫 화면에 그린 프로젝트를 활성화하지 못했으면 라이브러리로 돌아간다.
  if (begun !== null && !owned.has(begun)) await leaveBegun();
  begun = null;
  await windows.ready();
  changed();
}

/**
 * Answers the host's request that another window sends before it removes the project id: a window that shows the
 * project in its plane asks for each modified tab first (docs/spec/plugins.md#tab-reports).
 */
async function answerRemoval(id) {
  let allowed = false;
  try {
    allowed = !(id === activeProjectId && !browsing) || await listener.settleTabs();
  } finally {
    await windows.answerRemoveProject(id, allowed);
  }
}

function failed(error) { dispatchEvent(new ErrorEvent("error", { message: error.message })); }

/** 첫 화면에 그렸지만 열지 못한 프로젝트를 닫고 라이브러리를 보인다. */
async function leaveBegun() {
  activeProjectId = null;
  savedLayout = "";
  history.replaceState(null, "", location.pathname);
  await selectProject(null);
  await emptyToLibrary();
}

/** 등록부를 다시 읽는다. 이 창의 활성 프로젝트가 등록부에서 사라졌으면 true 로 끝난다. */
function refresh() {
  refreshing = refreshing.then(readProjects, readProjects);
  return refreshing;
}

/**
 * 등록부를 다시 읽고, 이 창의 활성 프로젝트가 사라졌으면 프로젝트 탭 닫기처럼 이 창의 남은 첫 프로젝트를 연다.
 * 남은 프로젝트가 없으면 readProjects 가 보인 라이브러리에 남는다(docs/spec/projects.md#settings).
 * 활성화는 refresh 를 기다리므로 readProjects 안에서 하지 않는다.
 */
async function reread() {
  if (!(await refresh())) return;
  const next = local()[0];
  if (next) await activate(next.id);
}

async function readProjects() {
  const snapshot = await store.snapshot();
  const listed = new Set(snapshot.projects.map((p) => p.id));
  const removedProjects = projects.some((p) => !listed.has(p.id));
  // 아래의 정리는 저장된 레이아웃의 탭만 남긴다. 남는 활성 프로젝트의 판에 아직 저장하지 않은 탭이 있으면 그 표면도
  // 남도록 먼저 저장한다. 지운 프로젝트는 저장하지 않는다.
  if (removedProjects && listed.has(activeProjectId)) await keep();
  // 기본값: 브라우저 예제의 저장소는 다른 창이 없으므로 open 을 싣지 않는다.
  openProjects = new Set(snapshot.open ?? []);
  const previous = new Map(projects.map((p) => [p.id, p]));
  projects = snapshot.projects.map((p) => {
    const old = previous.get(p.id);
    return owned.has(p.id) && old ? { ...p, spaces: old.spaces, activeSpaceId: old.activeSpaceId, named: old.named } : p;
  });
  const removed = [...owned].filter(id => !projects.some(p => p.id === id));
  for (const id of removed) owned.delete(id);
  const ended = activeProjectId !== null && !active();
  if (ended) {
    activeProjectId = null;
    history.replaceState(null, "", location.pathname);
    savedLayout = "";
    await selectProject(null);
    await showStates(null);
    await emptyToLibrary();
  } else if (removed.length && !browsing) listener?.update();
  if (removedProjects) {
    // 지운 프로젝트의 탭은 어떤 레이아웃에도 없다. 그 프로젝트를 지운 창이든 보이던 창이든, 이 창의 그 표면 모듈을 먼저
    // 정리하고 사이드카 세션을 끝낸다. 모듈이 남아 있으면 끝난 세션을 다시 열며, 지운 프로젝트의 폴더가 없으면 그 열기는
    // 실패한다(F44). 호스트는 남은 모듈의 표면 세션을 retain 에서 남긴다(docs/spec/terminal-runtime.md).
    const remaining = layoutSurfaces();
    await listener.retain(new Set(remaining.map((item) => item.surface)));
    await retainSidecarSessions(remaining);
  }
  changed();
  return ended;
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
  if (id === activeProjectId && !browsing && owned.has(id)) { await selectProject(id); return; }
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
  checkSpace(project, project.activeSpaceId);
}

/** Checks that the plane can open the stored layout of a space; the error names projects.json and the space. */
function checkSpace(project, id) {
  try {
    listener.check(project.spaces.find((s) => s.id === id).layout);
  } catch (error) {
    throw new Error(`projects.json: project ${project.root} space ${id}: ${error.message}`);
  }
}

async function activateInTurn(id) {
  const project = projects.find((p) => p.id === id);
  if (!project) throw new Error(`Unknown project: ${id}`);
  checkProject(project);
  // 첫 화면에 그린 프로젝트의 활성화는 이전 프로젝트가 없으므로 창 자리를 저장하지 않는다.
  const resumed = begun === id;
  await keep();
  if (!resumed) await saveGeometry();
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

/**
 * Removes the project id from the registry. The window that shows the project asks for each modified tab first
 * (docs/spec/plugins.md#tab-reports). Resolves false when a kept tab keeps the project.
 */
export async function close(id) {
  // The window that shows the project asks here; another window shows it, the host asks that window.
  const asked = id === activeProjectId && !browsing ? await listener.settleTabs() : await windows.askRemoveProject(id);
  if (!asked) return false;
  // 아래의 정리는 저장된 레이아웃의 탭을 남긴다. 활성 프로젝트의 판에 아직 저장하지 않은 탭이 있으면 그 표면도 남도록
  // 먼저 저장한다.
  await keep();
  await windows.releaseProject(id);
  owned.delete(id);
  await store.remove(id);
  // 지운 프로젝트를 끝내는 일은 다른 창과 같은 readProjects 가 한다. 저장소의 바뀜 알림이 이 refresh 보다 먼저 읽었으면
  // 그 알림의 reread 가 다음 프로젝트를 연다. 그 활성화도 같은 전환 순서를 지나므로 아래의 activate 는 그 뒤에 끝난다.
  await refresh();
  if (active() && !browsing) listener.update();
  if (!active()) {
    const next = local()[0];
    if (next) await activate(next.id);
  }
  return true;
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
  checkSpace(project, space.id);
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
  if (next) checkSpace(project, next.id);
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
  // A modified tab that the person keeps keeps the window open (docs/spec/plugins.md#tab-reports).
  if (!(await listener.settleTabs())) {
    await windows.closeKept();
    return;
  }
  await flush();
  await windows.close();
}
