// 설정 모달.
//
// 560px 카드. 헤더에 제목과 닫기 버튼, 왼쪽에 절 목록, 오른쪽에 「이름 124px +
// 컨트롤」 행이 들어간다. 행은 묶음으로 나뉘고 묶음마다 이름과 설명 한 줄을 갖는다.
//
// 컨트롤은 브라우저 기본 모양을 쓰지 않는다. 값이 둘이나 셋이면 목록이 아니라 한 줄에
// 늘어놓고(seg), 켜고 끄는 값은 스위치다. 기본 select 와 checkbox 는 테마의 색을
// 따르지 않는다.
//
// [data-native-modal] 요소다. DOM 은 네이티브 표면 위에 그릴 수 없으므로 호스트가
// 이 요소를 별도 뷰에 렌더링한다. 그 뷰는 사본이므로 여기서 등록한 리스너가 동작하지
// 않는다. 모든 컨트롤에 data-key 또는 data-set 을 붙이고 응답을 answer() 하나로
// 받는다. 각 컨트롤은 data-command 로 실행할 코어 명령을 가리키고, answer() 는 그
// 명령을 실행한다.
import { standIn } from "./compositor.js";
import { native, overlay } from "./host.js";
import { active } from "./projects.js";
import { icon } from "./icons.js";
import { onGripDrag, showValue } from "./card.js";
import { commandOf, delegate, mark, run } from "./commands.js";
import { pluginUnits } from "./environment.js";
import { matchPlugins } from "./plugin-search.js";
import { section, sectionNames } from "./registry.js";
import {
  FONTS, LAYOUT_RANGES, MENU_LANGUAGES, MODES, THEMES, scopedValue, settingProject, overridden,
  settingDefinitions,
} from "./settings.js";

/* 열려 있는 동안에만 존재한다. 숨겨 두면 표시 여부를 CSS 가 결정하게 되고,
   [hidden] 은 display 를 정하는 규칙을 이기지 못한다. */
let scrim = null;
let card = null;
let nav = null;
let body = null;

/** 현재 절. 닫아도 유지하고 다시 열 때 같은 절을 표시한다. */
let here = "general";
let scope = "common";
/** 플러그인 절에서 페이지를 연 플러그인 id. null 이면 목록을 보인다. */
let chosen = null;
/** 플러그인 목록의 검색어. */
let query = "";
/** 사이드바 절에서 편집 중인 세트 id. 없으면 null. */
let editing = null;
const value = (key) => scopedValue(key, scope);
const themeName = () => value("theme");
const modeName = () => value("mode");
const gapSetting = () => value("gap");

/** 「이름 + 컨트롤」 한 행을 만든다. */
function row(label, control) {
  const el = document.createElement("label");
  el.className = "set-row";
  const name = document.createElement("span");
  name.className = "set-row__name";
  name.textContent = label;
  el.append(name, control);
  const field = control.matches("[data-set]") ? control : control.querySelector("[data-set], [data-key]");
  // 기본값: 설정 컨트롤이 없는 행은 키가 없고, data-set 이 없는 선택지는 data-key(pick:키:값)의 둘째 부분이 설정 키다.
  const key = field?.dataset.set ?? field?.dataset.key?.split(":")[1];
  if (scope === "project" && key && overridden(key)) {
    const resetButton = press(`reset:${key}`, "전역값 사용");
    resetButton.classList.add("set-reset");
    el.append(resetButton);
  }
  return el;
}

/**
 * 행 묶음 하나를 만든다. 이름, 설명 한 줄, 그리고 행들.
 *
 * 행을 나란히 두기만 하면 무엇이 배치를 바꾸고 무엇이 표시만 바꾸는지 보이지 않는다.
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

/* 현재 값을 프로퍼티가 아니라 속성으로 설정한다.
   호스트에 전송하는 것은 innerHTML 이고 직렬화되는 것은 속성뿐이다.
   checked/selected/value 를 프로퍼티로만 설정하면 사본이 초기값으로 렌더링된다. */

/**
 * 값을 입력하는 컨트롤의 명령. 설정 이름이면 core.settings.change, 사이드바 연결
 * (link:<자리>:<플러그인>)이면 core.settings.link 다.
 */
