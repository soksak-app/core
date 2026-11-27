// The core pages of the settings tab: 모양, 작업 공간, 동작, 에이전트 연동 and 진단 (docs/spec/settings.md#pages). Each row is drawn from the
// declaration of settings-rows.js, and each control runs the declared command of its form (docs/spec/settings.md#controls).
import { debugOn, overridden, THEMES } from "./settings.js";
import { GROUPS, choicesOf, rangeOf, rowsOf } from "./settings-rows.js";
import { badge, button, choice, element, row, scopeMarks, slider, stepper, toggle, editable } from "./settings-controls.js";
import { sideList } from "./settings-sides.js";
import { state, shownValue, writeScope, projectSelected, projectTitle, commonOnly } from "./settings-state.js";
import { setupParts } from "./setup-exposure.js";
import { missingKinds } from "./setup-parts.js";
import { hideTabError, showTabError } from "./settings-errors.js";
import { mark } from "./commands.js";

/** Creates one group: its name, its description, and its rows. A declared group carries its id as data-group (docs/spec/settings.md#rows). */
export function group(name, description, children, id) {
  const el = element("section", "set-group");
  if (id !== undefined) el.dataset.group = id;
  el.append(element("h3", "set-group__name", name), element("p", "set-caption", description), ...children);
  return el;
}

/** The group of a page with the name, which the pages draw in their own places. */
const groupOf = (page, name) => {
  const found = GROUPS[page].find((item) => item.name === name);
  if (!found) throw new Error(`settings group ${name} is not declared in ${page}`);
  return found;
};

/** The labels of a choice setting, by value, for a badge or a chip. */
const labelsOf = (key) => Object.fromEntries(choicesOf(key));

/** The swatch of one theme: its colors are the colors of that theme, and it runs core.settings.theme (docs/spec/settings.md#pages). */
function swatch(theme) {
  const el = element("button", "th");
  el.type = "button";
  el.dataset.expose = "core.settings-tab.theme";
  el.dataset.key = `theme:${theme.name}`;
  el.dataset.on = String(theme.name === shownValue("theme"));
  el.setAttribute("aria-pressed", String(theme.name === shownValue("theme")));
  mark(el, "core.settings.theme", { name: theme.name, scope: writeScope() });
  const c = theme[shownValue("mode")];
  const gap = parseFloat(theme.shape.gap);
  // The swatch is drawn in its own colors, so the difference of two themes shows; a gap of 0 keeps a 1px line between the two cards.
  const slit = gap === 0 ? 1 : Math.max(2, Math.round(gap / 4));
  const between = gap === 0 ? c.rule : c.bg;
  const r = Math.min(parseFloat(theme.shape.r) / 2, 5);
  el.innerHTML =
    `<span class="th__box" style="background:${c.bg};border-color:${c.edge}">` +
    `<span class="th__rail" style="background:${c.rail}"></span>` +
    `<span class="th__pair" style="gap:${slit}px;background:${between}">` +
      `<span class="th__card" style="background:${c.card};border-color:${c.edge};border-radius:${r}px">` +
        `<span class="th__dot" style="background:${c.focus}"></span></span>` +
      `<span class="th__card" style="background:${c.card};border-color:${c.edge};border-radius:${r}px"></span>` +
    `</span></span>` +
    `<span class="th__name">${theme.name}</span>`;
  return el;
}

/** The theme row: the swatch grid of the themes, with the chip of a project override (docs/spec/settings.md#scope-of-a-control). */
function themeRow() {
  const grid = element("div", "th-grid");
  for (const theme of THEMES) grid.append(swatch(theme));
  const marks = scopeMarks("theme", "테마");
  return row({ wide: true, control: grid, key: "theme", extras: marks });
}

/** One row of a core setting, drawn with the control of its form. */
export function settingRow(def) {
  const { key, label, form, unit = "", description = null, depends = null } = def;
  const parentOff = depends !== null && shownValue(depends) === false;
  const disabled = !editable(key) || parentOff;
  const labels = form === "choice" ? labelsOf(key) : null;
  let control;
  if (form === "choice") control = choice(key, choicesOf(key), shownValue(key), { disabled });
  else if (form === "switch") control = toggle(key, shownValue(key), { disabled });
  else if (form === "slider") control = slider(key, rangeOf(key), shownValue(key), { unit, disabled });
  else if (form === "stepper") control = stepper(key, rangeOf(key), shownValue(key), { unit, disabled });
  else throw new Error(`settings row ${key} has form ${form}, which settingRow does not draw`);
  return row({ label, description, control, key, indent: depends !== null, extras: scopeMarks(key, label, labels, unit) });
}

