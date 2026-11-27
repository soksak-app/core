// The settings tab of the window (docs/spec/settings.md). The tab is a tab of the main window: mountSettingsTab draws its content into the
// container that the tab strip gives it, and the tab keeps its page, its search, its plugin and its edited set while the window lives.
//
// The modules: settings-state.js (the state of the tab), settings-rows.js (the core rows), settings-controls.js (the standard controls and
// the scope marks), settings-pages.js, settings-sides.js, settings-sets.js and settings-plugins.js (the pages), settings-search.js (the
// search) and settings-toast.js (the undo toast). This module draws the menu, the page head, the pane and the foot, registers the commands
// of the commands core.settings-tab.*; core.settings.open, core.settings.close and the status core.settings-tab are in core-exposure.js.
//
// The event of the tab is the publication of its state: onSettingsTabFront calls fn(front) when the tab opens, closes or comes to the front,
// and the status core.settings-tab changes with it.
import { registry } from "./exposure.js";
import { designIcon } from "./icons.js";
import { commandOf, delegate, mark, run } from "./commands.js";
import { EXPOSURE_ERRORS, ExposureError } from "@soksak/plugin-api";
import { ALL_ROWS, GROUPS, PAGES, choicesOf } from "./settings-rows.js";
import { badge, button, editable, element } from "./settings-controls.js";
import { state, setScope, projectSelected, projectTitle, projectFolder, shownValue } from "./settings-state.js";
import { agentsPage, behaviorPage, diagPage, headScope, lookPage, scopeSegment, setupWarnings, workspacePage } from "./settings-pages.js";
import { setRow, setsPage } from "./settings-sets.js";
import { browsePage, installedBadge, installedPage, pluginMenuItems, pluginPage } from "./settings-plugins.js";
import { searchPage, searchResults } from "./settings-search.js";
import { tabErrors } from "./settings-errors.js";
import { dismissUndo, onUndoChange, showUndo, undoAction, undoElement, undoState } from "./settings-toast.js";
import { defaults, missingPluginKeys, onSettingsChange, overridden, pluginsOfCategory, scopedValue, settingDefinitions } from "./settings.js";
import { setupParts } from "./setup-exposure.js";
import { accounts } from "./accounts-exposure.js";
import { pluginOperations } from "./installed-plugins.js";
import { pluginAccounts, pluginUnits } from "./environment.js";
import { restoreScroll, scrollPositions } from "./scroll-keep.js";
import { coreRowFor, sizeGroup } from "./settings-pages.js";
import { declaredRow } from "./settings-plugins.js";
import { sideList } from "./settings-sides.js";
import { SIDE_NAMES } from "./window-sidebars.js";
import { showTabError } from "./settings-errors.js";

/** The pages that the menu shows, in order, and the two plugin pages that are not core pages. */
const CORE_PAGES = PAGES.map((page) => page.id);
const PLUGIN_LIST_PAGES = ["installed", "browse"];
/** The filters of Installed (docs/spec/settings.md#plugins). */
const FILTERS = ["all", "active", "disabled", "updates", "problems"];
/** The rows that one press of More adds to Browse (docs/spec/settings.md#plugins). */
const BROWSE_PAGE = 30;
/** The keys of the sides, whose switches show a toast with the side name (docs/spec/settings.md#saving-and-undo). */
const SIDE_KEYS = ["left", "right", "top", "bottom"];
/** The keys that the debug switch row shows (docs/spec/settings.md#pages). */
const DEBUG_KEYS = ["diagnostics.performance", "diagnostics.log"];

/** The element of the tab, or null while the tab is not mounted. */
let root = null;
/** Whether the settings tab is in front. */
let front = false;
/** The values of the settings at the last draw, which tell the changed setting and its old value for the undo toast. */
let snapshot = null;
/** Whether a change that this tab makes by the undo button runs, so that it shows no toast of its own. */
let reverting = false;
const frontListeners = new Set();
/** Receives the status of the tab at each publication, given by installSettingsTab. */
let statusSink = null;
let installed = false;

/** Whether the settings tab is in front (docs/spec/settings.md#opening-and-closing). */
/** The front of the tab last published to the front listeners. */
let publishedFront = false;

export const settingsTabFront = () => front;

/** Calls fn(front) when the tab opens, closes or comes to the front. It returns the function that removes fn. */
export function onSettingsTabFront(fn) {
  if (typeof fn !== "function") throw new TypeError("settings tab listener must be a function");
  frontListeners.add(fn);
  return () => frontListeners.delete(fn);
}