function valueCommand(el, key) {
  const [kind, place, plugin] = key.split(":");
  // 기본값: link:left: 처럼 플러그인 부분이 빈 키는 일반 선택이므로 plugin 은 null 이다(docs/spec/settings.md).
  if (kind === "link") mark(el, "core.settings.link", { place, plugin: plugin || null, scope }, "set");
  else mark(el, "core.settings.change", { key, scope });
}

/** select 를 만든다. 선택한 값이 key 와 함께 반환된다. */
function choose(key, options, now) {
  if (!options.some(([value]) => value === now)) throw new Error(`unknown settings choice ${String(now)} for ${key}`);
  const wrap = document.createElement("span");
  wrap.className = "select-field";
  const el = document.createElement("select");
  el.dataset.set = key;
  el.dataset.expose = "core.settings-modal.set";
  valueCommand(el, key);
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

/**
 * 값을 한 줄에 늘어놓는다. 값이 둘이나 셋일 때 사용한다.
 *
 * 버튼이므로 select 와 달리 change 가 아니라 click 으로 도착한다. key 에 값을 함께
 * 실어 보낸다.
 */
function segment(key, options, now) {
  const el = document.createElement("span");
  el.className = "set-seg";
  for (const [v, label] of options) {
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.key = `pick:${key}:${v}`;
    b.dataset.expose = key === "scope" ? "core.settings-modal.scope" : "core.settings-modal.pick";
    if (key === "scope") mark(b, "core.settings-modal.scope", { scope: v });
    else mark(b, "core.settings.change", { key, value: v, scope });
    b.dataset.on = String(v === now);
    b.textContent = label;
    el.appendChild(b);
  }
  return el;
}

/** 켜고 끄는 값. */
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

/** range 입력과 값 표시를 만든다. */
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

/** 한 줄 문자열 입력. 값은 change 로 도착한다. */
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

/** 버튼을 만든다. */
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
 * 테마 견본 하나를 만든다.
 *
 * 바탕, 카드, 테두리, 레일, 포커스 다섯 값을 한 상자에 그린다. 두 칸만 칠하면 테마
 * 사이의 차이가 보이지 않는다. 모서리도 그 테마의 값으로 그린다.
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
  // 견본은 42px 이므로 실제 값을 그대로 쓰면 통로가 상자를 채운다. 절반으로 줄이되
  // 통로가 0 인 테마는 1px 을 남기고 그 자리를 경계선 색으로 칠한다. 그 1px 이 두
  // 카드가 공유하는 선이다.
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
    row("열기 방식", segment("projectOpening", [["tabs", "현재 창"], ["windows", "별도 창"]], value("projectOpening"))),
  ]));
  if (scope === "project" && overridden("theme")) grid.append(press("reset:theme", "전역 테마 사용"));
  body.append(group("테마", "테마가 색과 형태의 기본값을 정하고, 모드는 그 테마의 밝은 쪽과 어두운 쪽을 고른다.", [
    grid,
    row("모드", segment("mode", MODES.map((m) => [m, m === "dark" ? "어두움" : "밝음"]), modeName())),
  ]));

  body.append(group("형태", "테마가 준 값에서 시작한다. 통로를 0 으로 내리면 카드가 선 하나를 공유한다.", [
    row("통로", slide("gap", 0, 24, gapSetting(), "px")),
    row("모서리", slide("radius", 0, 24, value("radius"), "px")),
    row("폰트", choose("font", FONTS.map((f) => [f.id, f.name]), value("font"))),
    row("글자 크기", slide("size", 10, 18, value("size"), "px")),
  ]));

  body.append(group("위치", "프로젝트 탭이 놓이는 위치. 바꾸면 카드 배치도 함께 바뀐다.", [
    row("프로젝트 탭 위치", segment("projectTabs", [["top", "위"], ["left", "왼쪽"]], value("projectTabs"))),
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
    row("포커스 표시", segment("focusInd", [["border", "테두리"], ["corner", "꺽쇠"]], value("focusInd"))),
    row("경계선", segment("fullRule", [["under", "가림"], ["over", "보임"], ["none", "숨김"]], value("fullRule"))),
    row("포커스 밖 흐리게", toggle("dim", value("dim"))),
  ]));

  body.append(group("언어", "애플리케이션 메뉴가 이 언어를 따른다. 자동은 시스템 언어이고 목록에 없으면 영어다.", [
    row("언어", segment("language",
      [["auto", "자동"], ...MENU_LANGUAGES.map(({ id, label }) => [id, label])], value("language"))),
  ]));
}

