// 프로젝트 목록은 공유 저장소에, 활성 프로젝트와 창 소유권은 실행 중인 창에 저장한다.
import { issueId } from "./ids.js";
import { selectProject, value, flushSettings } from "./settings.js";
import { windows } from "@soksak/runtime";

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
  switching = done.catch(() => {});
  return done;
}

export function browse() {
  return inTurn(async () => {
    await flush();
    browsing = true;
    await listener.empty();
    await selectProject(null);
    changed();
  });
}
export const newWindow = () => windows.newWindow();
export const pin = (id, pinned) => store.patch(id, { pinned });
export function onSwitch(callbacks) { listener = callbacks; }
export function onChange(fn) { changed = fn; }

export async function initialise(storage) {
  store = storage;
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
  await selectProject(id);
  owned.add(id);
  activeProjectId = id;
  browsing = false;
  history.replaceState(null, "", `${location.pathname}?project=${encodeURIComponent(id)}`);
  changed();
  savedLayout = "";
  listener.load(project.spaces.find((s) => s.id === project.activeSpaceId).layout);
  changed();
}

export async function activate(id) {
  const project = projects.find((p) => p.id === id);
  if (!project) throw new Error(`Unknown project: ${id}`);
  await keep();
  await saveGeometry();
  const folder = await windows.folder(project.root);
  if (folder.identity !== project.identity) throw new Error(`Project directory has changed: ${project.root}`);
  const result = await windows.openProject({
    id, root: project.root, title: project.title, geometry: project.geometry ?? null,
    separate: value("projectOpening") === "windows", current: active() && !owned.has(id) ? activeProjectId : null,
  });
  await store.patch(id, { lastOpened: Date.now() });
  if (!result.local) { if (active()) await activateHere(activeProjectId); return; }
  await activateHere(id);
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
  if (!project.spaces.some((s) => s.id === id)) throw new Error(`Unknown space: ${id}`);
  keep();
  project.activeSpaceId = id;
  restore();
}

export function closeSpace(id) {
  const project = active();
  if (project.spaces.length === 1) return;
  const at = project.spaces.findIndex((s) => s.id === id);
  if (at < 0) throw new Error(`Unknown space: ${id}`);
  keep();
  project.spaces.splice(at, 1);
  if (id === project.activeSpaceId) project.activeSpaceId = project.spaces[Math.min(at, project.spaces.length - 1)].id;
  restore();
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