/** Publishes the state of the tab to the status listeners, and the front to the front listeners when it changed. */
function publish() {
  if (statusSink !== null) statusSink(statusOf());
  if (front !== publishedFront) {
    publishedFront = front;
    for (const fn of frontListeners) fn(front);
  }
}

/** Draws the tab again when it is mounted. */
export function redrawSettingsTab() {
  if (root !== null) draw();
}

/** Opens the tab, or brings it to the front (docs/spec/settings.md#opening-and-closing). */
export function openSettingsTab() {
  front = true;
  draw();
}

/** Closes the tab. The tab strip brings the work screen to the front (docs/spec/settings.md#opening-and-closing). */
export function closeSettingsTab() {
  front = false;
  syncReads();
  publish();
}

/**
 * Draws the content of the tab into container. The container is kept, so the tab draws again when the state changes.
 * The page is built here, when the tab is shown, and not when the window is created (docs/spec/settings.md#performance).
 */
export function mountSettingsTab(container) {
  if (!(container instanceof Element)) throw new TypeError("mountSettingsTab needs an element");
  if (root !== null && root !== container) throw new Error("the settings tab is already mounted in another element");
  // A failed command is shown through the one error display path, and the tab shows the text of the refusal.
  if (root === null) delegate(container, { failed: (error) => showTabError("settings-tab", error.message) });
  root = container;
  draw();
}

/** Takes the values of the settings for the undo toast: each key with the value the tab shows and whether the project overrides it. */
function takeSnapshot() {
  const values = {};
  for (const key of Object.keys(defaults)) values[key] = { shown: scopedValue(key, state.scope), overridden: overridden(key) };
  return values;
}

/** The title of the selected plugin page: the name and the description from the manifest, or from the state when no manifest is loaded. */
function pluginAbout(id) {
  const unit = pluginUnits().find((item) => item.id === id);
  if (unit) return { name: unit.name, description: unit.description };
  const row = pluginOperations.status().plugins.find((item) => item.id === id);
  if (!row) return null;
  return { name: row.name, description: row.description };
}

/** The keys of a plugin page that a project can override: the settings of the plugin and its sidebar links. */
const pluginKeys = (id) => [...Object.entries(settingDefinitions()).filter(([, def]) => def.plugin === id).map(([key]) => key), "links"];

/** The page head: the back link, the title, the description, the scope control and the folder caption (docs/spec/settings.md#page-head). */
function headEl() {
  const head = element("header", "set-head");
  const text = element("div", "set-head__text");
  let title;
  let description;
  let scope = null;
  if (state.page === "plugin") {
    const about = pluginAbout(state.plugin);
    title = about.name;
    description = about.description;
    text.append(button(state.back === "browse" ? "‹ 찾아보기" : "‹ 설치된 플러그인", {
      expose: "core.settings-tab.back", command: "core.settings-tab.back", params: {}, variant: "link",
    }));
    if (projectSelected()) scope = scopeSegment(pluginKeys(state.plugin));
  } else if (state.page === "installed") {
    title = "설치된 플러그인";
    description = "켜고 끄기, 업데이트, 문제 고치기. 하나를 누르면 그 플러그인의 정보와 설정이 한 페이지에 있다. 새로 찾는 일은 ‘찾아보기’ 화면에서 한다.";
  } else if (state.page === "browse") {
    const count = pluginOperations.status().plugins.length;
    title = "플러그인 찾아보기";
    description = `카탈로그 ${count}개. 하나를 누르면 설치 전에 자세히 본다.`;
  } else {
    const page = PAGES.find((item) => item.id === state.page);
    title = page.name;
    description = page.description;
    scope = headScope(state.page);
  }
  text.append(element("h2", "set-head__title", title), element("p", "set-caption set-head__desc", description));
  const head2 = element("div", "set-head__scope");
  if (scope !== null) head2.append(scope);
  if (state.scope === "project" && projectSelected()) {
    const folder = element("p", "set-caption set-folder");
    folder.dataset.expose = "core.settings-tab.folder";
    // The whole path stays inside the pane: the caption breaks after each space, hyphen and path separator (docs/spec/settings.md#page-head).
    for (const part of projectFolder().split(/(?<=[\/\\\- ])/)) {
      folder.append(part);
      if (/[\/\\\- ]$/.test(part)) folder.append(document.createElement("wbr"));
    }
    head2.append(folder);
  }
  head.append(text, head2);
  return head;
}

