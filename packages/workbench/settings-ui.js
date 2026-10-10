// The settings modal.
//
// A 560px card. The header holds the title and the close button, the left holds the list of sections, and the right holds rows of the form "name 124px +
// control". Rows are divided into groups, and each group has a name and a one-line description.
//
// Each setting format has one control (Controls in docs/spec/settings.md). An on/off value is a
// switch, one of listed values is a select box, a theme is a swatch grid, a bounded integer is a slider,
// a string and an address are a text input, and a set reference is a select box. The default select and checkbox do not follow the colors of the theme,
// so the controls use the appearance of app.css.
//
// This is a [data-native-modal] element. A DOM cannot be drawn over a native surface, so the host
// renders this element in a separate view. That view is a copy, so a listener registered here does
// not work. Every control gets data-key or data-set, and the responses are received by the single function answer(). Each control
// points with data-command to the core command to run, and answer() runs that
// command.
import { standIn } from "./compositor.js";
import { native, overlay } from "./host.js";
import { active } from "./projects.js";
import { icon } from "./icons.js";
import { onGripDrag, showValue } from "./card.js";
import { commandOf, delegate, mark, run } from "./commands.js";
import { pluginUnits } from "./environment.js";
import { matchPlugins } from "./plugin-search.js";
import { restoreScroll, scrollPositions } from "./scroll-keep.js";
import { hasSection, section, sectionNames } from "./registry.js";
import {
  CHOICES, FONTS, LAYOUT_RANGES, MENU_LANGUAGES, SHAPE_RANGES, THEMES, scopedValue, settingProject, overridden,
  settingDefinitions,
} from "./settings.js";

/* It exists only while open. If it were kept hidden, CSS would decide whether it is shown, and
   [hidden] cannot override a rule that sets display. */
let scrim = null;
let card = null;
let nav = null;
let body = null;

/** The current section. It is kept after closing, and the same section is shown when the modal opens again. */
let here = "general";
let scope = "common";
/** The id of the plugin whose page is open in the plugin section. When it is null, the list is shown. */
let chosen = null;
/** The search term of the plugin list. */
let query = "";
/** The id of the set being edited in the sidebar section. null when there is none. */
let editing = null;
const value = (key) => scopedValue(key, scope);
const themeName = () => value("theme");
const modeName = () => value("mode");
const gapSetting = () => value("gap");

/** Creates one row of the form "name + control". */
function row(label, control) {
  const el = document.createElement("label");
  el.className = "set-row";
  const name = document.createElement("span");
  name.className = "set-row__name";
  name.textContent = label;
  el.append(name, control);
  const field = control.matches("[data-set]") ? control : control.querySelector("[data-set]");
  // default: a row without a setting control (a row with only a button) has no key.
  const key = field?.dataset.set;
  if (scope === "project" && key && overridden(key)) {
    const resetButton = press(`reset:${key}`, "전역값 사용");
    resetButton.classList.add("set-reset");
    el.append(resetButton);
  }
  return el;
}

/**
 * Creates one group of rows: a name, a one-line description, and the rows.
 *
 * If rows were only placed side by side, it would not show which of them change the layout and which change only the display.
 */
function group(name, text, children) {
  const el = document.createElement("section");
  el.className = "set-group";
  const head = document.createElement("h4");
  head.className = "set-group__name";
  head.textContent = name;
  const cap = document.createElement("p");
  cap.className = "set-caption";
  cap.textContent = text;
  el.append(head, cap, ...children);
  return el;
}

/* Sets the current value as an attribute, not as a property.
   What is sent to the host is innerHTML, and only attributes are serialized.
   If checked/selected/value were set only as properties, the copy would render with the initial values. */

/**
 * The command of a control that inputs a value. For a setting name it is core.settings.change, and for a sidebar link
 * (link:<position>:<plugin>) it is core.settings.link.
 */
function valueCommand(el, key) {
  const [kind, place, plugin] = key.split(":");
  // default: a key such as link:left: whose plugin part is empty is a general choice, so plugin is null (docs/spec/settings.md).
  if (kind === "link") mark(el, "core.settings.link", { place, plugin: plugin || null, scope }, "set");
  else mark(el, "core.settings.change", { key, scope });
}

