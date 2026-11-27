// The plugin pages of the settings tab: Installed, Browse and one page for each plugin (docs/spec/settings.md#plugins). The state of the
// plugins comes from the plugin operations of installed-plugins.js, and every action runs a declared plugin command.
import { appUpdate, pluginOperations } from "./installed-plugins.js";
import { pluginAccounts, pluginCategories, pluginUnits } from "./environment.js";
import { settingDefinitions, pluginsOfCategory, missingPluginValue } from "./settings.js";
import { ACCOUNTS_DESCRIPTION } from "./settings-rows.js";
import { accounts } from "./accounts-exposure.js";
import { button, badge, element, iconButton, row, scopeMarks, select, slider, textField, toggle, choice, editable } from "./settings-controls.js";
import { sideList } from "./settings-sides.js";
import { group } from "./settings-pages.js";
import { state, shownValue, writeScope } from "./settings-state.js";
import { hasUpdate } from "./plugin-operations.js";
import { contributionsState } from "./contributions.js";
import { sectionNames } from "./registry.js";
import { hideTabError, showTabError } from "./settings-errors.js";
import { mark } from "./commands.js";
import { compareVersions } from "@soksak/plugin-api";

/** The rows of the plugin state, in the order the page shows them: installed and loaded plugins only, for Installed (docs/spec/settings.md#plugins). */
const statusRows = () => pluginOperations.status().plugins;
const installedRows = () => statusRows().filter((row) => row.state !== "available");
const catalogRows = () => statusRows();

/** Whether a row has a problem: a missing dependency, the state requires, or the state refused (docs/spec/settings.md#plugins). */
function problemOf(row) {
  return row.state === "requires" || row.state === "refused" || missingDependencies(row).length > 0;
}

/** The plugin ids of the dependencies of a loaded plugin that are not installed; the dependency ids are the plugin rows that the state lists. */
function missingDependencies(row) {
  const unit = pluginUnits().find((item) => item.id === row.id);
  if (!unit) return [];
  const listed = new Map(statusRows().map((item) => [item.id, item]));
  return Object.keys(unit.dependencies).filter((id) => listed.has(id) && listed.get(id).installed === null && listed.get(id).state === "available");
}

/** Whether the installed version is newer than the newest published version (docs/spec/settings.md#plugins). */
const developmentBuild = (row) => row.installed !== null && row.latest !== null && compareVersions(row.installed.version, row.latest) > 0;

/** The badges of a row in their order (docs/spec/settings.md#plugins). */
function badgesOf(row) {
  const out = [];
  if (row.installed && !row.installed.enabled) out.push(badge("꺼짐", "neutral"));
  if (hasUpdate(row)) out.push(badge(`업데이트 ${row.latest}`, "acc"));
  if (developmentBuild(row)) out.push(badge("개발 빌드", "warn", { title: `설치 ${row.installed.version} > 배포 ${row.latest}` }));
  for (const id of missingDependencies(row)) out.push(badge(`${id} 필요`, "warn"));
  if (row.state === "requires") out.push(badge("필요한 플러그인 없음", "warn"));
  if (row.state === "reload") out.push(badge("창을 다시 불러오면 적용", "warn"));
  if (row.state === "refused") out.push(badge("불러오지 못함", "warn"));
  return out;
}

/** The letter icon of a plugin: the first letter of its name in the accent token. */
const letter = (name) => element("span", "plug-letter", [...name][0]);

/** The sidecars of a plugin as their names and ranges, or none without a sidecar (docs/spec/settings.md#plugin-page). */
export function sidecarText(sidecars) {
  if (sidecars.length === 0) return "없음";
  return sidecars.map((sidecar) => (sidecar.range === null ? sidecar.name : `${sidecar.name} ${sidecar.range}`)).join(", ");
}

/** The name of a plugin in the state, which the row Required and its install button name; an id that the state does not list is its own name. */
export function nameOfPlugin(id) {
  return statusRows().find((item) => item.id === id)?.name ?? id; // default: a plugin that is not installed has no name in the state, so its id is its name, as docs/spec/settings.md states for the row Required of a plugin named in dependencies that is not installed.
}