/** The content of the pane: the page in front, or the result of the search (docs/spec/settings.md#pages). */
function paneContent() {
  if (state.page === "look") return lookPage();
  if (state.page === "workspace") return workspacePage();
  if (state.page === "sets") return setsPage();
  if (state.page === "behavior") return behaviorPage();
  if (state.page === "agents") return agentsPage();
  if (state.page === "diag") return diagPage();
  if (state.page === "installed") return installedPage();
  if (state.page === "browse") return browsePage();
  if (state.page === "plugin") {
    if (pluginAbout(state.plugin) !== null) return pluginPage(state.plugin);
    // A plugin page whose plugin left the state shows the list that holds it, and the refusal is shown through the error display.
    showTabError("settings plugin", `plugin ${state.plugin} is not in the plugin state`);
    state.page = "installed";
    state.plugin = null;
    return installedPage();
  }
  throw new Error(`unknown settings page ${state.page}`);
}

/** The menu item of a core or list page: its icon, its name and its badge or count at the end (docs/spec/settings.md#menu). */
function navItem(page, label, iconName, badgeEl, selected) {
  const item = button(label, { expose: "core.settings-tab.nav", command: "core.settings-tab.nav", params: { page }, key: `nav:${page}`, on: selected, variant: "nav" });
  item.insertAdjacentHTML("afterbegin", designIcon(iconName));
  if (badgeEl) item.append(badgeEl);
  return item;
}

/** The badge of the menu item of agents: the count of setup parts that are not ok, in warn (docs/spec/settings.md#menu). */
function agentsBadge() {
  const count = setupWarnings();
  return count ? badge(String(count), "warn", { title: `${count}개가 다름` }) : null;
}

/** The menu: the search field, the group Settings, the group plugin, and the plugins that declare settings or accounts (docs/spec/settings.md#menu). */
function menuEl() {
  const nav = element("nav", "set-menu");
  nav.setAttribute("aria-label", "설정 메뉴");
  // The search field holds the search icon at its start (docs/spec/settings.md#menu).
  const field = element("div", "set-search");
  field.innerHTML = designIcon("search");
  const search = element("input", "text-field set-find");
  search.type = "search";
  search.placeholder = "설정 찾기";
  search.value = state.find;
  search.dataset.expose = "core.settings-tab.find";
  search.dataset.live = "";
  mark(search, "core.settings-tab.find", {}, "query");
  field.append(search);
  nav.append(field);
  const searching = state.find !== "";
  const core = element("div", "set-menu__group");
  core.append(element("p", "set-menu__label", "설정"));
  for (const page of PAGES) {
    const badgeEl = page.id === "agents" ? agentsBadge() : null;
    core.append(navItem(page.id, page.name, page.icon, badgeEl, !searching && state.page === page.id));
  }
  nav.append(core);
  const plugins = element("div", "set-menu__group");
  plugins.append(element("p", "set-menu__label", "플러그인"));
  const inst = installedBadge();
  plugins.append(navItem("installed", "설치됨", "settings-installed", inst.tone ? badge(inst.text, inst.tone, { title: inst.title }) : element("span", "set-count", inst.text), !searching && state.page === "installed"));
  const catalog = pluginOperations.status().plugins.length;
  plugins.append(navItem("browse", "찾아보기", "search", element("span", "set-count", String(catalog)), !searching && state.page === "browse"));
  nav.append(plugins);
  const items = pluginMenuItems();
  if (items.length) {
    const group = element("div", "set-menu__group");
    group.append(element("p", "set-menu__label", "설정이 있는 플러그인"));
    for (const row of items) {
      const item = button(row.name, {
        expose: "core.settings-tab.plugin-item", command: "core.settings-tab.plugin", params: { plugin: row.id }, key: `plugin:${row.id}`,
        on: !searching && state.page === "plugin" && state.plugin === row.id, variant: "nav",
      });
      // The chevron comes before the name; an enabled plugin shows the dot at the end, a disabled one the badge 꺼짐 (docs/spec/settings.md#menu).
      item.insertAdjacentHTML("afterbegin", designIcon("chevron"));
      if (row.installed.enabled) {
        const dot = element("span", "set-dot");
        dot.title = "사용 중";
        item.append(dot);
      } else {
        item.append(badge("꺼짐", "neutral"));
      }
      group.append(item);
    }
    nav.append(group);
  }
  return nav;
}