/** Creates a select box. The caller connects the command. Throws when the current value is not among the choices. */
function selectBox(key, options, now) {
  if (!options.some(([value]) => value === now)) throw new Error(`unknown settings choice ${String(now)} for ${key}`);
  const wrap = document.createElement("span");
  wrap.className = "select-field";
  const el = document.createElement("select");
  el.dataset.set = key;
  el.dataset.expose = "core.settings-modal.set";
  for (const [v, label] of options) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = label;
    if (v === now) o.setAttribute("selected", "");
    el.appendChild(o);
  }
  wrap.appendChild(el);
  return wrap;
}

/** The select box of a setting. The selected value goes with key to core.settings.change or core.settings.link. */
function choose(key, options, now) {
  const wrap = selectBox(key, options, now);
  valueCommand(wrap.firstChild, key);
  return wrap;
}

/** Gives names to the choices of a setting. The choices and their order are decided by CHOICES in settings.js. */
function named(key, labels) {
  return CHOICES[key].map((choice) => {
    if (!Object.hasOwn(labels, choice)) throw new Error(`settings choice ${choice} of ${key} has no label`);
    return [choice, labels[choice]];
  });
}

/**
 * The scope tabs. They place buttons that choose the visible scope, not a setting, in one line. They are buttons, so unlike a select they arrive as a click, not as a
 * change, and they send the value together in key.
 */
function scopeTabs(options, now) {
  const el = document.createElement("span");
  el.className = "set-seg";
  for (const [v, label] of options) {
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.key = `pick:scope:${v}`;
    b.dataset.expose = "core.settings-modal.scope";
    mark(b, "core.settings-modal.scope", { scope: v });
    b.dataset.on = String(v === now);
    b.textContent = label;
    el.appendChild(b);
  }
  return el;
}

/** An on/off value. */
function toggle(key, now) {
  const el = document.createElement("input");
  el.type = "checkbox";
  el.className = "set-switch";
  el.dataset.set = key;
  el.dataset.expose = "core.settings-modal.set";
  valueCommand(el, key);
  el.toggleAttribute("checked", now);
  return el;
}

/** Creates a range input and a value display. */
function slide(key, min, max, now, unit) {
  const wrap = document.createElement("span");
  wrap.className = "set-slide";
  const el = document.createElement("input");
  el.type = "range";
  el.dataset.set = key;
  el.dataset.expose = "core.settings-modal.set";
  valueCommand(el, key);
  el.min = String(min);
  el.max = String(max);
  el.setAttribute("value", String(now));
  const out = document.createElement("output");
  out.textContent = `${now}${unit}`;
  wrap.append(el, out);
  return wrap;
}

/** A one-line string input. The value arrives as change. */
function text(key, maxLength, now) {
  const el = document.createElement("input");
  el.type = "text";
  el.className = "set-text";
  el.dataset.set = key;
  el.dataset.expose = "core.settings-modal.set";
  valueCommand(el, key);
  el.maxLength = maxLength;
  el.setAttribute("value", String(now));
  return el;
}

/** Creates a button. */
function press(key, label) {
  const el = document.createElement("button");
  el.className = "ui-button";
  el.type = "button";
  el.dataset.key = key;
  el.dataset.expose = "core.settings-modal.reset";
  mark(el, "core.settings.reset", { key: key.split(":")[1] });
  el.textContent = label;
  return el;
}

/**
 * Creates one theme swatch.
 *
 * It draws five values in one box: background, card, border, rail and focus. If only two cells were painted, the differences between
 * themes would not show. The corners are also drawn with the value of that theme.
 */
function swatch(theme) {
  const el = document.createElement("button");
  el.className = "th";
  el.type = "button";
  el.dataset.key = `theme:${theme.name}`;
  el.dataset.expose = "core.settings-modal.theme";
  mark(el, "core.settings.theme", { name: theme.name, scope });
  el.dataset.on = String(theme.name === themeName());
  const c = theme[modeName()];
  const gap = parseFloat(theme.shape.gap);
  // The swatch is 42px, so using the actual value as it is would let the gap fill the box. The gap is halved, but
  // a theme with gap 0 keeps 1px and paints it with the boundary line color. That 1px is the line that the two
  // cards share.
  const slit = gap === 0 ? 1 : Math.max(2, Math.round(gap / 2));
  const between = gap === 0 ? c.rule : c.bg;
  const r = Math.min(parseFloat(theme.shape.r) / 2, 5);
  el.innerHTML =
    `<span class="th__box" style="background:${c.bg};border-color:${c.edge}">` +
    `<span class="th__rail" style="background:${c.rail}"></span>` +
    `<span class="th__pair" style="gap:${slit}px;background:${between}">` +
      `<span class="th__card" style="background:${c.card};border-color:${c.edge};` +
        `border-radius:${r}px">` +
        `<span class="th__dot" style="background:${c.focus}"></span></span>` +
      `<span class="th__card" style="background:${c.card};border-color:${c.edge};` +
        `border-radius:${r}px"></span>` +
    `</span></span>` +
    `<span class="th__name">${theme.name}</span>`;
  return el;
}

