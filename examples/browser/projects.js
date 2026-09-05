// 프로젝트와 스페이스.
//
//   프로젝트  루트 하나를 연 것. 스페이스 묶음과 이름과 색을 갖는다
//     └ 스페이스  판 한 벌 — 배치와 포커스. 여러 개를 두고 탭으로 바꾼다
//
// 정체는 root 다. 같은 root 를 두 번 열면 새로 만들지 않고 이미 열린 것을
// 답한다 — id 로 판단했다면 "이 프로젝트가 이미 열려 있나"에 답할 수 없다.
//
// 판이 무엇인지 모른다. 스페이스가 담은 배치는 여기서 읽지 않는 값이고, 그것을
// 판에 걸고 다시 걷어 오는 일은 판이 한다.
import { issueId } from "./ids.js";

const projects = [];
let activeProjectId = null;

/* 활성 스페이스가 바뀌었음을 듣는 쪽. 판이 여기 붙는다. */
let listener = null;

/**
 * 활성 스페이스가 바뀌기 직전과 직후에 부를 것을 건다.
 *
 * `save` 는 지금 판을 걷어 돌려주고, `load` 는 그 값을 판에 건다. 프로젝트든
 * 스페이스든 바뀌는 것은 같은 일이므로 경로가 하나다.
 */
export function onSwitch({ save, load }) {
  listener = { save, load };
}

/** 지금 판을 걷어 활성 스페이스에 넣는다. */
function keep() {
  const space = activeSpace();
  if (space && listener) space.layout = listener.save();
}

/** 활성 스페이스의 배치를 판에 건다. */
function restore() {
  const space = activeSpace();
  if (space && listener) listener.load(space.layout);
}

/** 열린 프로젝트 전부. */
export const all = () => projects;

/** 지금 보고 있는 프로젝트. 하나도 없으면 null. */
export const active = () => projects.find((p) => p.id === activeProjectId) ?? null;

/** 지금 보고 있는 스페이스. */
export function activeSpace() {
  const p = active();
  return p ? p.spaces.find((s) => s.id === p.activeSpaceId) : null;
}

/** 새 스페이스 하나. 배치는 부르는 쪽이 준다 — 판의 모양은 여기서 모른다. */
function newSpace(title, layout) {
  return { id: issueId("space"), title, layout };
}

/**
 * 그 루트의 프로젝트를 연다.
 *
 * 이미 열려 있으면 새로 만들지 않고 그것을 활성으로 한다. 한 루트는 한
 * 프로젝트다.
 */
export function open({ root, title, color, layout }) {
  const already = projects.find((p) => p.root === root);
  if (already) {
    activate(already.id);
    return already;
  }
  keep();
  const space = newSpace("1", layout);
  const project = {
    id: issueId("project"), root, title, color,
    spaces: [space], activeSpaceId: space.id,
  };
  projects.push(project);
  activeProjectId = project.id;
  restore();
  return project;
}

/** 프로젝트를 바꾼다. 스페이스 묶음이 통째로 바뀐다. */
export function activate(id) {
  if (id === activeProjectId) return;
  const found = projects.find((p) => p.id === id);
  if (!found) throw new Error(`unknown project: ${id}`);
  keep();
  activeProjectId = id;
  restore();
}

/** 프로젝트를 닫는다. 마지막 하나는 닫지 않는다 — 볼 것이 없어진다. */
export function close(id) {
  if (projects.length === 1) return;
  const at = projects.findIndex((p) => p.id === id);
  if (at < 0) throw new Error(`unknown project: ${id}`);
  const wasActive = id === activeProjectId;
  if (wasActive) keep();
  projects.splice(at, 1);
  if (!wasActive) return;
  activeProjectId = projects[Math.min(at, projects.length - 1)].id;
  restore();
}

/** 이름과 색을 고친다. root 는 정체이므로 바뀌지 않는다. */
export function rename(id, { title, color }) {
  const found = projects.find((p) => p.id === id);
  if (!found) throw new Error(`unknown project: ${id}`);
  if (title !== undefined) found.title = title;
  if (color !== undefined) found.color = color;
}

/** 활성 프로젝트에 스페이스를 더하고 그리로 옮긴다. */
export function addSpace(layout) {
  const project = active();
  keep();
  const space = newSpace(String(project.spaces.length + 1), layout);
  project.spaces.push(space);
  project.activeSpaceId = space.id;
  restore();
  return space;
}

/** 스페이스를 바꾼다. 판의 배치가 통째로 바뀐다. */
export function activateSpace(id) {
  const project = active();
  if (id === project.activeSpaceId) return;
  if (!project.spaces.some((s) => s.id === id)) throw new Error(`unknown space: ${id}`);
  keep();
  project.activeSpaceId = id;
  restore();
}

/** 스페이스를 닫는다. 마지막 하나는 닫지 않는다. */
export function closeSpace(id) {
  const project = active();
  if (project.spaces.length === 1) return;
  const at = project.spaces.findIndex((s) => s.id === id);
  if (at < 0) throw new Error(`unknown space: ${id}`);
  const wasActive = id === project.activeSpaceId;
  if (wasActive) keep();
  project.spaces.splice(at, 1);
  if (!wasActive) return;
  project.activeSpaceId = project.spaces[Math.min(at, project.spaces.length - 1)].id;
  restore();
}

/** 스페이스의 이름을 고친다. */
export function renameSpace(id, title) {
  const space = active().spaces.find((s) => s.id === id);
  if (!space) throw new Error(`unknown space: ${id}`);
  space.title = title;
}