/** The foot: the line of saving and the undo toast (docs/spec/settings.md#saving-and-undo). */
function footEl() {
  const foot = element("footer", "set-foot");
  foot.append(element("span", "set-foot__saved", "✓ 바꾼 값은 바로 저장된다"));
  const toast = undoElement();
  if (toast !== null) foot.append(toast);
  return foot;
}

/** The key of the visible content: a change of the page, the scope, the plugin, the edited set or the search starts at the top. */
const scrollKey = () => JSON.stringify([state.page, state.scope, state.plugin, state.editing, state.find]);

/** The main column: the page head and the pane, or the search result in place of the head and the pane (docs/spec/settings.md#search). */
function mainEl() {
  const main = element("div", "set-main");
  const pane = element("div", "set-pane");
  pane.dataset.expose = "core.settings-tab.pane";
  pane.dataset.scrollKey = scrollKey();
  const query = state.find.trim();
  if (query !== "") {
    pane.append(...searchPage(query));
  } else {
    main.append(headEl());
    pane.append(...paneContent());
  }
  main.append(pane, footEl());
  return main;
}

/** Starts or stops the reads of the pages that show them, and only while the tab is in front (docs/spec/settings.md#pages). */
function syncReads() {
  const shown = front && state.find.trim() === "";
  setupParts.show(shown && state.page === "agents");
  const plugin = shown && state.page === "plugin" && pluginAccounts(state.plugin)?.accounts ? state.plugin : null;
  accounts.show(plugin);
}

/** Draws the whole tab again, keeping the scroll position of the same content (docs/spec/settings.md#page-head). */
function draw() {
  if (root === null) {
    publish();
    return;
  }
  if (!projectSelected()) setScope("common");
  const positions = scrollPositions(root);
  root.replaceChildren(menuEl(), mainEl());
  snapshot = takeSnapshot();
  syncReads();
  restoreScroll(root, positions);
  publish();
}

/** Reads the state of the tab for the status core.settings-tab (docs/spec/settings.md#status). */
function statusOf() {
  // null while the window has no settings tab (docs/spec/settings.md#status).
  if (root === null) return null;
  const mounted = true;
  const search = state.find.trim() !== "";
  const controls = mounted ? [...root.querySelectorAll("[data-expose]")].map(controlOf(root)) : [];
  const rows = mounted && state.page === "plugin" ? [...root.querySelectorAll(".set-row[data-row]")]
    .filter((el) => Object.hasOwn(settingDefinitions(), el.dataset.row))
    .map((el) => ({ key: el.dataset.row, name: el.querySelector(".set-row__name").textContent, description: el.querySelector(".set-caption")?.textContent ?? null })) : []; // default: a row without a caption has no description.
  const actions = mounted ? [...root.querySelectorAll('[data-expose="core.settings-tab.plugins.action"]')].map((el) => {
    const [plugin, action] = el.dataset.key.split(":");
    return { plugin, action, disabled: el.disabled };
  }) : [];
  const listed = mounted && !search && PLUGIN_LIST_PAGES.includes(state.page)
    ? [...root.querySelectorAll(".set-plugin-row[data-plugin]")].map((el) => el.dataset.plugin) : [];
  const shown = mounted && state.page === "browse" && !search ? root.querySelectorAll('[data-expose="core.settings-tab.browse-row"]').length : 0;
  return {
    page: state.page,
    scope: state.scope,
    find: state.find,
    query: state.query,
    filter: state.filter,
    browse: { query: state.browse.query, hideInstalled: state.browse.hideInstalled, shown },
    listed,
    actions,
    plugin: state.page === "plugin" ? state.plugin : null,
    back: state.back,
    editing: state.editing,
    rows,
    controls,
    // default: a pane that is not mounted has scroll position 0.
    scroll: scrollPosition(mounted ? root.querySelector('[data-expose="core.settings-tab.pane"]')?.scrollTop ?? 0 : 0),
    undo: undoState(),
    confirm: state.confirm,
    errors: tabErrors(),
    results: search ? searchResults(state.find.trim()) : null,
    missing: missingSettings(),
  };
}

/** The keys of the plugin settings whose value names no loaded plugin (docs/spec/settings.md#status). */
function missingSettings() { return missingPluginKeys(); }