/** The meta line of the row Use of a plugin page: its categories, its id, its installed version and the latest or published version, then its
 * sidecars (docs/spec/settings.md#plugin-page). */
export function useMetaOf(item) {
  const categories = Object.entries(pluginCategories()).filter(([, plugins]) => plugins.some((plugin) => plugin.id === item.id)).map(([name]) => name).join(", ");
  const version = `설치 ${item.installed.version}${hasUpdate(item) ? ` · 배포 ${item.latest}` : " · 최신"}`;
  return [categories, item.id, version, item.sidecars.length > 0 ? `사이드카 ${sidecarText(item.sidecars)}` : ""].filter(Boolean).join(" · ");
}

/** The meta line of a plugin: its plugin categories, its key and its version (docs/spec/settings.md#plugins). A category is listed when the window loads the plugin in it. */
function metaOf(row) {
  const version = row.installed ? `v${row.installed.version}` : row.latest ? `v${row.latest}` : "";
  const category = Object.entries(pluginCategories()).filter(([, plugins]) => plugins.some((plugin) => plugin.id === row.id)).map(([name]) => name).join(", ");
  return [category, row.id, version].filter(Boolean).join(" · ");
}

/** The disabled state of every plugin action while an operation runs (docs/spec/settings.md#plugins). */
const busy = () => pluginOperations.status().operation?.state === "running";

/** One action button of a plugin row. Its key names the plugin and the action, and it is in the status actions list. */
function action(plugin, name, label, command, params, variant = "sm") {
  return button(label, { expose: "core.settings-tab.plugins.action", command, params, key: `${plugin}:${name}`, disabled: busy(), variant });
}

/** The labels of the actions that a held operation runs (docs/spec/settings.md#plugins). */
const HELD_ACTIONS = { install: "설치", update: "업데이트", enable: "사용" };

/** The held operation of a plugin, or null; it shows its error through the error display and its action (docs/spec/settings.md#plugins). */
function heldOf(id) {
  // default: a plugin with no held operation has no held entry.
  const held = pluginOperations.status().held.find((entry) => entry.plugin === id) ?? null;
  if (held === null) hideTabError(`plugin ${id} held`);
  else showTabError(`plugin ${id} held`, held.error);
  return held;
}

/** The action that ends the sessions of a held operation and runs it with end; absent while a sessions count is unknown (docs/spec/settings.md#plugins). */
function heldAction(id) {
  const held = heldOf(id);
  if (held === null || held.sidecars.some((sidecar) => sidecar.sessions === null)) return null;
  if (!Object.hasOwn(HELD_ACTIONS, held.action)) throw new Error(`plugin ${id} holds an unknown action ${held.action}`);
  const sessions = held.sidecars.reduce((sum, sidecar) => sum + sidecar.sessions, 0);
  return button(`세션 ${sessions}개를 끝내고 ${HELD_ACTIONS[held.action]}`, {
    expose: "core.settings-tab.plugins.end", command: `core.plugins.${held.action}`, params: { plugin: id, end: true }, key: `${id}:end`, disabled: busy(), variant: "sm",
  });
}

/** One row of Installed (docs/spec/settings.md#plugins). The search draws the same row. */
export function installedRow(row) {
  const el = element("div", "set-plugin-row");
  el.dataset.plugin = row.id;
  el.dataset.expose = "core.settings-tab.plugin-row";
  el.append(letter(row.name));
  const head = element("div", "set-plugin-row__head");
  const name = element("span", "set-plugin-row__name", row.name);
  head.append(name, ...badgesOf(row));
  head.append(element("p", "set-caption", metaOf(row)));
  const operation = pluginOperation(row.id);
  if (operation) head.append(element("p", "set-caption", operation));
  const actions = element("div", "set-plugin-row__actions");
  for (const id of missingDependencies(row)) actions.append(action(row.id, "install-dependency", `${id} 설치`, "core.plugins.install", { plugin: id }));
  if (hasUpdate(row)) actions.append(action(row.id, "update", "업데이트", "core.plugins.update", { plugin: row.id }));
  const ending = heldAction(row.id);
  if (ending) actions.append(ending);
  if (row.installed) actions.append(enableSwitch(row));
  actions.append(iconButton("chevron-right", `${row.name} 정보와 설정`, { expose: "core.settings-tab.plugin", command: "core.settings-tab.plugin", params: { plugin: row.id }, key: `plugin:${row.id}` }));
  el.append(head, actions);
  return el;
}