/** The element of one core row of any form, as the pages and the search draw it (docs/spec/settings.md#pages). */
export function coreRowFor(def) {
  if (def.form === "theme") return themeRow();
  if (def.form === "debug") return debugRow();
  if (def.form === "sidebar") return sideList({ order: "sidebarOrder", place: (side) => side, sideSwitch: (side) => side, title: "사이드바" });
  return settingRow(def);
}

/** The rows of a group of a core page, in their order. */
function rowsOfGroup(page, name) {
  return groupOf(page, name).rows.map((def) => coreRowFor(def));
}

/** The debug switch: on when the performance trace is on and every log class is at trace (docs/spec/settings.md#진단). */
function debugRow() {
  const el = element("input", "set-switch");
  el.type = "checkbox";
  el.checked = debugOn();
  el.dataset.expose = "core.settings-tab.debug";
  mark(el, "core.settings.debug", {}, "on");
  return row({ label: "디버그 기록", control: el, key: "debug" });
}

/** The look page: a preview of the cards with the applied values, then the groups (docs/spec/settings.md#pages). */
export function lookPage() {
  const preview = element("div", "set-preview");
  for (const name of ["터미널", "브라우저"]) {
    const card = element("div", "set-preview__card");
    card.append(element("div", "set-preview__head", name));
    card.append(element("div", "set-preview__body", name === "터미널" ? "~/project $ claude" : "GET /settings   200"));
    preview.append(card);
  }
  return [
    preview,
    ...GROUPS.look.map((item) => group(item.name, item.description, rowsOfGroup("look", item.name), item.id)),
  ];
}

/** The window sidebar rows of 작업 공간, the set select of the side and the on/off switch (docs/spec/settings.md#작업-공간). */
function sidebarGroup() {
  const sides = sideList({ order: "sidebarOrder", place: (side) => side, sideSwitch: (side) => side, title: "사이드바" });
  // The shortcuts follow a fixed order, not the rows (docs/spec/settings.md#작업-공간).
  const shortcuts = element("p", "set-caption", "⌘B 왼쪽 · ⌥⌘B 오른쪽 · ⇧⌘J 위 · ⌘J 아래");
  const declared = groupOf("workspace", "사이드바");
  return group("사이드바", declared.description, [sides, shortcuts], declared.id);
}

/**
 * The size rules of the sidebar widths in the effective values of the shown scope (docs/spec/settings.md#작업-공간). A failing rule shows its
 * line through the error display and, when a fix exists, the fix button under the group.
 */
export function sizeGroup() {
  const min = shownValue("sidebarMinWidth");
  const max = shownValue("sidebarMaxWidth");
  const width = shownValue("sidebarWidth");
  const sizes = groupOf("workspace", "사이드바 크기");
  const children = sizes.rows.map((def) => settingRow(def));
  const where = "settings sidebar-size";
  if (min >= max) showTabError(where, `최소 폭(${min}pt)이 최대 폭(${max}pt)보다 작아야 한다.`);
  else if (width < min || width > max) {
    const cut = Math.min(max, Math.max(min, width));
    showTabError(where, `처음 폭 ${width}pt가 범위 ${min}–${max}pt 밖이다.`);
    children.push(button("범위 안으로 맞추기", {
      expose: "core.settings-tab.fix", command: "core.settings.change", params: { key: "sidebarWidth", value: cut, scope: writeScope() }, key: "sidebarWidth", variant: "sm",
    }));
  } else hideTabError(where);
  return group(sizes.name, sizes.description, children, sizes.id);
}

/** The workspace page: the project and position groups, the four-row sidebar list, and the sizes (docs/spec/settings.md#작업-공간). */
export function workspacePage() {
  return [
    ...["프로젝트", "위치"].map((name) => group(name, groupOf("workspace", name).description, rowsOfGroup("workspace", name), groupOf("workspace", name).id)),
    sidebarGroup(),
    sizeGroup(),
  ];
}

/** The behavior page: language, cards, memory and notifications (docs/spec/settings.md#pages). */
export function behaviorPage() {
  return GROUPS.behavior.map((item) => group(item.name, item.description, rowsOfGroup("behavior", item.name), item.id));
}

/** The diagnostics page (docs/spec/settings.md#진단). */
export function diagPage() {
  return GROUPS.diag.map((item) => group(item.name, item.description, rowsOfGroup("diag", item.name), item.id));
}

/** The name of a setup part, and the state label of its state (docs/spec/settings.md#agents). */
const SETUP_NAMES = { path: "명령 경로", skill: "스킬", mcp: "MCP 등록", hook: "훅" };
const SETUP_STATES = { ok: ["설치됨", "ok"], missing: ["없음", "warn"] };