function drawGeneral() {
  const grid = document.createElement("div");
  grid.className = "th-grid";
  for (const t of THEMES) grid.appendChild(swatch(t));

  if (scope === "common") body.append(group("프로젝트", "프로젝트를 여는 방식은 모든 프로젝트에 적용됩니다. 이미 열린 창은 유지됩니다.", [
    row("열기 방식", choose("projectOpening", named("projectOpening", { tabs: "현재 창", windows: "별도 창" }), value("projectOpening"))),
  ]));
  if (scope === "project" && overridden("theme")) grid.append(press("reset:theme", "전역 테마 사용"));
  body.append(group("테마", "테마가 색과 형태의 기본값을 정하고, 모드는 그 테마의 밝은 쪽과 어두운 쪽을 고른다.", [
    grid,
    row("모드", choose("mode", named("mode", { dark: "어두움", light: "밝음" }), modeName())),
  ]));

  body.append(group("형태", "테마가 준 값에서 시작한다. 통로를 0 으로 내리면 카드가 선 하나를 공유한다.", [
    row("통로", slide("gap", ...SHAPE_RANGES.gap, gapSetting(), "px")),
    row("모서리", slide("radius", ...SHAPE_RANGES.radius, value("radius"), "px")),
    row("폰트", choose("font", FONTS.map((f) => [f.id, f.name]), value("font"))),
    row("글자 크기", slide("size", ...SHAPE_RANGES.size, value("size"), "px")),
  ]));

  body.append(group("위치", "프로젝트 탭이 놓이는 위치. 바꾸면 카드 배치도 함께 바뀐다.", [
    row("프로젝트 탭 위치", choose("projectTabs", named("projectTabs", { top: "위", left: "왼쪽" }), value("projectTabs"))),
  ]));

  body.append(group("사이드바", "표시 스위치는 해당 변의 모든 창 사이드바에 적용된다. 일반 세트와 플러그인 창 세트는 각각 독립된 열에 표시된다.", [
    row("왼쪽 사이드바 보이기", toggle("left", value("left"))),
    row("오른쪽 사이드바 보이기", toggle("right", value("right"))),
    row("왼쪽 사이드바 세트", choose("link:left:", generalOptions(), choiceOf("left", null))),
    row("오른쪽 사이드바 세트", choose("link:right:", generalOptions(), choiceOf("right", null))),
    ...(scope === "project" && overridden("links") ? [row("", press("reset:links", "전역 연결 사용"))] : []),
  ]));

  body.append(group("사이드바 크기", "사이드바의 폭(pt). 처음 폭은 카드 안 사이드바와 새 창 사이드바 열이 여는 폭이며 최소 폭과 최대 폭 사이여야 한다.",
    Object.entries(LAYOUT_RANGES).map(([key, [min, max]]) => row(SIZE_LABELS[key], slide(key, min, max, value(key), "pt")))));

  body.append(group("표시", "배치는 그대로 두고 보이는 모습만 바꾼다.", [
    row("포커스 표시", choose("focusInd", named("focusInd", { border: "테두리", corner: "꺽쇠" }), value("focusInd"))),
    row("경계선", choose("fullRule", named("fullRule", { under: "가림", over: "보임", none: "숨김" }), value("fullRule"))),
    row("포커스 밖 흐리게", toggle("dim", value("dim"))),
  ]));

  body.append(group("언어", "애플리케이션 메뉴가 이 언어를 따른다. 자동은 시스템 언어이고 목록에 없으면 영어다.", [
    row("언어", choose("language",
      [["auto", "자동"], ...MENU_LANGUAGES.map(({ id, label }) => [id, label])], value("language"))),
  ]));
}

/** Creates a button. It finds the response by key, exposes it by name, and points to a command. */
function button(key, name, label, command, params, on = null) {
  const el = document.createElement("button");
  el.className = "ui-button";
  el.type = "button";
  el.dataset.key = key;
  el.dataset.expose = name;
  mark(el, command, params);
  if (on !== null) el.dataset.on = String(on);
  el.textContent = label;
  return el;
}