/** The switch of a plugin: on runs core.plugins.disable and off runs core.plugins.enable (docs/spec/settings.md#plugins). */
function enableSwitch(item) {
  const el = toggle(`plugin:${item.id}`, item.installed.enabled, {
    expose: "core.settings-tab.plugins.switch", command: item.installed.enabled ? "core.plugins.disable" : "core.plugins.enable",
    params: { plugin: item.id }, valueName: "on", disabled: busy(), label: `${item.name} 사용`,
  });
  return el;
}

/** The message of the operation of a plugin, which shows its running action or its failure through the error display. */
function pluginOperation(id) {
  const operation = pluginOperations.status().operation;
  if (!operation || operation.plugin !== id) return null;
  if (operation.state === "running") return `${id} ${operation.action} 진행 중`;
  if (operation.state === "failed") {
    showTabError(`plugin ${id}`, operation.error);
    return null;
  }
  hideTabError(`plugin ${id}`);
  return null;
}

/** The sort of the rows: a problem first, then an update, then the rest, each group by name with localeCompare. */
const rank = (row) => (problemOf(row) ? 0 : hasUpdate(row) ? 1 : 2);
const byRank = (a, b) => (rank(a) !== rank(b) ? rank(a) - rank(b) : a.name.localeCompare(b.name));

/** The filter of Installed that a row passes (docs/spec/settings.md#plugins). */
const FILTERS = {
  all: () => true,
  active: (row) => row.state === "loaded",
  disabled: (row) => row.installed !== null && !row.installed.enabled,
  updates: (row) => hasUpdate(row),
  problems: (row) => problemOf(row),
};

/** The core update row of Installed with its notices, drawn above the other lines when a newer core release is listed (docs/spec/settings.md#plugins). */
function appRows() {
  const app = appUpdate.status();
  if (app.available === null) return [];
  const busyUpdate = app.operation !== null && (app.operation.state === "staging" || app.operation.state === "applying");
  if (app.operation?.state === "failed") showTabError("core update", app.operation.error);
  else hideTabError("core update");
  const el = element("div", "set-plugin-row set-app-update");
  el.dataset.expose = "core.settings-tab.plugins.app";
  el.append(element("p", "set-caption", `core: ${app.version} → ${app.available.version}`));
  if (app.available.release !== null) {
    el.append(button("릴리스 페이지", { expose: "core.settings-tab.plugins.app-release", command: "core.app.release", params: {}, variant: "ghost" }));
  }
  el.append(button("업데이트", { expose: "core.settings-tab.plugins.app-update", command: "core.app.update", params: {}, disabled: busyUpdate || busy(), variant: "sm" }));
  if (busyUpdate) el.append(element("p", "set-caption", `${app.available.version} 업데이트 진행 중`));
  const notices = app.incompatible.map((item) => {
    const notice = element("p", "set-caption", `${item.id} ${item.installed} (${item.range}): ${app.available.version}에 맞는 ${item.compatible ? `최신 버전 ${item.compatible}` : "버전 없음"}`);
    notice.dataset.expose = "core.settings-tab.plugins.incompatible";
    return notice;
  });
  return [el, ...notices];
}

/** The rows of the outdated persistent services, in sidecar order: the versions, and the action that ends their sessions and replaces the service,
 * or ends it when the sidecar is no longer declared (docs/spec/settings.md#plugins). */
function outdatedRows() {
  return pluginOperations.status().outdated.map((item) => {
    const declared = item.installed !== null;
    const el = element("div", "set-plugin-row set-outdated");
    el.dataset.expose = "core.settings-tab.plugins.outdated";
    el.dataset.sidecar = item.sidecar;
    // default: docs/spec/settings.md#plugins, a running side that the service did not report shows the label previous version.
    el.append(element("p", "set-caption", `${item.sidecar}: ${item.running ?? "이전 버전"} → ${declared ? item.installed : "선언 없음"}`));
    el.append(button(`세션 ${item.sessions}개를 끝내고 ${declared ? "적용" : "종료"}`, {
      expose: "core.settings-tab.plugins.replace", command: "core.plugins.replace", params: { sidecar: item.sidecar }, key: item.sidecar, disabled: busy(), variant: "sm",
    }));
    return el;
  });
}