/** Describes one control of the tab for the status: its element name, key, command, value, state and select options. */
/**
 * Whether a control is disabled (docs/spec/settings.md#status): a setting is disabled while its parent is off, and a common-only setting
 * in the project scope. A control of no setting reports its own disabled state.
 */
function disabledOf(el, key) {
  const row = key === null ? undefined : ALL_ROWS.find((item) => item.key === key);
  if (row === undefined) return el.disabled === true;
  const parentOff = row.depends !== undefined && shownValue(row.depends) === false;
  return parentOff || !editable(key);
}

function controlOf() {
  const counts = new Map();
  return (el) => {
    const name = el.dataset.expose;
    // default: the first element with a name has the index 0.
    const index = counts.get(name) ?? 0;
    counts.set(name, index + 1);
    const command = commandOf(el);
    const isSelect = el.tagName === "SELECT";
    // default: an element without a row key or a set key has no key.
    const key = el.dataset.key ?? el.dataset.set ?? null;
    return {
      name,
      index,
      key,
      disabled: disabledOf(el, key),
      label: isSelect ? "" : el.textContent.trim(),
      command: command === null ? null : command.name,
      value: "value" in el && el.tagName !== "BUTTON" && el.type !== "checkbox" ? String(el.value) : null,
      on: el.type === "checkbox" ? el.checked : el.dataset.on === undefined ? null : el.dataset.on === "true",
      options: isSelect ? [...el.querySelectorAll("option")].map((option) => option.value) : null,
    };
  };
}

/** Refuses a command parameter with the error of invalid params (docs/spec/settings.md#status). */
function invalid(message) {
  return new ExposureError(EXPOSURE_ERRORS.invalidParams, message);
}

/** Refuses a value that is not one of the given choices (docs/spec/settings.md#settings-tab). */
function oneOf(name, value, choices) {
  if (!choices.includes(value)) throw invalid(`${name} must be one of ${choices.join(", ")}`);
  return value;
}

/** The plugin ids that the status rows list (docs/spec/settings.md#plugins). */
const listedPlugin = (id) => {
  if (typeof id !== "string" || id === "") throw invalid("plugin must be a non-empty string");
  if (!pluginOperations.status().plugins.some((row) => row.id === id)) throw invalid(`plugin ${id} is not listed`);
  return id;
};

/** The label of a setting for the toast: the label of its row, or of its plugin declaration (docs/spec/settings.md#saving-and-undo). */
function labelOf(key) {
  const row = ALL_ROWS.find((item) => item.key === key);
  if (row) return row.label;
  const definition = settingDefinitions()[key];
  return definition ? definition.label : key;
}

/** The text of a value in a toast: a switch shows on or off, a choice shows its label, and a number shows its unit. */
function textOf(key, value) {
  if (typeof value === "boolean") return value ? "켬" : "끔";
  const choices = CHOICE_KEYS.includes(key) ? Object.fromEntries(choicesOf(key)) : null;
  if (choices && Object.hasOwn(choices, value)) return choices[value];
  return String(value);
}
const CHOICE_KEYS = ["projectOpening", "projectTabs", "mode", "language", "viewProcess", "font", "textSize", "focusInd", "fullRule", "cardArrange"];

/**
 * The toast of a change, or null when the change shows none (docs/spec/settings.md#saving-and-undo). A change of one setting shows
 * `<label>: <old> → <new>`; a side switch and a sidebar order have their own texts, and a theme names the theme. A change of the sets or of
 * the links shows no toast, because it has no value to show in one line.
 */
function toastOf(keys, before, after) {
  const quiet = keys.filter((key) => !["sets", "links", "diagnostics.log", "diagnostics.performance"].includes(key) && !key.endsWith(".win.order") && !key.endsWith(".card.order"));
  if (quiet.includes("theme")) {
    return {
      text: `테마: ${before.theme.shown} → ${after.theme.shown}`,
      command: "core.settings.theme",
      params: { name: before.theme.shown, mode: before.mode.shown, scope: state.scope },
      detail: { key: "theme", label: "테마", old: before.theme.shown, new: after.theme.shown },
    };
  }
  if (quiet.length !== 1) return null;
  const [key] = quiet;
  let text;
  if (SIDE_KEYS.includes(key)) text = `${SIDE_NAMES[key]} 사이드바 보이기: ${textOf(key, before[key].shown)} → ${textOf(key, after[key].shown)}`;
  else if (key === "sidebarOrder") text = `배치 순서: ${after[key].shown.map((side) => SIDE_NAMES[side]).join(" → ")}`;
  else text = `${labelOf(key)}: ${textOf(key, before[key].shown)} → ${textOf(key, after[key].shown)}`;
  // The undo of a project value that did not exist before removes it; every other undo writes the old value to the scope the tab shows.
  const detail = { key, label: SIDE_KEYS.includes(key) ? `${SIDE_NAMES[key]} 사이드바 보이기` : labelOf(key), old: before[key].shown, new: after[key].shown };
  if (state.scope === "project" && !before[key].overridden) return { text, command: "core.settings.reset", params: { key, scope: "project" }, detail };
  return { text, command: "core.settings.change", params: { key, value: before[key].shown, scope: state.scope }, detail };
}