/** The set entries of the set select box. The value is the set id. */
// default: a set without sections is shown as having no section.
const setItems = () => value("sets").map((s) => [s.id, `${s.title} — ${sectionNames(s.sections).join(" · ") || "섹션 없음"}`]);
/** The entries of a general choice: not used and every set. */
const generalOptions = () => [["off", "사용 안 함"], ...setItems()];
/** The current choice to show in the select box: a set id or off. */
function choiceOf(place, plugin) {
  const found = value("links").find((l) => l.place === place && l.plugin === plugin);
  if (!found) return "off";
  return found.set;
}

/** The controls of the plugin setting formats (Controls in docs/spec/settings.md), one per format. */
const DECLARED_CONTROLS = {
  enum: (key, definition, now) => choose(key, definition.values.map((item) => [item, item]), now),
  integer: (key, definition, now) => slide(key, definition.minimum, definition.maximum, now, ""),
  string: (key, definition, now) => text(key, definition.maxLength, now),
  address: (key, definition, now) => text(key, 2048, now),
};

/** One setting row. It is the control of the declared format. */
function declaredRow(key, definition) {
  if (!Object.hasOwn(DECLARED_CONTROLS, definition.type)) throw new Error(`setting ${key} has no control for type ${definition.type}`);
  const control = DECLARED_CONTROLS[definition.type](key, definition, value(key));
  const el = row(definition.label, control);
  el.dataset.row = key;
  if (!definition.description) return [el];
  // The description is one line right below the row. The rows of core.settings-modal report it together with the row.
  const note = document.createElement("p");
  note.className = "set-caption";
  note.dataset.describes = key;
  note.textContent = definition.description;
  return [el, note];
}

/** The description of one set line: title, layout and section names. */
// default: a set without sections is shown as having no section.
const setLine = (s) => `${s.title} · ${s.layout === "tabs" ? "탭" : "목록"} · ${sectionNames(s.sections).join(", ") || "섹션 없음"}`;

/** The plugin list: the plugin management button, the search field, and the rows of the loaded plugins that match the search term. A row shows only the name. */
function drawPluginList() {
  // The plugin page of the library shows installation, removal and the description (Plugin screen in docs/spec/installation.md).
  const manage = button("plugins:manage", "core.settings-modal.manage", "플러그인 관리", "core.plugins.browse", {});
  const search = document.createElement("input");
  search.type = "search";
  search.className = "set-text";
  search.placeholder = "이름, id, 설명으로 찾기";
  search.dataset.set = "plugin-search";
  search.dataset.expose = "core.settings-modal.search";
  mark(search, "core.settings-modal.search", {}, "query");
  search.setAttribute("value", query);
  const units = pluginUnits().toSorted((a, b) => a.id.localeCompare(b.id));
  const rows = matchPlugins(units, query).map((unit) =>
    button(`plugin:${unit.id}`, "core.settings-modal.plugin", unit.name, "core.settings-modal.plugin", { plugin: unit.id }));
  for (const el of rows) el.dataset.listed = el.dataset.key.slice("plugin:".length);
  if (!rows.length) {
    const none = document.createElement("p");
    none.className = "set-caption";
    none.textContent = "찾는 플러그인이 없습니다.";
    rows.push(none);
  }
  const list = document.createElement("div");
  list.className = "set-list";
  list.append(...rows);
  body.append(group("플러그인", "창이 불러온 플러그인의 설정. 설치, 업데이트, 제거와 플러그인 설명은 플러그인 관리에서 본다.",
    [row("", manage), row("찾기", search), list]));
}

