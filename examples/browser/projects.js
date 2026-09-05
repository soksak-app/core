// 프로젝트와 스페이스.
//
//   프로젝트  루트 하나에 대응한다. 스페이스 목록과 이름과 색을 갖는다
//     └ 스페이스  판 한 벌. 배치와 포커스를 갖고 탭으로 전환한다
//
// 정체성은 root 다. 같은 root 를 다시 열면 새로 만들지 않고 기존 프로젝트를
// 활성화한다. id 로 판정하면 중복 여부를 알 수 없다.
//
// 스페이스가 보관하는 layout 값을 이 모듈은 해석하지 않는다. 판에서 읽어 오고 판에
// 적용하는 것은 onSwitch 로 등록된 두 함수다.
import { issueId } from "./ids.js";

const projects = [];
let activeProjectId = null;

/* 활성 스페이스 전환 수신자. 판이 여기에 연결된다. */
let listener = null;

/**
 * 활성 스페이스 전환 직전과 직후에 호출할 함수를 등록한다.
 *
 * `save` 는 현재 판의 배치를 반환하고 `load` 는 그 값을 판에 적용한다. 프로젝트
 * 전환과 스페이스 전환이 같은 동작이므로 경로가 하나다.
 */
export function onSwitch({ save, load }) {
  listener = { save, load };
}

/** 현재 판의 배치를 활성 스페이스에 저장한다. */
function keep() {
  const space = activeSpace();
  if (space && listener) space.layout = listener.save();
}

/** 활성 스페이스의 배치를 판에 적용한다. */
function restore() {
  const space = activeSpace();
  if (space && listener) listener.load(space.layout);
}

/** 열린 프로젝트 전부를 반환한다. */
export const all = () => projects;

/** 활성 프로젝트를 반환한다. 없으면 null. */
export const active = () => projects.find((p) => p.id === activeProjectId) ?? null;

/** 활성 스페이스를 반환한다. 활성 프로젝트가 없으면 null. */
function activeSpace() {
  const p = active();
  return p ? p.spaces.find((s) => s.id === p.activeSpaceId) : null;
}

/** 스페이스 하나를 만든다. 배치는 호출자가 전달한다. */
function newSpace(n, layout) {
  return { id: issueId("space"), title: `SPACE${n}`, layout };
}

/**
 * 해당 루트의 프로젝트를 연다.
 *
 * 이미 열려 있으면 새로 만들지 않고 활성화한다. 루트 하나에 프로젝트 하나다.
 */
export function open({ root, color, layout }) {
  const already = projects.find((p) => p.root === root);
  if (already) {
    activate(already.id);
    return already;
  }
  keep();
  const space = newSpace(1, layout);
  const project = {
    // 이름은 사람이 정하기 전까지 번호다. 루트의 마지막 조각을 쓰면 서로 다른
    // 루트가 같은 이름을 갖고, 그 이름이 무엇을 세는지도 알 수 없다.
    id: issueId("project"), root, title: `PROJECT${projects.length + 1}`, color,
    spaces: [space], activeSpaceId: space.id,
  };
  projects.push(project);
  activeProjectId = project.id;
  restore();
  return project;
}

/** 활성 프로젝트를 전환한다. 스페이스 목록 전체가 교체된다. */
export function activate(id) {
  if (id === activeProjectId) return;
  const found = projects.find((p) => p.id === id);
  if (!found) throw new Error(`unknown project: ${id}`);
  keep();
  activeProjectId = id;
  restore();
}

/** 프로젝트를 닫는다. 마지막 하나는 닫지 않는다. */
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

/** 이름과 색을 변경한다. root 는 정체성이므로 변경하지 않는다. */
export function rename(id, { title, color }) {
  const found = projects.find((p) => p.id === id);
  if (!found) throw new Error(`unknown project: ${id}`);
  if (title !== undefined) found.title = title;
  if (color !== undefined) found.color = color;
}

/** 활성 프로젝트에 스페이스를 추가하고 활성화한다. */
export function addSpace(layout) {
  const project = active();
  keep();
  const space = newSpace(project.spaces.length + 1, layout);
  project.spaces.push(space);
  project.activeSpaceId = space.id;
  restore();
  return space;
}

/** 활성 스페이스를 전환한다. 판의 배치 전체가 교체된다. */
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

/** 스페이스의 이름을 변경한다. */
export function renameSpace(id, title) {
  const space = active().spaces.find((s) => s.id === id);
  if (!space) throw new Error(`unknown space: ${id}`);
  space.title = title;
}