/** The sidebar sizes: their rows share one group, which also shows the error of the sizes (docs/spec/settings.md#pages). */
const SIZE_KEYS = ["sidebarMinWidth", "sidebarMaxWidth", "sidebarWidth"];

/** A plugin order key: <plugin>.win.order or <plugin>.card.order. */
const PLUGIN_ORDER_KEY = /^([^.]+)\.(win|card)\.order$/;

/** The row element that shows key, as the page of the key draws it, or null when no row of a core or plugin page shows the key. */
function rowsFor(key) {
  if (SIDE_KEYS.includes(key)) {
    const orderRow = ALL_ROWS.find((def) => def.form === "sidebar");
    return [coreRowFor(orderRow)];
  }
  const order = PLUGIN_ORDER_KEY.exec(key);
  if (order !== null) {
    const [, plugin, kind] = order;
    const title = kind === "win" ? "창 사이드바" : "카드 사이드바";
    return [sideList({ order: key, place: (side) => `${kind === "win" ? "window" : "card"}-${side}`, plugin, title })];
  }
  const def = ALL_ROWS.find((item) => item.key === key);
  if (def) return [coreRowFor(def)];
  const plugin = settingDefinitions()[key];
  if (plugin) return declaredRow(key, plugin);
  return null;
}

/**
 * Draws again only the rows that show the changed keys, and keeps the rest of the tab (docs/spec/settings.md#performance). A row that is
 * not shown is not drawn. The rows that show a link are drawn again for a change of the links or of the sets, since their select lists the
 * sets. It returns false when a key needs the whole pane, and the caller draws the pane.
 */
/**
 * The sets whose value changed, as the values after the change, or null when the list changed its members or their order, which
 * the sets page draws with its pane (docs/spec/settings.md#performance).
 */
function changedSets(previous, next) {
  if (previous === null || previous.sets === undefined || next.sets === undefined) return null;
  const before = previous.sets.shown;
  const after = next.sets.shown;
  if (before.length !== after.length || before.some((set, index) => set.id !== after[index].id)) return null;
  return after.filter((set, index) => JSON.stringify(set) !== JSON.stringify(before[index]));
}

function patchRows(keys, changed) {
  if (keys.includes("sets") && state.page === "sets") {
    // The row of a changed set is drawn alone; the editor of the edited set belongs to the pane, so its change draws the pane.
    if (changed === null || changed.some((set) => set.id === state.editing)) return false;
    for (const set of changed) {
      const shown = root.querySelector(`.set-set[data-set="${CSS.escape(set.id)}"]`);
      if (shown === null) return false;
      shown.replaceWith(setRow(set));
    }
  }
  const names = new Set(keys.map((key) => {
    if (key === "mode") return "theme";
    if (DEBUG_KEYS.includes(key)) return "debug";
    return SIDE_KEYS.includes(key) ? "sidebarOrder" : key;
  }));
  if (keys.includes("mode")) names.add("mode");
  // A row whose setting depends on a changed setting shows that setting's state (disabled while the parent is off), so it is drawn again too.
  for (const def of ALL_ROWS) if (def.depends !== undefined && keys.includes(def.depends)) names.add(def.key);
  if (keys.includes("links") || keys.includes("sets")) {
    for (const row of root.querySelectorAll(".set-row[data-row]")) {
      if (row.querySelector('[data-set^="link:"]') !== null) names.add(row.dataset.row);
    }
  }
  let sizeDrawn = false;
  for (const name of names) {
    if (SIZE_KEYS.includes(name)) {
      // The sizes share one group, drawn once for all of them.
      const group = root.querySelector(`.set-row[data-row="${CSS.escape(name)}"]`)?.closest(".set-group");
      if (group !== undefined && group !== null && !sizeDrawn) {
        group.replaceWith(sizeGroup());
        sizeDrawn = true;
      }
      continue;
    }
    for (const shown of [...root.querySelectorAll(`.set-row[data-row="${CSS.escape(name)}"]`)]) {
      const next = rowsFor(name);
      if (next === null) return false;
      shown.replaceWith(...next);
    }
  }
  // The scope control counts the overrides of the page, so its segment is drawn again (docs/spec/settings.md#page-head).
  const scope = root.querySelector(".set-head__scope");
  if (scope !== null && state.page !== "plugin" && state.page !== "installed" && state.page !== "browse") {
    scope.replaceChildren(...(headScope(state.page) === null ? [] : [headScope(state.page)]));
  }
  return true;
}

