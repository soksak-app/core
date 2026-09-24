// 코어의 공개 항목. exposure.json 이 선언한 status, command, dom 을 등록소에 등록한다.
//
// 값은 모듈이 가진 상태와 문서의 요소에서 읽는다. 임의 코드를 실행하는 항목은 없다.
//
// status 의 변경은 coreChanged() 호출로 알린다. 문서가 판의 렌더, 프로젝트와 설정의
// 변경, 모달과 라이브러리의 그리기 뒤에 호출하고, 등록소는 감시 중인 값 중 달라진
// 것만 호스트에 보낸다.
import { registry, connectExposure, revisitRegistrations } from "./exposure.js";
import { EXPOSURE_ERRORS, ExposureError } from "@soksak/plugin-api";
import * as projects from "./projects.js";
import {
  activeTab, addTabTo, capture, cardActs, cardTextSizes, changeTextSize, closeCard, closePicker, closeTabById,
  currentGrid, currentTextScope, dragState, focusCard,
  focused, fresh, moveTab, onPicker, openCardMenu, openCardTabs, pickItem, pickerState, plane, railState, selectTab,
  settle, splitCard, tabsOf,
} from "./plane.js";
import {
  applyTheme, defaults, link, onSaved, overridden, reset, saving, scopedValue, set, settingProject, value,
} from "./settings.js";
import {
  closeSettings, moveSettings, onSettingsDrawn, openSettings, settingsModalState, showScope, showSection,
} from "./settings-ui.js";
import { latest, seated } from "./compositor.js";
import { modalState, onModalState } from "./host.js";
import { windows } from "@soksak/runtime";
import { audit, onBinding } from "./commands.js";
import { onTextScope } from "./text-size.js";
import { onTabReports, tabLabel } from "./tab-reports.js";

/* 감시 중인 코어 status 의 수신자. */
const watchers = new Set();
let scheduled = false;

/**
 * 코어 상태가 바뀌었을 수 있음을 알린다. 같은 작업 안의 여러 호출은 한 번으로 묶는다.
 */