/** The page Installed: the update lines, the search, the filter, the rows and the card that opens Browse (docs/spec/settings.md#plugins). */
export function installedPage() {
  const rows = installedRows().toSorted(byRank);
  const counts = Object.fromEntries(Object.keys(FILTERS).map((name) => [name, rows.filter(FILTERS[name]).length]));
  const updates = rows.filter(hasUpdate);
  const list = element("div", "set-plugin-list");
  const filtered = rows.filter(FILTERS[state.filter]);
  for (const row of filtered) list.append(installedRow(row));
  if (filtered.length === 0) list.append(element("p", "set-caption", "맞는 플러그인이 없다."));
  const search = element("input", "text-field");
  search.type = "search";
  search.placeholder = "설치된 플러그인 찾기";
  search.value = state.query;
  search.dataset.expose = "core.settings-tab.search";
  mark(search, "core.settings-tab.search", {}, "query");
  search.dataset.live = "";
  const segment = element("span", "set-seg");
  for (const [name, label] of [["all", `전체 ${counts.all}`], ["active", `사용 중 ${counts.active}`], ["disabled", `꺼짐 ${counts.disabled}`], ["updates", `업데이트 ${counts.updates}`], ["problems", `문제 ${counts.problems}`]]) {
    const pressed = state.filter === name;
    const el = button(label, { expose: "core.settings-tab.filter", command: "core.settings-tab.filter", params: { filter: name }, on: pressed, variant: "seg" });
    el.setAttribute("aria-pressed", String(pressed));
    segment.append(el);
  }
  const head = [row({ label: "", control: search, key: "search" }), row({ label: "거르기", control: segment, key: "filter" })];
  if (updates.length) head.push(button(`모두 업데이트 (${updates.length})`, { expose: "core.settings-tab.plugins.update-all", command: "core.plugins.update-all", params: {}, disabled: busy(), variant: "sm" }));
  const browse = element("div", "set-browse-card");
  browse.append(element("p", "set-caption", `카탈로그 ${catalogRows().length}개 중 ${catalogRows().filter((r) => r.state === "available").length}개를 더 설치할 수 있다. 설치 전에 필요한 플러그인을 확인한다.`));
  browse.append(button("찾아보기", { expose: "core.settings-tab.nav", command: "core.settings-tab.nav", params: { page: "browse" }, variant: "primary" }));
  return [group("설치된 플러그인", "켜고 끄기, 업데이트, 문제 고치기. 하나를 누르면 그 플러그인의 정보와 설정이 한 페이지에 있다. 새로 찾는 일은 ‘찾아보기’ 화면에서 한다.", [...appRows(), ...outdatedRows(), ...head, list, browse])];
}

/** The count of the menu badge of Installed: a problem count (warn), else an update count (acc), else the installed count (plain). */
export function installedBadge() {
  const rows = installedRows();
  const problems = rows.filter(problemOf).length;
  if (problems) return { text: String(problems), tone: "warn", title: `문제 ${problems}` };
  const updates = rows.filter(hasUpdate).length;
  if (updates) return { text: String(updates), tone: "acc", title: `업데이트 ${updates}` };
  return { text: String(rows.length), tone: null, title: null };
}