/** Replaces the head, the pane and the foot of the tab; the menu and the scroll position of the same content stay. */
function drawMain() {
  const positions = scrollPositions(root);
  const main = root.querySelector(".set-main");
  main.replaceWith(mainEl());
  restoreScroll(root, positions);
}

/** Replaces the foot, when the toast changes. */
function drawFoot() {
  const foot = root.querySelector(".set-foot");
  if (foot !== null) foot.replaceWith(footEl());
}

/**
 * Runs when a setting changes. A change made while the tab is in front shows the undo toast. Only the rows of the changed keys are drawn
 * again, so a value change moves no other row and redraws no page (docs/spec/settings.md#performance).
 */
function settingsChanged() {
  const previous = snapshot;
  const next = takeSnapshot();
  const keys = snapshot === null ? Object.keys(next) : Object.keys(next).filter((key) => JSON.stringify(next[key]) !== JSON.stringify(snapshot[key]));
  if (snapshot !== null && front && !reverting) {
    const toast = toastOf(keys, snapshot, next);
    if (toast !== null) showUndo(toast.text, toast.command, toast.params, toast.detail);
  }
  snapshot = next;
  if (root === null || keys.length === 0) {
    publish();
    return;
  }
  if (!patchRows(keys, changedSets(previous, next))) drawMain();
  publish();
}

/**
 * The scroll position of the status, in points from the top; a negative position is kept, since the native host reports one while the
 * content is pulled past its start. A value that is not a finite number is refused (docs/spec/settings.md#status).
 */
export function scrollPosition(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError(`settings scroll position is not a number: ${String(value)}`);
  return value;
}

/** The status core.settings-tab of the tab, or null while the window has no settings tab. */
export const settingsTabStatus = () => statusOf();

/**
 * Registers the commands core.settings-tab.* and follows the changes of the settings. core-exposure.js calls it once, when the first
 * command of the tab loads this module. sink(status) receives the status at each publication of the tab.
 */