export function coreChanged() {
  revisitRegistrations();
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
      tabs: tabs.map(({ id, plugin, title }) => ({ id, plugin, title, label: tabLabel(id) })),
      active: tabs.length ? activeTab(card).id : null,
      acts: cardActs(card.id),
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

/** 키보드 초점이 있는 요소의 공개 이름과 순서. 공개 이름이 없으면 null 이다. */
function focusState() {
  const el = document.activeElement?.closest?.("[data-expose]");
  if (!el || el === document.body) return null;
  const name = el.dataset.expose;
  return { name, index: [...document.querySelectorAll(`[data-expose="${name}"]`)].indexOf(el) };
}

/** 공개 이름의 요소에 키보드 초점을 준다. */
function focusElement(name, index = 0) {
  if (!registry.list().dom.some((entry) => entry.name === name)) throw new Error(`unknown dom ${name}`);
  const el = document.querySelectorAll(`[data-expose="${name}"]`)[index];
  if (!el) throw new Error(`dom ${name} has no element at index ${index}`);
  el.focus();
}

/** 설정 하나를 입력 값으로 바꾼다. 컨트롤은 문자열을 주므로 현재 값의 타입으로 변환한다. */
function changeSetting(key, input, scope) {
  if (!Object.hasOwn(defaults, key)) throw new Error(`Unknown setting: ${key}`);
  const now = scopedValue(key, scope ?? "common");
  const next = typeof now === "boolean" ? input === true || input === "true"
    : typeof now === "number" ? Number(input) : String(input);
  if (typeof now === "number" && !Number.isFinite(next)) throw new Error(`${key} requires a number`);
  return set({ [key]: next }, scope);
}

function need(project, id) {
  if (!project) throw new Error(`Unknown project: ${id}`);
  return project;
}

/**
 * 코어 항목을 등록하고 등록소를 호스트에 연결한다.
 *
 *   library  createLibrary 의 반환값
 */
/**
 * drawn 은 판이 예약된 그리기를 모두 마치면 이행되는 promise 를 반환한다. 코어 명령은 실행 뒤 그
 * 그리기를 기다린 다음 답한다. 명령이 배치를 바꾸면 답을 받은 쪽은 이미 그려진 배치를 읽는다.
 */
export async function installCoreExposure({ library, renames, resetLayout, chrome, drawn }) {
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
  status("core.page.audit", () => ({ unbound: audit(document.body) }));
  onBinding(coreChanged);
  status("core.page.error", () => document.getElementById("applicationError")?.textContent ?? null);
  status("core.projects", () => projects.all().map(withOpen));
  status("core.project", () => {
    const project = projects.active();
    return project && !projects.inLibrary() ? withOpen(project) : null;
  });
  status("core.layout", () => (currentGrid() ? capture() : null));
  status("core.grid", gridState);
  onTabReports(coreChanged);
  status("core.surfaces", surfacesState);
  status("core.settings", () => ({
    values: Object.fromEntries(Object.keys(defaults).map((key) => [key, value(key)])),
    project: settingProject(),
    overridden: Object.keys(defaults).filter(overridden),
    saving: saving(),
  }));
  status("core.settings-modal", settingsModalState);
  status("core.picker", pickerState);
  status("core.library", () => library.state());
  status("core.verify", () => verified);
  status("core.modal", modalState);
  status("core.drag", dragState);
  status("core.rename", renames.state);
  status("core.focus", focusState);
  status("core.text", () => ({ scope: currentTextScope(), frame: value("textSize"), cards: cardTextSizes() }));
  onTextScope(() => coreChanged());
  status("core.chrome", chrome);
  status("core.rail", () => (currentGrid() ? railState() : null));

  registry.command("core.settings.set", async ({ patch, scope }) => {
    try {
      await set(patch, scope);
    } catch (error) {
      throw new ExposureError(EXPOSURE_ERRORS.invalidParams, error.message);
    }
  });
  registry.command("core.settings.reset", async ({ key }) => { await reset(key); });
  registry.command("core.settings.change", async ({ key, value: input, scope }) => {
    await changeSetting(key, input, scope);
  });
  registry.command("core.settings.theme", async ({ name, mode, scope }) => {
    await applyTheme(name, mode ?? scopedValue("mode", scope ?? "common"), scope);
  });
  registry.command("core.settings.link", async ({ place, plugin = null, set: setId, scope }) => {
    if (!["left", "right", "rail"].includes(place)) throw new Error(`unknown place ${place}`);
    const id = setId === "" || setId === undefined ? null : setId;
    if (id !== null && !value("sets").some((s) => s.id === id)) throw new Error(`unknown set ${id}`);
    await link(place, plugin, id, scope);
  });
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
  registry.command("core.settings-modal.nav", ({ section }) => { showSection(section); });
  registry.command("core.settings-modal.scope", ({ scope }) => { showScope(scope); });
  registry.command("core.settings-modal.move", ({ dx, dy }) => { moveSettings(dx, dy); });
  registry.command("core.layout.reset", () => { resetLayout(); });

  registry.command("core.card.focus", ({ card }) => { focusCard(card); });
  registry.command("core.text.larger", async () => { await changeTextSize(1); });
  registry.command("core.text.smaller", async () => { await changeTextSize(-1); });
  registry.command("core.text.reset", async () => { await changeTextSize(0); });
  registry.command("core.card.menu", ({ card, menu }) => { openCardMenu(card, menu); });
  registry.command("core.card.tab-list", ({ card }) => { openCardTabs(card); });
  registry.command("core.card.add-tab", ({ card, plugin }) => ({ tab: addTabTo(card, plugin) }));
  registry.command("core.card.split", ({ card, axis, plugin }) => splitCard(card, axis, plugin));
  registry.command("core.card.close", ({ card }) => { closeCard(card); });
  registry.command("core.tab.select", ({ tab }) => { selectTab(tab); });
  registry.command("core.tab.close", ({ tab }) => { closeTabById(tab); });
  registry.command("core.tab.move", ({ tab, card, zone }) => { moveTab(tab, card, zone); });
  registry.command("core.picker.pick", ({ index }) => { pickItem(index); });
  registry.command("core.picker.close", () => { closePicker(); });

  registry.command("core.library.search", ({ query }) => { library.actions.search(query); });
  registry.command("core.library.sort", ({ order }) => { library.actions.sort(order); });
  registry.command("core.library.open", async ({ id }) => { await library.actions.open(id); });
  registry.command("core.library.pin", async ({ id, pinned }) => { await library.actions.pin(id, pinned); });
  registry.command("core.library.window", async () => { await library.actions.newWindow(); });
  registry.command("core.library.return", async () => { await library.actions.back(); });
  registry.command("core.library.form.open", ({ mode }) => { library.actions.openForm(mode); });
  registry.command("core.library.form.cancel", () => { library.actions.cancelForm(); });
  registry.command("core.library.form.set", ({ field, value: input }) => { library.actions.setField(field, input); });
  registry.command("core.library.form.submit", async () => { await library.actions.submitForm(); });
  registry.command("core.library.choose-folder", async () => { await library.actions.chooseFolder(); });

  registry.command("core.rename.begin", ({ kind, id }) => { renames.begin({ kind, id }); });
  registry.command("core.rename.set", ({ value: input }) => { renames.set(input); });
  registry.command("core.rename.commit", async () => { await renames.commit(); });
  registry.command("core.rename.cancel", () => { renames.cancel(); });
  registry.command("core.focus.set", ({ name, index }) => { focusElement(name, index); });

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
  onModalState(coreChanged);
  onSaved(coreChanged);

  await connectExposure({ surfacePlugin, preferred, registrationChanged: coreChanged, settled: drawn });
}