/** 버튼 하나를 만든다. key 로 응답을 찾고 name 으로 공개하며 명령을 가리킨다. */
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

/** 세트 선택 상자의 세트 항목. 값은 세트 id 다. */
// 기본값: 섹션이 없는 세트는 섹션 없음으로 보인다.
const setItems = () => value("sets").map((s) => [s.id, `${s.title} — ${sectionNames(s.sections).join(" · ") || "섹션 없음"}`]);
/** 일반 선택의 항목: 사용 안 함과 모든 세트. */
const generalOptions = () => [["off", "사용 안 함"], ...setItems()];
/** 선택 상자에 보일 현재 선택. 세트 id 또는 off 다. */
function choiceOf(place, plugin) {
  const found = value("links").find((l) => l.place === place && l.plugin === plugin);
  if (!found) return "off";
  return found.set;
}

/** 설정 한 행. 선언된 형식에 따라 선택, 슬라이더, 글자 입력이다. */
function declaredRow(key, definition) {
  const now = value(key);
  const control = definition.type === "enum"
    ? segment(key, definition.values.map((item) => [item, item]), now)
    : definition.type === "string"
      ? text(key, definition.maxLength, now)
      : definition.type === "address"
        ? text(key, 2048, now)
      : slide(key, definition.minimum, definition.maximum, now, "");
  const el = row(definition.label, control);
  el.dataset.row = key;
  if (!definition.description) return [el];
  // 설명은 행 바로 아래 한 줄이다. core.settings-modal 의 rows 가 행과 함께 보고한다.
  const note = document.createElement("p");
  note.className = "set-caption";
  note.dataset.describes = key;
  note.textContent = definition.description;
  return [el, note];
}

/** 세트 한 줄의 설명. 제목, 배치, 섹션 이름. */
// 기본값: 섹션이 없는 세트는 섹션 없음으로 보인다.
const setLine = (s) => `${s.title} · ${s.layout === "tabs" ? "탭" : "목록"} · ${sectionNames(s.sections).join(", ") || "섹션 없음"}`;

/** 플러그인 목록. 검색 칸과 검색어에 맞는 행이다. */
function drawPluginList() {
  const search = document.createElement("input");
  search.type = "search";
  search.className = "set-text";
  search.placeholder = "이름, id, 설명으로 찾기";
  search.dataset.set = "plugin-search";
  search.dataset.expose = "core.settings-modal.search";
  mark(search, "core.settings-modal.search", {}, "query");
  search.setAttribute("value", query);
  const rows = matchPlugins(pluginUnits(), query).map((u) =>
    button(`plugin:${u.id}`, "core.settings-modal.plugin", `${u.name} — ${u.description}`, "core.settings-modal.plugin", { plugin: u.id }));
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
  body.append(group("플러그인", "환경에 들어 있는 플러그인. 행을 누르면 그 플러그인의 설정, 섹션, 사이드바가 보인다.", [row("찾기", search), list]));
}

/** 플러그인 한 개의 페이지. 목록으로 돌아가는 버튼, 설정, 섹션, 사이드바 선택이다. */
function drawPluginPage(unit) {
  const back = button("plugins:list", "core.settings-modal.back", "목록", "core.settings-modal.plugin", { plugin: null });
  const about = document.createElement("p");
  about.className = "set-caption";
  about.textContent = unit.description;
  body.append(group(unit.name, unit.id, [row("", back), about]));

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

/** 섹션 행 하나의 선택 상자. 등록된 모든 섹션을 플러그인마다 optgroup 으로 묶는다. */
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
  wrap.append(el);
  return wrap;
}

/** 세트 편집. 이름, 배치, 섹션 행(선택 상자와 ▲ ▼ −), 그리고 + 하나. */
function setEditor(s) {
  const title = document.createElement("input");
  title.type = "text";
  title.className = "set-text";
  title.dataset.set = `title:${s.id}`;
  title.dataset.expose = "core.settings-modal.set";
  mark(title, "core.settings.sets.update", { id: s.id, scope }, "title");
  title.maxLength = 40;
  title.setAttribute("value", s.title);
  const layout = document.createElement("span");
  layout.className = "set-seg";
  for (const [v, label] of [["list", "목록"], ["tabs", "탭"]]) {
    layout.append(button(`layout:${s.id}:${v}`, "core.settings-modal.pick", label, "core.settings.sets.update",
      { id: s.id, layout: v, scope }, s.layout === v));
  }
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

/** 이 모달의 이름. 보이는 제목이자 호스트가 창에 붙이는 이름이다. */
const NAME = "설정";

/** 카드 요소를 만든다. 모달을 열 때 호출한다. */
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
  // 호스트가 없으면 이 문서의 카드가 입력을 받는다. 컨트롤이 가리키는 명령을 실행한다.
  delegate(el);
  // 호스트가 있으면 이 요소는 렌더링되지 않는다. 그립 드래그는 사본이 있는 뷰에서
  // 발생하고 그 결과가 answer() 로 전달된다.
  onGripDrag(el, (dx, dy) => run("core.settings-modal.move", { dx, dy }));
  showValue(el);
  return el;
}