/** Whether a part differs: the producer reports a missing part whose reason is differs or `<kind> differs` (docs/spec/cli.md#setup-parts). */
const differs = (part) => part.state === "missing" && part.reason?.endsWith("differs") === true;

/** The count of setup parts that are not ok, for the menu badge (docs/spec/settings.md#menu). */
export const setupWarnings = () => setupParts.parts().filter((part) => part.state !== "ok").length;

/** The agent page: the summary, one row for each part that applies, and the buttons (docs/spec/settings.md#agents). */
export function agentsPage() {
  const parts = setupParts.parts();
  const warn = parts.filter((part) => part.state !== "ok").length;
  const summary = warn ? badge(`${parts.length}개 중 ${warn}개가 다름`, "warn") : badge("모두 설치됨", "ok");
  const rows = parts.map((part) => {
    const where = `setup:${part.part}:${part.file}`;
    let state;
    if (part.state === "error") {
      state = badge("오류", "err");
      showTabError(where, part.error);
    } else {
      hideTabError(where);
      if (part.part === "path" && part.enabled === false) state = badge("사용 안 함", "neutral");
      else if (differs(part)) state = badge("다름", "warn");
      else state = badge(...SETUP_STATES[part.state]);
    }
    const actions = [];
    if (part.part === "path" && typeof part.enabled === "boolean") {
      actions.push(button(part.enabled ? "끄기" : "켜기", {
        expose: "core.settings-tab.setup-change", command: "core.setup.change", params: { part: "path", enabled: !part.enabled }, key: where, variant: "sm",
      }));
    } else if ((part.part === "skill" || part.part === "mcp") && part.state === "missing") {
      actions.push(button(differs(part) ? "고치기" : "설치", {
        expose: "core.settings-tab.setup-install", command: "core.setup.install", params: { parts: [part.part] }, key: where, variant: "sm",
      }));
    }
    const control = element("span", "set-setup");
    control.append(state, element("span", "set-caption", part.file));
    const el = row({ label: SETUP_NAMES[part.part], control, key: where, extras: actions });
    el.dataset.expose = "core.settings-tab.setup";
    return el;
  });
  if (!rows.length) rows.push(element("p", "set-caption", "이 컴퓨터에서 설정할 에이전트 항목이 없습니다."));
  const kinds = missingKinds(parts);
  const actions = element("div", "set-actions");
  actions.append(
    summary,
    button("다시 확인", { expose: "core.settings-tab.setup-check", command: "core.setup.check", params: {}, variant: "sm" }),
    button("모두 설치", { expose: "core.settings-tab.setup-install-all", command: "core.setup.install", params: { parts: kinds }, disabled: kinds.length === 0, variant: "primary" }),
  );
  return [group("연동 상태", "에이전트가 이 애플리케이션을 배우고 다루게 하는 항목.", [...rows, actions])];
}

/** The keys of a page that a project can override: its rows, the sidebar keys of 작업 공간, and the sets of 사이드바 세트 (docs/spec/settings.md#scope-of-a-control). */
const PAGE_KEYS = {
  look: () => rowsOf("look").map((def) => def.key),
  workspace: () => [...rowsOf("workspace").map((def) => def.key), "left", "right", "top", "bottom", "links"],
  sets: () => ["sets", "links"],
  behavior: () => rowsOf("behavior").map((def) => def.key),
  agents: () => [],
  diag: () => [],
};

/**
 * The scope control of the page head (docs/spec/settings.md#page-head): the segment 전역 | <project> · <n> while a project is selected and the page
 * has a setting that a project can override, the badge 전역 전용 when the page has settings but none that a project can override, and null otherwise.
 */
export function headScope(page) {
  const overridable = PAGE_KEYS[page]().filter((key) => !commonOnly(key));
  if (overridable.length === 0) return PAGE_KEYS[page]().length ? badge("전역 전용", "neutral") : null;
  return projectSelected() ? scopeSegment(overridable) : null;
}

/** The scope segment 전역 | <project> · <n>; n counts the keys of the page that the selected project overrides. */
export function scopeSegment(keys) {
  const wrap = element("span", "set-seg set-scope");
  wrap.setAttribute("role", "group");
  wrap.setAttribute("aria-label", "설정 범위");
  const count = keys.filter((key) => overridden(key)).length;
  for (const [scope, label] of [["common", "전역"], ["project", `${projectTitle()} · ${count}`]]) {
    const el = button(label, { expose: "core.settings-tab.scope", command: "core.settings-tab.scope", params: { scope }, on: state.scope === scope, variant: "seg" });
    el.setAttribute("aria-pressed", String(state.scope === scope));
    wrap.append(el);
  }
  return wrap;
}
