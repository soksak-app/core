// 코어의 공개 항목. exposure.json 이 선언한 status, command, dom 을 등록소에 등록한다.
//
// 값은 모듈이 가진 상태와 문서의 요소에서 읽는다. 임의 코드를 실행하는 항목은 없다.
//
// status 의 변경은 coreChanged() 호출로 알린다. 문서가 판의 렌더, 프로젝트와 설정의
// 변경, 모달과 라이브러리의 그리기 뒤에 호출하고, 등록소는 감시 중인 값 중 달라진
// 것만 호스트에 보낸다.
import { registry, connectExposure } from "./exposure.js";
import * as projects from "./projects.js";
import {
  activeTab, capture, currentGrid, focused, fresh, onPicker, pickerState, plane, settle, tabsOf,
} from "./plane.js";
import { defaults, overridden, reset, set, settingProject, value } from "./settings.js";
import { closeSettings, onSettingsDrawn, openSettings, settingsModalState } from "./settings-ui.js";
import { latest, seated } from "./compositor.js";
import { windows } from "@soksak/runtime";

/* 감시 중인 코어 status 의 수신자. */
const watchers = new Set();
let scheduled = false;

/**
 * 코어 상태가 바뀌었을 수 있음을 알린다. 같은 작업 안의 여러 호출은 한 번으로 묶는다.
 */
export function coreChanged() {
  if (scheduled || watchers.size === 0) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    for (const run of watchers) run();
  });
}

/** 코어 status 하나를 등록한다. 값은 coreChanged 가 호출될 때 다시 읽는다. */
function status(name, read) {
  registry.status(name, read, (fn) => {
    const run = () => fn(read());
    watchers.add(run);
    return () => watchers.delete(run);
  });
}

let verified = null;

/** 마지막 검증 결과를 기록한다. */
export function setVerify(rows) {
  verified = { failed: rows.filter((row) => !row.ok).length, rows };
  coreChanged();
}

const planeOrigin = () => {
  const r = plane.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
};

const shift = (rect, origin) => ({ x: rect.x + origin.x, y: rect.y + origin.y, w: rect.w, h: rect.h });

/** 활성 공간의 탭과 저장된 공간의 탭에서 표면의 플러그인을 찾는다. */
function surfacePlugin(surface) {
  for (const card of currentGrid()?.cards ?? []) {
    const tab = tabsOf(card).find((t) => t.id === surface);
    if (tab) return tab.plugin;
  }
  for (const project of projects.local()) {
    for (const space of project.spaces) {
      for (const card of space.layout.state.cards) {
        const tab = (card.data?.tabs ?? []).find((t) => t.id === surface);
        if (tab) return tab.plugin;
      }
    }
  }
  return null;
}

/** 요청을 받을 표면의 순서. 포커스된 카드의 탭, 그 다음 보이는 표면이다. */
function preferred() {
  const grid = currentGrid();
  const card = grid && focused() ? grid.card(focused()) : null;
  const first = card ? activeTab(card)?.id : null;
  const visible = (latest()?.surfaces ?? []).filter((s) => s.visible).map((s) => s.id);
  return [first, ...visible].filter(Boolean);
}

/** 표면 문서의 원점. 호스트가 실제로 앉힌 자리를 창 좌표로 바꾼다. */
function origin(surface) {
  const placed = seated()?.surfaces.find((s) => s.id === surface);
  if (!placed) return null;
  const at = planeOrigin();
  return { x: placed.applied.x + at.x, y: placed.applied.y + at.y };
}

function gridState() {
  const grid = currentGrid();
  if (!grid) return null;
  const rects = grid.rects();
  let pane = 0;
  const cards = [...plane.querySelectorAll(".card[data-card-id]")].map((el) => {
    const card = grid.card(el.dataset.cardId);
    if (!card) return null;
    const rect = rects.get(card.id);
    const tabs = tabsOf(card);
    return {
      id: card.id, x: rect.x, y: rect.y, w: rect.w, h: rect.h,
      c0: card.c0, c1: card.c1, r0: card.r0, r1: card.r1,
      fixed: Boolean(card.fixed), width: card.width ?? null, focused: card.id === focused(),
      pane: el.querySelector(".chrome__acts") ? pane++ : null,
      tabs: tabs.map(({ id, plugin, title }) => ({ id, plugin, title })),
      active: tabs.length ? activeTab(card).id : null,
    };
  }).filter(Boolean);
  const lines = (axis) => grid.lines(axis).map((_, k) => grid.boundaryPos(axis, k));
  return {
    width: grid.width, height: grid.height, gap: grid.gap, plane: planeOrigin(),
    lines: { x: lines("x"), y: lines("y") }, cards,
  };
}