/* 모달을 그리거나 닫을 때 호출할 함수. 공개 항목이 등록한다. */
let drawn = () => {};

/** 모달을 그리거나 닫을 때 호출할 함수를 등록한다. */
export function onSettingsDrawn(fn) {
  drawn = fn;
}

/**
 * 열린 모달의 공개 컨트롤. 이름마다 문서 순서의 번호를 붙인다. 네이티브 모달은 이
 * 요소의 사본을 그리므로 두 문서의 순서가 같다.
 */
export function settingsModalState() {
  if (!card) return { open: false, controls: [] };
  const counts = new Map();
  const controls = [...card.querySelectorAll("[data-expose]")].map((el) => {
    const name = el.dataset.expose;
    // 기본값: 이름이 처음 나온 컨트롤의 순번은 0 이다.
    const index = counts.get(name) ?? 0;
    counts.set(name, index + 1);
    // 기본값: data-on 이 없는 컨트롤은 체크 상자이면 체크 상태, 아니면 켬 상태가 없다(null).
    const on = el.dataset.on ?? (el.type === "checkbox" ? String(el.checked) : null);
    return {
      name, index,
      // 기본값: 키도 설정도 가리키지 않는 컨트롤은 key 가 null 이다.
      key: el.dataset.key ?? el.dataset.set ?? null,
      label: el.tagName === "SELECT" ? "" : el.textContent.trim(),
      on: on === null ? null : on === "true",
      value: "value" in el && el.tagName !== "BUTTON" ? String(el.value) : null,
      command: commandOf(el),
      // 섹션 행의 선택 상자는 플러그인마다 optgroup 으로 묶는다. 묶음의 이름과 값을 보고한다.
      groups: el.tagName === "SELECT" && el.querySelector("optgroup")
        ? [...el.querySelectorAll("optgroup")].map((g) => ({ label: g.label, values: [...g.querySelectorAll("option")].map((o) => o.value) }))
        : null,
    };
  });
  // 선언된 설정의 행 이름과 설명. 플러그인 페이지가 manifest 의 label 과 description 으로 그린다.
  const rows = [...card.querySelectorAll(".set-row[data-row]")].map((el) => ({
    key: el.dataset.row,
    name: el.querySelector(".set-row__name").textContent,
    // 기본값: description 이 없는 설정 행은 설명이 null 이다.
    description: card.querySelector(`[data-describes="${CSS.escape(el.dataset.row)}"]`)?.textContent ?? null,
  }));
  const r = card.getBoundingClientRect();
  const listed = [...card.querySelectorAll("[data-listed]")].map((el) => el.dataset.listed);
  return { open: true, rows, query, listed, section: here, scope, plugin: here === "plugins" ? chosen : null, editing,
    card: { x: r.left, y: r.top, w: r.width, h: r.height }, controls };
}

/** 모달의 절을 바꾼다. */
export function showSection(id) {
  if (!card) throw new Error("settings are not open");
  if (!SECTIONS.some(([known]) => known === id)) throw new Error(`unknown settings section ${id}`);
  here = id;
  drawSettings();
}

/** 플러그인 절에서 플러그인 하나의 페이지를 연다. null 이면 목록으로 돌아간다. */
export function showPlugin(id) {
  if (!card) throw new Error("settings are not open");
  if (id !== null && !pluginUnits().some((u) => u.id === id)) throw new Error(`unknown plugin ${id}`);
  chosen = id;
  drawSettings();
}

/** 플러그인 목록의 검색어를 바꾼다. */
export function searchPlugins(text) {
  if (!card) throw new Error("settings are not open");
  if (typeof text !== "string") throw new Error("query must be a string");
  query = text;
  drawSettings();
}