/** The page Browse: the search, the switch, the rows of the catalog that are not installed or that match, and the list of 30 rows (docs/spec/settings.md#plugins). */
export function browsePage() {
  const query = state.browse.query.trim().toLowerCase();
  const hide = state.browse.hideInstalled;
  const all = catalogRows().toSorted((a, b) => a.name.localeCompare(b.name));
  const matched = all.filter((row) => (!hide || row.installed === null)
    // default: a row field without text contributes no text to the search.
    && (query === "" || [row.name, row.id, row.description].some((text) => String(text ?? "").toLowerCase().includes(query))));
  const shown = matched.slice(0, state.browse.shown);
  const search = element("input", "text-field");
  search.type = "search";
  search.placeholder = "이름, 기능으로 찾기";
  search.value = state.browse.query;
  search.dataset.expose = "core.settings-tab.browse-search";
  mark(search, "core.settings-tab.browse", { hideInstalled: hide }, "query");
  search.dataset.live = "";
  const switchEl = toggle("hideInstalled", hide, {
    expose: "core.settings-tab.browse-hide", command: "core.settings-tab.browse", params: { query: state.browse.query }, valueName: "hideInstalled", label: "설치한 것 숨기기",
  });
  const count = element("p", "set-caption", query === "" && !hide ? `${all.length}개` : `${shown.length} / ${all.length}개`);
  const list = element("div", "set-plugin-list");
  for (const row of shown) list.append(catalogRow(row));
  if (shown.length === 0) list.append(element("p", "set-caption", "맞는 플러그인이 없다."));
  const parts = [row({ label: "", control: search, key: "browse-query" }), row({ label: "설치한 것 숨기기", control: switchEl, key: "browse-hide" }), count, list];
  if (matched.length > shown.length) {
    const next = Math.min(30, matched.length - shown.length);
    parts.push(button(`${next}개 더 보기`, { expose: "core.settings-tab.browse-more", command: "core.settings-tab.browse", params: { more: true }, variant: "sm" }));
  }
  return [group("플러그인 찾아보기", `카탈로그 ${all.length}개. 하나를 누르면 설치 전에 자세히 본다.`, parts)];
}

/** The description line of a plugin, a named element of the plugin pages (docs/spec/settings.md#plugin-page). */
function descriptionLine(text) {
  const el = element("p", "set-caption", text);
  el.dataset.expose = "core.settings-tab.plugins.about";
  return el;
}

/** The version text of a catalog plugin: its latest version, or the line that no version fits the running core (docs/spec/installation.md#plugin-states). */
export function versionText(item) {
  if (item.latest !== null) return `v${item.latest}`;
  if (item.incompatible) return `core ${pluginOperations.status().core}에 맞는 버전 없음`;
  // A version that is not known is left out (docs/spec/settings.md#plugins).
  return item.installed === null ? "" : `v${item.installed.version}`;
}

/** One row of Browse (docs/spec/settings.md#plugins). */
function catalogRow(item) {
  const el = element("div", "set-plugin-row");
  el.dataset.plugin = item.id;
  el.append(letter(item.name));
  const head = element("div", "set-plugin-row__head");
  const name = button(item.name, { expose: "core.settings-tab.browse-row", command: "core.settings-tab.plugin", params: { plugin: item.id }, key: `plugin:${item.id}`, variant: "name" });
  head.append(name);
  for (const id of missingDependencies(item)) head.append(badge(`${id} 필요`, "warn"));
  if (item.description) head.append(descriptionLine(item.description));
  head.append(element("p", "set-caption", [item.id, versionText(item)].filter(Boolean).join(" · ")));
  const actions = element("div", "set-plugin-row__actions");
  if (item.installed === null) actions.append(action(item.id, "install", "설치", "core.plugins.install", { plugin: item.id }, "primary"));
  else if (item.installed.enabled) actions.append(badge("설치됨", "ok"));
  else actions.append(badge("설치됨 · 꺼짐", "neutral"));
  el.append(head, actions);
  return el;
}