/** The settings page of one loaded plugin: the button that returns to the list, the settings, the sections and the sidebar choices. */
function drawPluginPage(unit) {
  const back = button("plugins:list", "core.settings-modal.back", "목록", "core.settings-modal.plugin", { plugin: null });
  body.append(group(unit.name, unit.id, [row("", back)]));

  const declared = Object.entries(settingDefinitions()).filter(([, d]) => d.plugin === unit.id);
  if (declared.length) {
    body.append(group("설정", `${unit.name} 플러그인이 선언한 설정.`, declared.flatMap(([key, d]) => declaredRow(key, d))));
  } else {
    const none = document.createElement("p");
    none.className = "set-caption";
    none.textContent = "이 플러그인에는 설정이 없습니다.";
    body.append(group("설정", `${unit.name} 플러그인이 선언한 설정.`, [none]));
  }

  const names = document.createElement("p");
  names.className = "set-caption";
  names.textContent = unit.sections.length ? sectionNames(unit.sections).join(", ") : "이 플러그인에는 섹션이 없습니다.";
  body.append(group("섹션", "이 플러그인이 사이드바에 제공하는 섹션.", [names]));

  body.append(group("창 사이드바", "포커스와 무관하게 창 가장자리에 표시한다.", [
    row("창 왼쪽 사이드바", choose(`link:window-left:${unit.id}`, generalOptions(), choiceOf("window-left", unit.id))),
    row("창 오른쪽 사이드바", choose(`link:window-right:${unit.id}`, generalOptions(), choiceOf("window-right", unit.id))),
  ]));
  if (unit.surface) body.append(group("카드 사이드바", "카드 내부의 네 변에 표시한다.", [
    ...[["left", "왼쪽"], ["right", "오른쪽"], ["top", "상단"], ["bottom", "하단"]].map(([side,label]) =>
      row(`카드 ${label} 사이드바`, choose(`link:card-${side}:${unit.id}`, generalOptions(), choiceOf(`card-${side}`,unit.id)))),
  ]));
}

function drawPlugins() {
  const unit = pluginUnits().find((u) => u.id === chosen);
  if (unit) drawPluginPage(unit);
  else {
    chosen = null;
    drawPluginList();
  }
}

const SIZE_LABELS = {
  sidebarMinWidth: "최소 폭",
  sidebarMaxWidth: "최대 폭",
  sidebarWidth: "처음 폭",
};

/** The select box of one section row. It groups every registered section by plugin with optgroup. */
function sectionSelect(s, index, now) {
  const wrap = document.createElement("span");
  wrap.className = "select-field";
  const el = document.createElement("select");
  el.dataset.set = `row:${s.id}:${index}`;
  el.dataset.expose = "core.settings-modal.row";
  mark(el, "core.settings.sets.row", { id: s.id, action: "choose", index, scope }, "section");
  for (const u of pluginUnits().filter((item) => item.sections.length)) {
    const optgroup = document.createElement("optgroup");
    optgroup.label = u.name;
    for (const id of u.sections) {
      const o = document.createElement("option");
      o.value = id;
      o.textContent = section(id).name;
      if (id === now) o.setAttribute("selected", "");
      optgroup.append(o);
    }
    el.append(optgroup);
  }
  // The section of a plugin that is not loaded is not among the choices, so it is shown only as the current value. That value is kept separately so that the select box does not appear to
  // have chosen another section (docs/spec/plugins.md).
  if (!hasSection(now)) {
    const kept = document.createElement("optgroup");
    kept.label = "불러오지 않음";
    const o = document.createElement("option");
    o.value = now;
    [o.textContent] = sectionNames([now]);
    o.setAttribute("selected", "");
    kept.append(o);
    el.append(kept);
  }
  wrap.append(el);
  return wrap;
}

/** Set editing: the name, the layout, the section rows (a select box and the buttons up, down and remove), and one add button. */
function setEditor(s) {
  const title = document.createElement("input");
  title.type = "text";
  title.className = "set-text";
  title.dataset.set = `title:${s.id}`;
  title.dataset.expose = "core.settings-modal.set";
  mark(title, "core.settings.sets.update", { id: s.id, scope }, "title");
  title.maxLength = 40;
  title.setAttribute("value", s.title);
  const layout = selectBox(`layout:${s.id}`, [["list", "목록"], ["tabs", "탭"]], s.layout);
  mark(layout.firstChild, "core.settings.sets.update", { id: s.id, scope }, "layout");
  const rows = [row("이름", title), row("배치", layout)];
  s.sections.forEach((id, index) => {
    const acts = document.createElement("span");
    acts.className = "set-seg";
    const act = (action, label) => button(`${action}:${s.id}:${index}`, "core.settings-modal.row-act", label,
      "core.settings.sets.row", { id: s.id, action, index, scope });
    if (index > 0) acts.append(act("up", "▲"));
    if (index < s.sections.length - 1) acts.append(act("down", "▼"));
    acts.append(act("remove", "−"));
    const line = document.createElement("span");
    line.className = "set-seg";
    line.append(sectionSelect(s, index, id), acts);
    rows.push(row(`섹션 ${index + 1}`, line));
  });
  rows.push(row("", button(`add:${s.id}`, "core.settings-modal.add", "+", "core.settings.sets.row", { id: s.id, action: "add", scope })));
  rows.push(row("", button("edit:", "core.settings-modal.edit", "완료", "core.settings-modal.edit", { set: null })));
  return group(`세트 편집: ${s.title}`, "바꾼 값은 바로 저장된다. 같은 섹션은 한 세트에 한 번만 들어간다.", rows);
}