export function installSettingsTab(sink) {
  if (installed) return;
  installed = true;
  statusSink = sink;
  registry.command("core.settings-tab.nav", ({ page, group }) => {
    oneOf("page", page, [...CORE_PAGES, ...PLUGIN_LIST_PAGES]);
    // default: a page without groups has no group, so a named group is refused.
    if (group !== undefined && !(GROUPS[page] ?? []).some((item) => item.id === group)) throw invalid(`unknown group "${group}" of page "${page}"`);
    state.page = page;
    state.plugin = null;
    state.find = "";
    front = true;
    draw();
    // A named group is scrolled to the top of the pane; the group keeps its id as data-group (docs/spec/settings.md#rows).
    if (group !== undefined) root?.querySelector(`[data-group="${group}"]`)?.scrollIntoView({ block: "start" });
  });
  registry.command("core.settings-tab.scope", ({ scope }) => {
    oneOf("scope", scope, ["common", "project"]);
    if (scope === "project" && !projectSelected()) throw invalid("no project is selected");
    setScope(scope);
    draw();
  });
  registry.command("core.settings-tab.find", ({ query }) => {
    if (typeof query !== "string") throw invalid("query must be a string");
    state.find = query.trim();
    draw();
  });
  registry.command("core.settings-tab.plugin", ({ plugin }) => {
    const id = listedPlugin(plugin);
    state.back = state.page === "browse" ? "browse" : "installed";
    state.page = "plugin";
    state.plugin = id;
    state.find = "";
    draw();
  });
  registry.command("core.settings-tab.back", () => {
    state.page = state.back;
    state.plugin = null;
    draw();
  });
  registry.command("core.settings-tab.browse", ({ query, hideInstalled, more }) => {
    if (query !== undefined) {
      if (typeof query !== "string") throw invalid("query must be a string");
      state.browse.query = query;
      state.browse.shown = BROWSE_PAGE;
    }
    if (hideInstalled !== undefined) {
      if (typeof hideInstalled !== "boolean") throw invalid("hideInstalled must be a boolean");
      state.browse.hideInstalled = hideInstalled;
      state.browse.shown = BROWSE_PAGE;
    }
    if (more !== undefined) {
      if (more !== true) throw invalid("more must be true");
      state.browse.shown += BROWSE_PAGE;
    }
    state.page = "browse";
    state.plugin = null;
    state.find = "";
    draw();
  });
  registry.command("core.settings-tab.search", ({ query }) => {
    if (typeof query !== "string") throw invalid("query must be a string");
    state.query = query;
    draw();
  });
  registry.command("core.settings-tab.filter", ({ filter }) => {
    state.filter = oneOf("filter", filter, FILTERS);
    draw();
  });
  registry.command("core.settings-tab.edit", ({ set = null }) => {
    if (set !== null && !(typeof set === "string" && set !== "")) throw invalid("set must be a set id or null");
    state.editing = set;
    draw();
  });
  registry.command("core.settings-tab.confirm", async ({ kind, id, answer }) => {
    oneOf("kind", kind, ["set", "plugin"]);
    oneOf("answer", answer, ["ask", "no", "yes"]);
    if (kind === "plugin") listedPlugin(id);
    if (answer === "ask") state.confirm = { kind, id };
    else {
      state.confirm = null;
      if (answer === "yes" && kind === "set") await run("core.settings.sets.delete", { id, scope: state.scope });
      if (answer === "yes" && kind === "plugin") {
        await run("core.plugins.remove", { plugin: id });
        state.page = "installed";
        state.plugin = null;
      }
    }
    draw();
  });
  registry.command("core.settings-tab.undo", async () => {
    const action = undoAction();
    if (action === null) return;
    dismissUndo();
    reverting = true;
    try {
      await run(action.command, action.params);
    } finally {
      reverting = false;
    }
  });
  registry.command("core.settings-tab.account-name", ({ name }) => {
    accountPage();
    if (typeof name !== "string") throw invalid("name must be a string");
    state.account = { ...state.account, plugin: state.plugin, name };
    draw();
  });
  registry.command("core.settings-tab.account-kind", ({ kind }) => {
    accountPage();
    if (!pluginAccounts(state.plugin).accounts.kinds.some((item) => item.value === kind)) throw invalid(`account kind ${kind} is not declared`);
    state.account = { ...state.account, plugin: state.plugin, kind };
    draw();
  });
  registry.command("core.settings-tab.account-edit", ({ id }) => {
    accountPage();
    if (id === null) state.account = { ...state.account, edit: null, editName: "" };
    else {
      const account = accounts.list(state.plugin).find((item) => item.id === id);
      if (!account) throw invalid(`account ${id} is not defined`);
      state.account = { ...state.account, edit: id, editName: account.name };
    }
    draw();
  });
  registry.command("core.settings-tab.account-edit-name", ({ name }) => {
    accountPage();
    if (state.account.edit === null) throw invalid("no account name is edited");
    if (typeof name !== "string") throw invalid("name must be a string");
    state.account = { ...state.account, editName: name };
    draw();
  });
  // A finished add clears the name of the row New account, and a finished rename ends the edit (docs/spec/settings.md#plugin-page).
  accounts.onFinished((command, plugin) => {
    if (state.account.plugin !== plugin) return;
    state.account = command === "core.accounts.add" ? { ...state.account, name: "" } : { ...state.account, edit: null, editName: "" };
    draw();
  });
  onSettingsChange(settingsChanged);
  onUndoChange(() => { if (root !== null) drawFoot(); publish(); });
}

/** The account page: the fields of the group Accounts exist only on a plugin page with accounts (docs/spec/settings.md#plugin-page). */
function accountPage() {
  if (state.page !== "plugin" || pluginAccounts(state.plugin)?.accounts === undefined || pluginAccounts(state.plugin)?.accounts === null) {
    throw invalid("no page of a plugin with accounts shows");
  }
}