/** The page of one plugin: its info card, then the groups Accounts, Settings, Sections, window sidebar and card sidebar (docs/spec/settings.md#plugin-page). */
export function pluginPage(id) {
  const item = statusRows().find((row) => row.id === id);
  if (!item) throw new Error(`plugin ${id} is not in the plugin state`);
  // default: a plugin that is not loaded has no unit.
  const unit = pluginUnits().find((u) => u.id === id) ?? null;
  const body = [];
  body.push(infoCard(item, unit));
  if (unit && pluginAccounts(id)?.accounts) body.push(accountsGroup(unit));
  body.push(settingsGroup(unit));
  // The group of a plugin without sections is not drawn (docs/spec/settings.md#plugin-page).
  if (unit && unit.sections.length > 0) body.push(group("섹션", "이 플러그인이 사이드바에 제공하는 섹션.", [sectionChips(unit)]));
  // The window selectors come from the loaded manifest; a plugin that is not loaded declares none, so its group does not show.
  if (unit) body.push(group("창 사이드바", "이 플러그인의 탭이 포커스 카드의 활성 탭인 동안 쓰는 창 사이드바. 세트를 고른 변만 바뀌고, 위에 있는 줄부터 자리를 잡는다.",
    [sideList({ order: `${id}.win.order`, place: (side) => `window-${side}`, plugin: id, title: "창 사이드바" })]));
  if (unit?.surface) body.push(group("카드 사이드바", "카드 안쪽 네 변. 세트를 고른 변만 보이고, 위에 있는 줄부터 자리를 잡는다. 순서는 이 플러그인의 카드에만 적용된다.",
    [sideList({ order: `${id}.card.order`, place: (side) => `card-${side}`, plugin: id, title: "카드 사이드바" })]));
  return body;
}

/** The labels of the states of a contribution to an extension point (docs/spec/plugins.md#extension-points). */
const CONTRIBUTION_STATES = { connected: "연결됨", "provider-missing": "제공자 없음", "version-mismatch": "version 불일치", invalid: "오류" };

/** One line for each contribution of the plugin: its point, its number and its state; an invalid contribution shows its error through the error display. */
function contributionLines(id) {
  return contributionsState().filter((entry) => entry.plugin === id).map((entry) => {
    if (!Object.hasOwn(CONTRIBUTION_STATES, entry.state)) throw new Error(`contribution of ${id} has an unknown state ${entry.state}`);
    const where = `plugin ${id} contribution ${entry.point} ${entry.index + 1}`;
    // An invalid contribution shows its reason in place of the state label, and the error display marks it as an error.
    const text = entry.state === "invalid" ? `${entry.point} 기여 ${entry.index + 1}: ${entry.reason}` : `${entry.point} 기여 ${entry.index + 1}: ${CONTRIBUTION_STATES[entry.state]}`;
    if (entry.state === "invalid") showTabError(where, text);
    else hideTabError(where);
    const el = element("p", "set-caption", text);
    el.dataset.expose = "core.settings-tab.plugins.contribution";
    el.dataset.state = entry.state;
    return el;
  });
}

/** The info card of a plugin: before installation the install line, after it the switch, the dependency line and the removal (docs/spec/settings.md#plugin-page). */
function infoCard(item, unit) {
  const card = element("div", "set-plugin-info");
  const head = row({ label: item.name, description: `${item.id}${item.latest ? ` · v${item.latest}` : ""}`, control: null, key: "info" });
  card.append(head);
  if (item.description) card.append(descriptionLine(item.description));
  card.append(...contributionLines(item.id));
  if (item.installed === null) {
    card.append(row({ label: "설치", control: action(item.id, "install", "설치", "core.plugins.install", { plugin: item.id }, "primary"), key: "install" }));
    card.append(row({ label: "사이드카", description: sidecarText(item.sidecars), key: "sidecars" }));
    // An uninstalled plugin has no loaded manifest, so the row Contributes is the dash (docs/spec/settings.md#plugin-page).
    card.append(row({ label: "더하는 것", description: "—", key: "contributes" }));
    return card;
  }
  const controls = [];
  if (developmentBuild(item)) controls.push(badge("개발 빌드", "warn", { title: `설치 ${item.installed.version} > 배포 ${item.latest}` }));
  controls.push(enableSwitch(item));
  if (hasUpdate(item)) controls.push(action(item.id, "update", `${item.latest} 로 업데이트`, "core.plugins.update", { plugin: item.id }));
  const ending = heldAction(item.id);
  if (ending) controls.push(ending);
  card.append(row({ label: "사용", description: useMetaOf(item), key: "enable", extras: controls }));
  for (const id of missingDependencies(item)) {
    const name = nameOfPlugin(id);
    card.append(row({ label: "필요", description: `필요한 ${name}(${id}) 플러그인이 설치되어 있지 않다.`, control: action(item.id, "install-dependency", `${name} 설치`, "core.plugins.install", { plugin: id }, "primary"), key: "requires" }));
  }
  card.append(removal(item));
  return card;
}