function drawSidebars() {
  const sets = value("sets");
  if (!sets.some((s) => s.id === editing)) editing = null;
  const rows = sets.map((s) => {
    const line = document.createElement("span");
    line.className = "set-caption";
    line.dataset.expose = "core.settings-modal.set-caption";
    line.textContent = setLine(s);
    const acts = document.createElement("span");
    acts.className = "set-seg";
    acts.append(
      button(`edit:${s.id}`, "core.settings-modal.edit", "편집", "core.settings-modal.edit", { set: s.id }, s.id === editing),
      button(`delete:${s.id}`, "core.settings-modal.delete", "삭제", "core.settings.sets.delete", { id: s.id, scope }),
    );
    const el = document.createElement("div");
    el.className = "set-row";
    el.append(line, acts);
    return el;
  });
  rows.push(row("", button("sets:create", "core.settings-modal.create", "새 세트", "core.settings.sets.create", { scope })));
  if (scope === "project" && overridden("sets")) rows.push(row("", press("reset:sets", "전역 세트 사용")));
  body.append(group("세트", "사이드바에 보여 줄 섹션 묶음. 어느 사이드바에 보일지는 일반과 플러그인 페이지에서 고른다.", rows));
  const edited = sets.find((s) => s.id === editing);
  if (edited) body.append(setEditor(edited));
}

const SECTIONS = [
  ["general", "일반", drawGeneral],
  ["plugins", "플러그인", drawPlugins],
  ["sidebars", "사이드바", drawSidebars],
];

/** The name of this modal. It is the visible title and also the name that the host gives to the window. */
const NAME = "설정";

/** Creates the card element. Call it when the modal opens. */
function makeCard() {
  const el = document.createElement("div");
  el.className = "set-card";
  el.id = "settings";
  el.dataset.nativeModal = "dialog";
  el.dataset.expose = "core.settings-modal.card";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  el.setAttribute("aria-label", NAME);
  el.innerHTML =
    '<header class="set-card__head" data-grip data-expose="core.settings-modal.grip">' +
      `<span class="set-card__title">${NAME}</span>` +
      `<button class="act" type="button" data-key="close" data-expose="core.settings-modal.close" data-command="core.settings.close" title="닫는다">${icon("close")}</button>` +
    '</header>' +
    '<div class="set-card__body">' +
      '<nav class="set-card__nav"></nav>' +
      '<div class="set-card__pane"></div>' +
    '</div>';
  // Without a host, the card of this document receives the input. It runs the command that the control points to.
  delegate(el);
  // With a host, this element is not rendered. A grip drag happens in the view that holds the copy,
  // and its result is passed to answer().
  onGripDrag(el, (dx, dy) => run("core.settings-modal.move", { dx, dy }));
  showValue(el);
  return el;
}

/* The function to call when the modal is drawn or closed. The public entry registers it. */
let drawn = () => {};

/* The scroll position (points) of the visible content that the native modal reported. When this document draws, it is read from the pane. */
let paneScroll = 0;

/** The key of the visible content. The content is the same when the section, the scope, the plugin page and the edited set are the same (docs/spec/settings.md). */
const scrollKey = () => JSON.stringify([here, scope, here === "plugins" ? chosen : null, here === "sidebars" ? editing : null]);

/** Registers the function to call when the modal is drawn or closed. */
export function onSettingsDrawn(fn) {
  drawn = fn;
}

/**
 * The public controls of the open modal. Each name gets a number in document order. A native modal draws a copy of this
 * element, so the order is the same in both documents.
 */