/** 사이드바 절에서 세트 하나의 편집을 연다. null 이면 편집을 닫는다. */
export function editSet(id) {
  if (!card) throw new Error("settings are not open");
  if (id !== null && !value("sets").some((s) => s.id === id)) throw new Error(`unknown set ${id}`);
  editing = id;
  drawSettings();
}

/** 모달의 범위를 바꾼다. 프로젝트 범위는 프로젝트가 선택된 동안만 있다. */
export function showScope(next) {
  if (!card) throw new Error("settings are not open");
  if (next !== "common" && !(next === "project" && settingProject())) throw new Error(`scope ${next} is not available`);
  scope = next;
  drawSettings();
}

/** 모달 카드를 옮긴다. */
export function moveSettings(dx, dy) {
  if (!card) throw new Error("settings are not open");
  moveBy(dx, dy);
  queueMicrotask(() => drawn());
}

/** 카드를 다시 그리고, 열려 있으면 호스트 뷰의 내용도 갱신한다. */
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
  body.textContent = "";
  // 범위 탭은 모든 절의 컨트롤 위에 있다.
  const tabs = segment("scope", [["common", "전역"], ...(settingProject() ? [["project", "프로젝트"]] : [])], scope);
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
  // 내용이 바뀌면 카드의 크기도 바뀐다. 자리를 다시 알리지 않으면 뷰는 이전 크기를
  // 유지하고 그 안의 카드가 늘어나거나 잘린다.
  const rect = cardRect();
  if (native) overlay.place(card, rect);
  else standIn(true, rect);
}

/**
 * 카드의 응답 하나를 처리한다. key 가 대상, value 가 값이다.
 *
 * 컨트롤마다 리스너를 등록하지 않는다. 네이티브 뷰는 이 요소의 사본을 렌더링하므로
 * 거기 등록한 리스너가 동작하지 않는다. 응답한 컨트롤을 이 문서의 카드에서 찾아 그
 * 컨트롤의 명령을 실행한다. 누름은 value 가 비어 있고, 값 입력은 그 값을 더한다.
 */
function answer(key, val) {
  if (!card || key === "") return;
  // 사본의 머리를 끈 거리. 머리가 가리키는 이동 명령을 실행한다.
  if (key === "move") {
    const [dx, dy] = val.split(",").map(Number);
    return run("core.settings-modal.move", { dx, dy });
  }
  const pressed = card.querySelector(`[data-key="${CSS.escape(key)}"]`);
  const field = pressed ? null : card.querySelector(`[data-set="${CSS.escape(key)}"]`);
  const found = pressed ? commandOf(pressed) : field ? commandOf(field, val) : null;
  if (!found) throw new Error(`settings control ${key} is not in the card`);
  return run(found.name, found.params);
}

/** 카드의 위치와 크기를 판 기준으로 측정해 반환한다. 호스트가 이 좌표로 뷰를 배치한다. */
function cardRect() {
  const plane = document.getElementById("plane").getBoundingClientRect();
  const r = card.getBoundingClientRect();
  return { x: r.left - plane.left, y: r.top - plane.top, w: r.width, h: r.height };
}

/**
 * 그립을 드래그한 거리만큼 카드를 이동한다. 창 안에 8px 을 남긴다.
 *
 * 현재 위치는 요소에서 읽는다. 별도 변수로 보관하면 두 값이 어긋난다.
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

/** 모달을 연다. 호스트가 있으면 네이티브 뷰가, 없으면 이 문서가 렌더링한다. */
export function openSettings() {
  if (card) return;
  // 오버레이가 모달이 열린 동안 판의 포인터 입력을 차단한다. 없으면 카드 옆 divider
  // 드래그가 동작한다. 호스트가 카드를 렌더링해도 오버레이는 이 문서에 남는다.
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
    // 애플리케이션이 렌더링하므로 여기서는 표시하지 않는다. 위치와 크기는 이 요소에서
    // 읽어야 하므로 display 가 아니라 visibility 로 숨긴다.
    card.style.visibility = "hidden";
    overlay.show(card, rect, answer);
  } else {
    standIn(true, rect);
  }
}

/** 모달을 닫고 오버레이와 카드를 제거한다. */
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

// 가장자리로 drag된 settings 카드는 크기가 바뀐 부모 창 안에 남아야 한다.
// 그 native webview는 같은 clamp된 DOM 사각형을 따른다.
addEventListener("resize", () => { if (card) moveBy(0, 0); });