/** The removal control: the description, the button Remove…, and after it the buttons Cancel and Remove (docs/spec/settings.md#plugin-page). */
function removal(item) {
  const wrap = element("div", "set-removal");
  wrap.append(element("p", "set-caption", "설정 값은 남겨 두고, 다시 설치하면 이어서 쓴다."));
  const asked = state.confirm !== null && state.confirm.kind === "plugin" && state.confirm.id === item.id;
  if (!asked) {
    wrap.append(button("제거…", { expose: "core.settings-tab.delete", command: "core.settings-tab.confirm", params: { kind: "plugin", id: item.id, answer: "ask" }, variant: "danger" }));
    return wrap;
  }
  wrap.append(button("취소", { expose: "core.settings-tab.confirm-no", command: "core.settings-tab.confirm", params: { kind: "plugin", id: item.id, answer: "no" }, variant: "ghost" }));
  wrap.append(button("제거", { expose: "core.settings-tab.confirm-yes", command: "core.settings-tab.confirm", params: { kind: "plugin", id: item.id, answer: "yes" }, variant: "danger" }));
  return wrap;
}

/** The sections of a plugin as read-only chips. */
function sectionChips(unit) {
  const wrap = element("span", "set-chips");
  for (const name of sectionNames(unit.sections)) wrap.append(element("span", "set-chip set-chip--neutral", name));
  return wrap;
}

/** The group Settings with one row for each declared setting (docs/spec/settings.md#plugin-page). */
function settingsGroup(unit) {
  const defs = Object.entries(settingDefinitions()).filter(([, def]) => unit && def.plugin === unit.id);
  if (!unit || defs.length === 0) return group("설정", "플러그인이 선언한 설정.", [element("p", "set-caption", "이 플러그인에는 설정이 없다.")]);
  return group("설정", "플러그인이 선언한 설정.", defs.flatMap(([key, def]) => declaredRow(key, def)));
}

/** One row of a declared setting, drawn with the control of its form (docs/spec/plugins.md#settings-declarations). */
export function declaredRow(key, def) {
  const now = shownValue(key);
  const disabled = !editable(key);
  let control;
  if (def.type === "enum") {
    const options = def.values.map((value) => [value, String(value)]);
    control = options.length <= 3 ? choice(key, options, now, { disabled }) : select(key, options, now, { disabled });
  } else if (def.type === "integer") control = slider(key, [def.minimum, def.maximum], now, { disabled });
  else if (def.type === "string" || def.type === "address") control = textField(key, { command: "core.settings.change", params: { key, scope: writeScope() }, now: String(now), maxLength: def.maxLength, mono: def.type === "address" });
  else if (def.type === "plugin") {
    const options = [...(now === undefined ? [["", "선택"]] : []), ...pluginsOfCategory(def.category).map(({ id, name }) => [id, name])];
    // default: docs/spec/settings.md#plugins, a plugin setting without a value shows the empty choice labelled Choose.
    control = select(key, options, now ?? "", { disabled });
  } else throw new Error(`setting ${key} has an unknown type ${def.type}`);
  const marks = scopeMarks(key, def.label);
  if (def.type === "plugin" && missingPluginValue(key) !== undefined) marks.push(badge(`${missingPluginValue(key)} 필요`, "warn"));
  // default: a setting declaration without a description has none (docs/spec/plugins.md, description is optional).
  const el = row({ label: def.label, description: def.description ?? null, control, key, extras: marks });
  return [el];
}