export function settingsModalState() {
  if (!card) return { open: false, controls: [] };
  const counts = new Map();
  const controls = [...card.querySelectorAll("[data-expose]")].map((el) => {
    const name = el.dataset.expose;
    // default: the index of a control whose name appears for the first time is 0.
    const index = counts.get(name) ?? 0;
    counts.set(name, index + 1);
    // default: a control without data-on has the checked state if it is a checkbox, and otherwise no on state (null).
    const on = el.dataset.on ?? (el.type === "checkbox" ? String(el.checked) : null);
    return {
      name, index,
      // default: a control that points to neither a key nor a setting has a null key.
      key: el.dataset.key ?? el.dataset.set ?? null,
      label: el.tagName === "SELECT" ? "" : el.textContent.trim(),
      on: on === null ? null : on === "true",
      value: "value" in el && el.tagName !== "BUTTON" ? String(el.value) : null,
      command: commandOf(el),
      // A select box reports its selectable values in document order.
      options: el.tagName === "SELECT" ? [...el.querySelectorAll("option")].map((o) => o.value) : null,
      // The select box of a section row is grouped by plugin with optgroup. It reports the name and the values of each group.
      groups: el.tagName === "SELECT" && el.querySelector("optgroup")
        ? [...el.querySelectorAll("optgroup")].map((g) => ({ label: g.label, values: [...g.querySelectorAll("option")].map((o) => o.value) }))
        : null,
    };
  });
  // The row name and the description of a declared setting. The plugin page draws them from the label and the description of the manifest.
  const rows = [...card.querySelectorAll(".set-row[data-row]")].map((el) => ({
    key: el.dataset.row,
    name: el.querySelector(".set-row__name").textContent,
    // default: a setting row without a description has a null description.
    description: card.querySelector(`[data-describes="${CSS.escape(el.dataset.row)}"]`)?.textContent ?? null,
  }));
  const r = card.getBoundingClientRect();
  const listed = [...card.querySelectorAll("[data-listed]")].map((el) => el.dataset.listed);
  return { open: true, rows, query, listed, section: here, scope, plugin: here === "plugins" ? chosen : null, editing,
    scroll: native ? paneScroll : body.scrollTop,
    card: { x: r.left, y: r.top, w: r.width, h: r.height }, controls };
}

/** Changes the section of the modal. */
export function showSection(id) {
  if (!card) throw new Error("settings are not open");
  if (!SECTIONS.some(([known]) => known === id)) throw new Error(`unknown settings section ${id}`);
  here = id;
  drawSettings();
}

/** Opens the page of one loaded plugin in the plugin section. When it is null, returns to the list. */
export function showPlugin(id) {
  if (!card) throw new Error("settings are not open");
  if (id !== null && !pluginUnits().some((unit) => unit.id === id)) throw new Error(`unknown plugin ${id}`);
  chosen = id;
  drawSettings();
}

/** Changes the search term of the plugin list. */
export function searchPlugins(text) {
  if (!card) throw new Error("settings are not open");
  if (typeof text !== "string") throw new Error("query must be a string");
  query = text;
  drawSettings();
}

/** Opens the editing of one set in the sidebar section. When it is null, closes the editing. */
export function editSet(id) {
  if (!card) throw new Error("settings are not open");
  if (id !== null && !value("sets").some((s) => s.id === id)) throw new Error(`unknown set ${id}`);
  editing = id;
  drawSettings();
}

/** Changes the scope of the modal. The project scope exists only while a project is selected. */
export function showScope(next) {
  if (!card) throw new Error("settings are not open");
  if (next !== "common" && !(next === "project" && settingProject())) throw new Error(`scope ${next} is not available`);
  scope = next;
  drawSettings();
}

/** Moves the modal card. */
export function moveSettings(dx, dy) {
  if (!card) throw new Error("settings are not open");
  moveBy(dx, dy);
  queueMicrotask(() => drawn());
}

/** Draws the card again and, when it is open, also updates the content of the host view. */
export function drawSettings() {
  if (!card) return;
  queueMicrotask(() => drawn());
  if (!settingProject()) scope = "common";
  nav.textContent = "";
  for (const [id, name] of SECTIONS) {
    const b = document.createElement("button");
    b.className = "set-nav";
    b.type = "button";
    b.dataset.key = `nav:${id}`;
    b.dataset.expose = "core.settings-modal.nav";
    mark(b, "core.settings-modal.nav", { section: id });
    b.dataset.on = String(id === here);
    b.textContent = name;
    nav.appendChild(b);
  }
  // When the same content is drawn again, its scroll position is kept. Other content has a different data-scroll-key and starts at the top.
  const positions = scrollPositions(card);
  body.textContent = "";
  body.dataset.scrollKey = scrollKey();
  // The scope tabs are above the controls of every section.
  const tabs = scopeTabs([["common", "전역"], ...(settingProject() ? [["project", "프로젝트"]] : [])], scope);
  tabs.className = "set-scope-tabs";
  tabs.setAttribute("role", "group");
  tabs.setAttribute("aria-label", "설정 범위");
  for (const tab of tabs.children) tab.setAttribute("aria-pressed", tab.dataset.on);
  body.append(tabs);
  if (scope === "project") {
    const folder = document.createElement("p");
    folder.className = "set-caption";
    const project = active();
    if (!project) throw new Error("the project settings scope has no active project");
    folder.textContent = project.root;
    body.append(folder);
  }
  SECTIONS.find(([id]) => id === here)[2]();
  overlay.update(card);
  // When the content changes, the size of the card changes too. If the position is not notified again, the view
  // keeps the previous size and the card inside it grows or is cut off.
  const rect = cardRect();
  if (native) overlay.place(card, rect);
  else standIn(true, rect);
  restoreScroll(card, positions);
}