function surfacesState() {
  const record = seated();
  if (!record) return [];
  const at = planeOrigin();
  return record.surfaces.map((s) => ({
    surface: s.id, plugin: s.plugin, visible: s.visible, dim: s.dim,
    declared: shift(s.declared, at), applied: shift(s.applied, at),
    exposes: registry.namesOf(s.id),
  }));
}

const withOpen = (project) => ({ ...project, open: projects.isOpen(project.id) });

function need(project, id) {
  if (!project) throw new Error(`Unknown project: ${id}`);
  return project;
}

/**
 * 코어 항목을 등록하고 등록소를 호스트에 연결한다.
 *
 *   library  createLibrary 의 반환값
 */
export async function installCoreExposure({ library }) {
  status("core.window.document", () => ({
    timeOrigin: performance.timeOrigin,
    readyState: document.readyState,
    scheme: document.documentElement.style.colorScheme,
    background: window.__soksakBackground === true,
    scale: devicePixelRatio,
    width: innerWidth,
    height: innerHeight,
  }));
  status("core.screen", () => ({
    screen: document.body.dataset.screen,
    modal: settingsModalState().open ? "settings" : pickerState().open ? "picker" : null,
  }));
  status("core.page.error", () => document.getElementById("applicationError")?.textContent ?? null);
  status("core.projects", () => projects.all().map(withOpen));
  status("core.project", () => {
    const project = projects.active();
    return project && !projects.inLibrary() ? withOpen(project) : null;
  });
  status("core.layout", () => (currentGrid() ? capture() : null));
  status("core.grid", gridState);
  status("core.surfaces", surfacesState);
  status("core.settings", () => ({
    values: Object.fromEntries(Object.keys(defaults).map((key) => [key, value(key)])),
    project: settingProject(),
    overridden: Object.keys(defaults).filter(overridden),
  }));
  status("core.settings-modal", settingsModalState);
  status("core.picker", pickerState);
  status("core.library", () => library.state());
  status("core.verify", () => verified);

  registry.command("core.settings.set", async ({ patch, scope }) => { await set(patch, scope); });
  registry.command("core.settings.reset", async ({ key }) => { await reset(key); });
  registry.command("core.settings.open", () => { openSettings(); });
  registry.command("core.settings.close", () => { closeSettings(); });
  registry.command("core.projects.browse", async () => { await projects.browse(); });
  registry.command("core.projects.flush", async () => { await projects.flush(); });
  registry.command("core.project.open", ({ root, color = "#ffb36b" }) =>
    projects.open({ root, color, layout: fresh() }));
  registry.command("core.project.activate", async ({ id }) => { await projects.activate(id); });
  registry.command("core.project.close", async ({ id }) => {
    need(projects.all().find((p) => p.id === id), id);
    await projects.close(id);
  });
  registry.command("core.project.rename", async ({ id, title }) => { await projects.rename(id, title); });
  registry.command("core.project.move", async ({ id, delta }) => { await projects.move(id, delta); });
  registry.command("core.project.pin", async ({ id, pinned }) => { await projects.pin(id, pinned); });
  registry.command("core.window.new", async () => { await projects.newWindow(); });
  registry.command("core.folder.create", ({ parent, name }) => windows.createFolder({ parent, name }));
  registry.command("core.space.add", () => {
    need(projects.active(), "active");
    const { id, title } = projects.addSpace(fresh());
    return { id, title };
  });
  registry.command("core.space.activate", ({ id }) => { projects.activateSpace(id); });
  registry.command("core.space.rename", ({ id, title }) => { projects.renameSpace(id, title); });
  registry.command("core.space.close", ({ id }) => { projects.closeSpace(id); });
  registry.command("core.grid.size", ({ card, axis, size }) => {
    const grid = currentGrid();
    if (!grid?.setSize(card, axis, size)) throw new Error(`cannot size ${card} on ${axis}`);
    settle();
  });
  registry.command("core.boundary.move", ({ axis, line, position }) => {
    const grid = currentGrid();
    if (!grid?.hasBoundary(axis, line)) throw new Error(`no ${axis} boundary at line ${line}`);
    const moved = grid.moveBoundary(axis, line, position, false);
    settle();
    return { position: moved };
  });

  for (const { name } of registry.list().dom) {
    if (name.startsWith("core.")) registry.dom(name);
  }

  onPicker(coreChanged);
  onSettingsDrawn(coreChanged);

  await connectExposure({ surfacePlugin, preferred, origin });
}