/** The group Accounts of a plugin that declares accounts (docs/spec/plugins.md#accounts). */
function accountsGroup(unit) {
  const declared = pluginAccounts(unit.id).accounts;
  const listed = accounts.list(unit.id);
  const rows = listed.map((account) => accountRow(unit.id, declared.kinds, account));
  // default: docs/spec/settings.md#plugins, the new account form selects the first declared kind until the person chooses one.
  const kindSelect = select("account-kind", declared.kinds.map((item) => [item.value, item.label]), state.account.kind ?? declared.kinds[0].value, {
    command: "core.settings-tab.account-kind", params: {}, valueName: "kind", expose: "core.settings-tab.account-kind",
  });
  const nameField = textField("account-name", { command: "core.settings-tab.account-name", params: {}, now: state.account.name, maxLength: 40, valueName: "name", expose: "core.settings-tab.account-name" });
  // default: docs/spec/settings.md#plugins, the new account form selects the first declared kind until the person chooses one.
  const add = button("추가", { expose: "core.settings-tab.account-add", command: "core.accounts.add", params: { plugin: unit.id, name: state.account.name, kind: state.account.kind ?? declared.kinds[0].value }, disabled: state.account.name === "", variant: "primary" });
  const fresh = element("div", "set-account set-account--new");
  fresh.append(nameField, kindSelect, add);
  return group("계정", ACCOUNTS_DESCRIPTION, [...rows, row({ label: "새 계정", control: fresh, key: "account-new", wide: true })]);
}

/** The login text of an account (docs/spec/plugins.md#accounts). */
function loginText(account) {
  if (account.running) return "로그인 중";
  if (account.login === true) return account.until === null ? "로그인됨" : `로그인됨 · ${account.until}까지`;
  if (account.login === false) return "로그인 안 됨";
  return "-";
}

/** One account row: its identifier, its CLI kind, its login state and its usage, and its buttons (docs/spec/settings.md#plugin-page). */
function accountRow(plugin, kinds, account) {
  const el = element("div", "set-account");
  el.dataset.expose = "core.settings-tab.account";
  el.dataset.account = account.id;
  // default: docs/spec/settings.md#plugins, an account whose kind the declaration no longer names shows its kind value.
  const kind = kinds.find((item) => item.value === account.kind)?.label ?? account.kind;
  el.append(element("p", "set-account__line", `${account.id} · ${kind} · ${loginText(account)}`));
  for (const usage of account.usage) {
    el.append(element("p", "set-caption", usage.resets === null ? `${usage.label} ${usage.used}%` : `${usage.label} ${usage.used}% · ${usage.resets} 초기화`));
  }
  const params = { plugin, id: account.id };
  const buttons = element("div", "set-account__buttons");
  if (state.account.edit === account.id) {
    buttons.append(
      textField(`account-edit-name:${account.id}`, { command: "core.settings-tab.account-edit-name", params: {}, now: state.account.editName, maxLength: 40, valueName: "name", expose: "core.settings-tab.account-edit-name" }),
      button("저장", { expose: "core.settings-tab.account-save", command: "core.accounts.rename", params: { ...params, name: state.account.editName }, variant: "primary" }),
      button("취소", { expose: "core.settings-tab.account-edit-cancel", command: "core.settings-tab.account-edit", params: { id: null }, variant: "ghost" }),
    );
  } else {
    if (account.running) buttons.append(button("취소", { expose: "core.settings-tab.account-login-cancel", command: "core.accounts.login-cancel", params }));
    else if (account.login === false) buttons.append(button("로그인", { expose: "core.settings-tab.account-login", command: "core.accounts.login", params }));
    else if (account.login === true) buttons.append(button("로그아웃", { expose: "core.settings-tab.account-logout", command: "core.accounts.logout", params }));
    buttons.append(
      button("이름 변경", { expose: "core.settings-tab.account-edit", command: "core.settings-tab.account-edit", params: { id: account.id }, variant: "ghost" }),
      button("삭제", { expose: "core.settings-tab.account-remove", command: "core.accounts.remove", params, variant: "danger" }),
    );
  }
  el.append(buttons);
  return el;
}

/** The items of the group Plugins with settings: every installed plugin by id, whether or not it declares settings (docs/spec/settings.md#menu). */
export function pluginMenuItems() {
  return menuItemsOf(statusRows());
}

/** The installed rows of the state, by id; a plugin that is not installed has no item. */
export function menuItemsOf(rows) {
  return rows.filter((row) => row.installed !== null).toSorted((a, b) => a.id.localeCompare(b.id));
}