/**
 * Handles one response of the card. key is the target and value is the value.
 *
 * A listener is not registered per control. A native view renders a copy of this element, so a
 * listener registered there does not work. The control that responded is found in the card of this document and the
 * command of that control is run. A press has an empty value, and a value input adds that value.
 */
function answer(key, val) {
  if (!card || key === "") return;
  // The distance by which the header of the copy was dragged. It runs the move command that the header points to.
  if (key === "move") {
    const [dx, dy] = val.split(",").map(Number);
    return run("core.settings-modal.move", { dx, dy });
  }
  // The native modal reports the scroll position of the visible content. The position is used only as state and is not a command.
  if (key === "scroll") {
    const top = Number(val);
    if (!Number.isFinite(top) || top < 0) throw new Error(`settings scroll position is invalid: ${val}`);
    paneScroll = top;
    drawn();
    return;
  }
  const pressed = card.querySelector(`[data-key="${CSS.escape(key)}"]`);
  const field = pressed ? null : card.querySelector(`[data-set="${CSS.escape(key)}"]`);
  const found = pressed ? commandOf(pressed) : field ? commandOf(field, val) : null;
  if (!found) throw new Error(`settings control ${key} is not in the card`);
  return run(found.name, found.params);
}

/** Measures the position and size of the card relative to the plane and returns them. The host places the view with these coordinates. */
function cardRect() {
  const plane = document.getElementById("plane").getBoundingClientRect();
  const r = card.getBoundingClientRect();
  return { x: r.left - plane.left, y: r.top - plane.top, w: r.width, h: r.height };
}

/**
 * Moves the card by the distance the grip was dragged. 8px is left inside the window.
 *
 * The current position is read from the element. If it were kept in a separate variable, the two values would diverge.
 */
function moveBy(dx, dy) {
  const r = card.getBoundingClientRect();
  card.style.left = `${Math.max(8, Math.min(innerWidth - r.width - 8, r.left + dx))}px`;
  card.style.top = `${Math.max(8, Math.min(innerHeight - r.height - 8, r.top + dy))}px`;
  card.style.transform = "none";
  const rect = cardRect();
  if (native) overlay.place(card, rect);
  else standIn(true, rect);
}

/** Opens the modal. With a host a native view renders it, and without a host this document renders it. */
export function openSettings() {
  if (card) return;
  // While the modal is open, the overlay blocks the pointer input of the plane. Without it, dragging a divider
  // beside the card would work. Even when the host renders the card, the overlay stays in this document.
  scrim = document.createElement("div");
  scrim.className = "set-scrim";
  scrim.dataset.expose = "core.settings-modal.scrim";
  card = makeCard();
  scrim.appendChild(card);
  document.body.appendChild(scrim);
  nav = card.querySelector(".set-card__nav");
  body = card.querySelector(".set-card__pane");
  drawSettings();

  const rect = cardRect();
  if (native) {
    // The application renders it, so it is not shown here. The position and size must be read from this element,
    // so it is hidden with visibility, not display.
    card.style.visibility = "hidden";
    overlay.show(card, rect, answer);
  } else {
    standIn(true, rect);
  }
}

/** Closes the modal and removes the overlay and the card. */
export function closeSettings() {
  if (!card) return;
  queueMicrotask(() => drawn());
  if (native) overlay.hide(card);
  else standIn(false);
  scrim.remove();
  scrim = null;
  card = null;
  nav = null;
  body = null;
}

// A settings card dragged to an edge must stay inside the parent window whose size changed.
// Its native webview follows the same clamped DOM rectangle.
addEventListener("resize", () => { if (card) moveBy(0, 0); });
