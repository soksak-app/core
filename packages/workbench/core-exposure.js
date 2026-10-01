// 코어의 공개 항목. exposure.json 이 선언한 status, command, dom 을 등록소에 등록한다.
//
// 값은 모듈이 가진 상태와 문서의 요소에서 읽는다. 임의 코드를 실행하는 항목은 없다.
//
// status 의 변경은 coreChanged() 호출로 알린다. 문서가 판의 렌더, 프로젝트와 설정의
// 변경, 모달과 라이브러리의 그리기 뒤에 호출하고, 등록소는 감시 중인 값 중 달라진
// 것만 호스트에 보낸다.
import { registry, connectExposure, revisitRegistrations } from "./exposure.js";
import { report } from "./host.js";
import { trace } from "./performance.js";
import { focusName, focusState } from "./focus-state.js";
import { EXPOSURE_ERRORS, ExposureError } from "@soksak/plugin-api";
import * as projects from "./projects.js";
import {
  activeTab, addTabTo, assignSidebar, capture, cardActs, cardTextSizes, changeTextSize, closeCard, closePicker, closeTabById,
  currentGrid, currentTextScope, dragState, focusCard, foldSidebar,
  focused, fresh, fullscreenCard, moveTab, presentedCardRect, toggleCardFullscreen, onPicker, onSurfaceState, openCardMenu, openCardTabs, pickItem, pickerState, plane, railState, selectTab,
  cardSidebars, resizeSidebar, settle, splitCard, surfaceState, tabsOf,
} from "./plane.js";
import {
  applyTheme, defaults, link, onSaved, overridden, reset, saving, scopedValue, set, settingProject, THEMES, value,
} from "./settings.js";
import {
  closeSettings, editSet, moveSettings, onSettingsDrawn, openSettings, settingsModalState, searchPlugins, showPlugin, showScope, showSection,
} from "./settings-ui.js";
import { changeRow, createSet, deleteSet, updateSet } from "./sidebar-sets.js";
import { pluginUnits } from "./environment.js";
import { latest, seated } from "./compositor.js";
import { modalState, onFilesDropped, onModalState } from "./host.js";
import { plugin } from "./registry.js";
import { systemNotifications } from "./system-notifications.js";
import { windows } from "@soksak/runtime";
import { audit, onBinding } from "./commands.js";
import { onTextScope } from "./text-size.js";
import { foldSection, onSectionsChange, selectSection, sidebarsState } from "./sidebar-sections.js";
import { onTabReports, tabLabel, tabNotice } from "./tab-reports.js";

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

/* 마지막으로 창에 놓인 파일과 그 처리 결과. docs/spec/native-surfaces.md 의 core.drop 이다. */
let lastDrop = null;

/**
 * 창에 놓인 파일을 그 점의 DOM 요소가 속한 표면에 넘긴다. 네이티브 뷰는 DOM 위에 놓였으므로 표면은 DOM 으로
 * 찾고, 그 표면의 플러그인이 선언한 놓기 명령을 그 표면에서 실행한다.
 */
