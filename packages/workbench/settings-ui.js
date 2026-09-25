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
import { plugins, sectionNames } from "./registry.js";
import {
  FONTS, MODES, THEMES, scopedValue, settingProject, overridden,
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
  const field = control.matches?.("[data-set]") ? control : control.querySelector("[data-set], [data-key]");
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
  if (kind === "link") mark(el, "core.settings.link", { place, plugin: plugin || null, scope }, "set");
  else mark(el, "core.settings.change", { key, scope });
}

/** select 를 만든다. 선택한 값이 key 와 함께 반환된다. */
function choose(key, options, now) {
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
  el.dataset.expose = key === "press:build" ? "core.settings-modal.build" : "core.settings-modal.reset";
  if (key === "press:build") mark(el, "core.layout.reset");
  else mark(el, "core.settings.reset", { key: key.split(":")[1] });
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

  body.append(group("자리", "판의 크기와 카드의 자리가 함께 움직인다.", [
    row("프로젝트 탭", segment("projectTabs", [["top", "위"], ["left", "왼쪽"]], value("projectTabs"))),
    row("사이드바 위치", segment("rail",
      [["flow", "따라감"], ["pin", "고정"], ["inset", "카드 안"], ["off", "없음"]], value("rail"))),
    row("좌측 사이드바 위치", toggle("left", value("left"))),
    row("우측 사이드바 위치", toggle("right", value("right"))),
  ]));

  body.append(group("표시", "자리는 그대로 두고 보이는 것만 바꾼다.", [
    row("포커스 표시", segment("focusInd", [["border", "테두리"], ["corner", "꺽쇠"]], value("focusInd"))),
    row("경계선", segment("fullRule", [["under", "가림"], ["over", "보임"], ["none", "숨김"]], value("fullRule"))),
    row("포커스 밖 흐리게", toggle("dim", value("dim"))),
  ]));

  const declared = Object.entries(settingDefinitions()).sort(([a], [b]) => a.localeCompare(b));
  if (declared.length) {
    const controls = declared.map(([key, definition]) => {
      const now = value(key);
      const control = definition.type === "enum"
        ? segment(key, definition.values.map((item) => [item, item]), now)
        : definition.type === "string"
          ? text(key, definition.maxLength, now)
          : slide(key, definition.minimum, definition.maximum, now, "");
      return row(key, control);
    });
    body.append(group("플러그인", "플러그인이 선언한 설정은 같은 공통/프로젝트 범위와 저장 규칙을 사용한다.", controls));
  }
}

function drawSidebars() {
  const options = [["", "없음"], ...value("sets").map((s) => [s.id,
    `${s.title} — ${sectionNames(s.sections).join(" · ")}`])];
  const linkedId = (place, plugin) => value("links").find((l) => l.place === place && l.plugin === plugin)?.set;
  const rows = [row("좌측", choose("link:left:", options, linkedId("left", null) ?? ""))];
  for (const p of plugins()) {
    rows.push(row(`${p.name} 레일`, choose(`link:rail:${p.id}`, options, linkedId("rail", p.id) ?? "")));
    rows.push(row(`${p.name} 우측`, choose(`link:right:${p.id}`, options, linkedId("right", p.id) ?? "")));
  }
  if (scope === "project" && overridden("links")) rows.push(row("", press("reset:links", "전역 연결 사용")));
  body.append(group("연결", "자리마다 세트를 건다. 걸지 않으면 그 사이드바는 없다.", rows));
}

function drawCompositing() {
  body.append(group("어긋남", "커밋 지연은 V7a 를, 적용 오차는 V7b 를 뒤집는다. 실제 앱의 어긋남을 여기서 만들어 본다.", [
    row("커밋 지연", slide("latency", 0, 600, value("latency"), "ms")),
    row("적용 오차", slide("skew", 0, 24, value("skew"), "px")),
    row("", press("press:build", "초기 배치로")),
  ]));
}

const SECTIONS = [
  ["general", "일반", drawGeneral],
  ["sidebars", "사이드바", drawSidebars],
  ["compositing", "합성", drawCompositing],
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
    const index = counts.get(name) ?? 0;
    counts.set(name, index + 1);
    const on = el.dataset.on ?? (el.type === "checkbox" ? String(el.checked) : null);
    return {
      name, index,
      key: el.dataset.key ?? el.dataset.set ?? null,
      label: el.tagName === "SELECT" ? "" : el.textContent.trim(),
      on: on === null ? null : on === "true",
      value: "value" in el && el.tagName !== "BUTTON" ? String(el.value) : null,
      command: commandOf(el),
    };
  });
  const r = card.getBoundingClientRect();
  return { open: true, section: here, scope, card: { x: r.left, y: r.top, w: r.width, h: r.height }, controls };
}

/** 모달의 절을 바꾼다. */
export function showSection(id) {
  if (!card) throw new Error("settings are not open");
  if (!SECTIONS.some(([known]) => known === id)) throw new Error(`unknown settings section ${id}`);
  here = id;
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
  if (here === "general") {
    const tabs = segment("scope", [["common", "전역"], ...(settingProject() ? [["project", "프로젝트"]] : [])], scope);
    tabs.className = "set-scope-tabs";
    tabs.setAttribute("role", "group");
    tabs.setAttribute("aria-label", "설정 범위");
    for (const tab of tabs.children) tab.setAttribute("aria-pressed", tab.dataset.on);
    body.append(tabs);
  }
  if (scope === "project") {
    const folder = document.createElement("p");
    folder.className = "set-caption";
    folder.textContent = active()?.root ?? "";
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

// A settings card that was dragged to an edge must remain inside a resized
// parent window. Its native webview follows the same clamped DOM rectangle.
addEventListener("resize", () => { if (card) moveBy(0, 0); });