async function dropFiles(payload) {
  const record = { urls: null, x: null, y: null, surface: null, command: null, error: null };
  try {
    // 호스트는 네이티브 놓기 뷰가 만든 JSON 문자열을 그대로 보낸다.
    const { urls, x, y } = JSON.parse(payload);
    Object.assign(record, { urls, x, y });
    if (!Array.isArray(urls) || urls.length === 0 || urls.some((url) => typeof url !== "string") ||
      !Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error("the application sent an invalid file drop");
    }
    const slot = document.elementFromPoint(x, y)?.closest("[data-native-surface-id][data-native-surface]");
    if (!slot) throw new Error("no surface is under the drop point");
    record.surface = slot.dataset.nativeSurfaceId;
    const command = plugin(slot.dataset.nativePlugin).drop;
    if (!command) throw new Error(`plugin ${slot.dataset.nativePlugin} declares no drop command`);
    record.command = command;
    const reply = await registry.handle({ method: "command.run", params: { name: command, params: { urls }, surface: record.surface } });
    if (reply.error) throw new Error(reply.error.message);
  } catch (error) {
    record.error = error.message;
  }
  lastDrop = record;
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
  // 기본값: 판을 만들기 전에는 카드가 없다.
  for (const card of currentGrid()?.cards ?? []) {
    const tab = tabsOf(card).find((t) => t.id === surface);
    if (tab) return tab.plugin;
  }
  for (const project of projects.local()) {
    for (const space of project.spaces) {
      for (const card of space.layout.state.cards) {
        // 기본값: 자리 카드는 data 가 null 이므로 탭이 없다.
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
  // 기본값: 아직 합성을 보고하지 않은 창에는 보이는 표면이 없다.
  const visible = (latest()?.surfaces ?? []).filter((s) => s.visible).map((s) => s.id);
  return [first, ...visible].filter(Boolean);
}

function gridState() {
  const grid = currentGrid();
  if (!grid) return null;
  const rects = grid.rects();
  const fullscreen = fullscreenCard();
  let pane = 0;
  const cards = [...plane.querySelectorAll(".card[data-card-id]")].map((el) => {
    const card = grid.card(el.dataset.cardId);
    if (!card) return null;
    const rect = fullscreen === null ? rects.get(card.id) : presentedCardRect(card.id);
    const tabs = tabsOf(card);
    return {
      fullscreen: card.id === fullscreen,
      id: card.id, x: rect.x, y: rect.y, w: rect.w, h: rect.h,
      c0: card.c0, c1: card.c1, r0: card.r0, r1: card.r1,
      // 기본값: px 폭을 정하지 않은 카드는 width 가 null 이다.
      fixed: Boolean(card.fixed), width: card.width ?? null, focused: card.id === focused(),
      pane: el.querySelector(".chrome__acts") ? pane++ : null,
      tabs: tabs.map(({ id, plugin, title }) => ({ id, plugin, title, label: tabLabel(id), notice: tabNotice(id) })),
      active: tabs.length ? activeTab(card).id : null,
      acts: cardActs(card.id),
      sidebars: cardSidebars(card, presentedCardRect(card.id)),
    };
  }).filter(Boolean);
  const lines = (axis) => grid.lines(axis).map((_, k) => grid.boundaryPos(axis, k));
  return {
    fullscreen,
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
    exposes: registry.namesOf(s.id), status: surfaceState(s.id),
  }));
}

const withOpen = (project) => ({ ...project, open: projects.isOpen(project.id) });

/** 키보드 초점이 있는 요소의 공개 이름과 순서. 공개 이름이 없으면 null 이다. */
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
  // 기본값: scope 는 선택 매개변수이며 생략하면 전역 범위다(exposure.json 의 core.settings.change).
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
export async function installCoreExposure({ library, renames, chrome, drawn }) {
  status("core.window.document", () => ({
    timeOrigin: performance.timeOrigin,
    readyState: document.readyState,
    visibility: document.visibilityState,
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
  // WebKit 이 문서를 숨기면 animation frame 이 멈추므로 표시 상태의 변화를 알린다.
  document.addEventListener("visibilitychange", coreChanged);
  onBinding(coreChanged);
  // 기본값: 오류를 보이지 않는 문서의 core.page.error 는 null 이다(exposure.json).
  status("core.page.error", () => document.getElementById("applicationError")?.textContent ?? null);
  status("core.projects", () => projects.all().map(withOpen));
  status("core.project", () => {
    const project = projects.active();
    return project && !projects.inLibrary() ? withOpen(project) : null;
  });
  status("core.layout", () => (currentGrid() ? capture() : null));
  status("core.grid", gridState);
  status("core.sidebars", sidebarsState);
  onSectionsChange(coreChanged);
  onTabReports(coreChanged);
  status("core.surfaces", surfacesState);
  status("core.drop", () => lastDrop);
  status("core.notifications", () => systemNotifications.state());
  systemNotifications.onChange(coreChanged);
  onFilesDropped((drop) => { dropFiles(drop).then(coreChanged); });
  status("core.settings", () => ({
    values: Object.fromEntries(Object.keys(defaults).map((key) => [key, value(key)])),
    project: settingProject(),
    overridden: Object.keys(defaults).filter(overridden),
    saving: saving(),
  }));
  status("core.themes", () => THEMES);
  status("core.settings-modal", settingsModalState);
  status("core.picker", pickerState);
  status("core.library", () => library.state());
  status("core.verify", () => verified);
  status("core.modal", modalState);
  status("core.drag", dragState);
  status("core.rename", renames.state);
  status("core.focus", () => focusState(document));
  // 문서 포커스 전이 관측(V5-114). 터미널 영역은 클릭 투명이라 누르면 문서가 포커스를 되찾고, activeElement 로
  // 남아 있던 주소창이 그 순간 포커스를 받아 보일 수 있다. 전이마다 성능 트레이스와 진단 로그에 한 줄을 남기고
  // core.focus 를 알린다. 표면의 요소는 shadow root 안에 있으므로 사건의 실제 대상에서 이름을 읽는다.
  document.addEventListener("focusin", (event) => {
    trace("focus", { phase: "in", element: focusName(event) });
    report(`focus in ${focusName(event)}`);
    coreChanged();
  }, true);
  document.addEventListener("focusout", (event) => {
    trace("focus", { phase: "out", element: focusName(event) });
    report(`focus out ${focusName(event)}`);
    coreChanged();
  }, true);
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
    // 기본값: mode 를 생략하면 현재 모드, scope 를 생략하면 전역 범위다(exposure.json 의 core.settings.theme).
    await applyTheme(name, mode ?? scopedValue("mode", scope ?? "common"), scope);
  });
  // 사이드바 선택과 세트 변경의 거부는 잘못된 요청 인자다(docs/spec/settings.md).
  const invalid = (run) => async (params) => {
    try {
      return await run(params);
    } catch (error) {
      throw new ExposureError(EXPOSURE_ERRORS.invalidParams, error.message);
    }
  };
  registry.command("core.settings.link", invalid(async ({ place, plugin = null, set: choice, scope = "common" }) => {
    if (choice !== "off" && choice !== "inherit" && !scopedValue("sets", scope).some((s) => s.id === choice)) {
      throw new Error(`unknown set ${choice}`);
    }
    await link(place, plugin, choice, scope);
  }));
  registry.command("core.settings.sets.create", async ({ scope = "common" }) => {
    const sets = createSet(scopedValue("sets", scope));
    const { id } = sets.at(-1);
    await set({ sets }, scope);
    if (settingsModalState().open) editSet(id);
    return { id };
  });
  registry.command("core.settings.sets.update", invalid(async ({ id, title, layout, scope = "common" }) => {
    const change = Object.fromEntries(Object.entries({ title, layout }).filter(([, v]) => v !== undefined));
    await set({ sets: updateSet(scopedValue("sets", scope), id, change) }, scope);
  }));
  registry.command("core.settings.sets.row", invalid(async ({ id, action, index, section: sectionId, scope = "common" }) => {
    const registered = pluginUnits().flatMap((u) => u.sections);
    await set({ sets: changeRow(scopedValue("sets", scope), id, { action, index, section: sectionId }, registered) }, scope);
  }));
  registry.command("core.settings.sets.delete", async ({ id, scope = "common" }) => {
    await set(deleteSet(scopedValue("sets", scope), scopedValue("links", scope), id), scope);
  });
  registry.command("core.settings.open", () => { openSettings(); });
  registry.command("core.settings.close", () => { closeSettings(); });
  registry.command("core.projects.browse", async () => { await projects.browse(); });
  registry.command("core.projects.flush", async () => { await projects.flush(); });
  registry.command("core.project.open", ({ root, color = "#ffb36b" }) => {
    // 창 크기는 아래 등록된 resize 마커가, 프로젝트 열기는 여기가 담당한다(V5-104).
    trace("action", { kind: "project.open", root });
    return projects.open({ root, color, layout: fresh() });
  });
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
  registry.command("core.settings-modal.plugin", ({ plugin: id = null }) => { showPlugin(id); });
  registry.command("core.settings-modal.search", ({ query }) => { searchPlugins(query); });
  registry.command("core.settings-modal.edit", ({ set: id = null }) => { editSet(id); });
  registry.command("core.settings-modal.move", ({ dx, dy }) => { moveSettings(dx, dy); });

  registry.command("core.card.focus", ({ card }) => { trace("action", { kind: "card.focus", card }); focusCard(card); });
  registry.command("core.card.sidebar.set", ({ card, side, set }) => { assignSidebar(card, side, set); });
  registry.command("core.card.sidebar.toggle", ({ card, side }) => { foldSidebar(card, side); });
  registry.command("core.card.sidebar.size", ({ card, side, size }) => { resizeSidebar(card, side, size); });
  registry.command("core.sidebar.section.select", ({ sidebar, section }) => { selectSection(sidebar, section); });
  registry.command("core.sidebar.section.fold", ({ sidebar, section }) => { foldSection(sidebar, section); });
  registry.command("core.text.larger", async () => { await changeTextSize(1); });
  registry.command("core.text.smaller", async () => { await changeTextSize(-1); });
  registry.command("core.text.reset", async () => { await changeTextSize(0); });
  registry.command("core.card.fullscreen", ({ card }) => { toggleCardFullscreen(card); });
  registry.command("core.card.menu", ({ card, menu }) => { openCardMenu(card, menu); });
  registry.command("core.card.tab-list", ({ card }) => { openCardTabs(card); });
  registry.command("core.card.add-tab", ({ card, plugin }) => ({ tab: addTabTo(card, plugin) }));
  registry.command("core.card.split", ({ card, axis, plugin }) => splitCard(card, axis, plugin));
  registry.command("core.card.close", ({ card }) => { closeCard(card); });
  registry.command("core.tab.select", ({ tab }) => { trace("action", { kind: "tab.select", tab }); selectTab(tab); });
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
  onSurfaceState(coreChanged);
  onSettingsDrawn(coreChanged);
  onModalState(coreChanged);
  onSaved(coreChanged);

  await connectExposure({ surfacePlugin, preferred, registrationChanged: coreChanged, settled: drawn });
}

// 창 크기 변화의 행위 마커(V5-104). 로그의 닻 — 무엇을 했을 때 무엇이 일어났나.
addEventListener("resize", () => {
  trace("action", { kind: "resize", width: innerWidth, height: innerHeight });
});
