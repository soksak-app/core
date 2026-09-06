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
// 받는다.
import { standIn } from "./compositor.js";
import { native, overlay } from "./host.js";
import { icon } from "./icons.js";
import { onAnswer, onGripDrag, showValue } from "./card.js";
import { knobs, setKnob } from "./compositor.js";
import { plugins, section } from "./plugins/registry.js";
import {
  FONTS, MODES, THEMES, applyTheme, gapSetting, link, linkedId, modeName, set, sets,
  themeName, value,
} from "./settings.js";

/* 열려 있는 동안에만 존재한다. 숨겨 두면 표시 여부를 CSS 가 결정하게 되고,
   [hidden] 은 display 를 정하는 규칙을 이기지 못한다. */
let scrim = null;
let card = null;
let nav = null;
let body = null;

/** 현재 절. 닫아도 유지하고 다시 열 때 같은 절을 표시한다. */
let here = "general";

/** 「이름 + 컨트롤」 한 행을 만든다. */
function row(label, control) {
  const el = document.createElement("label");
  el.className = "set-row";
  const name = document.createElement("span");
  name.className = "set-row__name";
  name.textContent = label;
  el.append(name, control);
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

/** select 를 만든다. 선택한 값이 key 와 함께 반환된다. */
function choose(key, options, now) {
  const wrap = document.createElement("span");
  wrap.className = "set-field";
  const el = document.createElement("select");
  el.dataset.set = key;
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
  el.min = String(min);
  el.max = String(max);
  el.setAttribute("value", String(now));
  const out = document.createElement("output");
  out.textContent = `${now}${unit}`;
  wrap.append(el, out);
  return wrap;
}

/** 버튼을 만든다. */
function press(key, label) {
  const el = document.createElement("button");
  el.className = "set-press";
  el.type = "button";
  el.dataset.key = key;
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
    row("레일 거동", segment("rail",
      [["flow", "따라감"], ["pin", "고정"], ["off", "없음"]], value("rail"))),
    row("좌측 자리", toggle("left", value("left"))),
    row("우측 자리", toggle("right", value("right"))),
  ]));

  body.append(group("표시", "자리는 그대로 두고 보이는 것만 바꾼다.", [
    row("포커스 표시", segment("focusInd", [["border", "테두리"], ["corner", "꺽쇠"]], value("focusInd"))),
    row("경계선", segment("fullRule", [["under", "가림"], ["over", "보임"], ["none", "숨김"]], value("fullRule"))),
    row("포커스 밖 흐리게", toggle("dim", value("dim"))),
  ]));
}

function drawSidebars() {
  const options = [["", "없음"], ...sets().map((s) => [s.id,
    `${s.title} — ${s.sections.map((id) => section(id).name).join(" · ")}`])];
  const rows = [row("좌측", choose("link:left:", options, linkedId("left", null) ?? ""))];
  for (const p of plugins()) {
    rows.push(row(`${p.name} 레일`, choose(`link:rail:${p.id}`, options, linkedId("rail", p.id) ?? "")));
    rows.push(row(`${p.name} 우측`, choose(`link:right:${p.id}`, options, linkedId("right", p.id) ?? "")));
  }
  body.append(group("연결", "자리마다 세트를 건다. 걸지 않으면 그 사이드바는 없다.", rows));
}

function drawCompositing() {
  body.append(group("어긋남", "커밋 지연은 V7a 를, 적용 오차는 V7b 를 뒤집는다. 실제 앱의 어긋남을 여기서 만들어 본다.", [
    row("커밋 지연", slide("knob:latency", 0, 600, knobs.latency, "ms")),
    row("적용 오차", slide("knob:skew", 0, 24, knobs.skew, "px")),
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
  el.dataset.nativeModal = "";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-label", NAME);
  el.innerHTML =
    '<header class="set-card__head" data-grip>' +
      `<span class="set-card__title">${NAME}</span>` +
      `<button class="act" type="button" data-key="close" title="닫는다">${icon("close")}</button>` +
    '</header>' +
    '<div class="set-card__body">' +
      '<nav class="set-card__nav"></nav>' +
      '<div class="set-card__pane"></div>' +
    '</div>';
  onAnswer(el, answer);
  // 호스트가 있으면 이 요소는 렌더링되지 않는다. 그립 드래그는 사본이 있는 뷰에서
  // 발생하고 그 결과가 answer() 로 전달된다.
  onGripDrag(el, (dx, dy) => answer("move", `${dx},${dy}`));
  showValue(el);
  return el;
}

/* 값이 아닌 것을 누른 것. 이 모달은 그것을 수행하지 않고 알린다. */
let commanded = () => {};

/** 값이 아닌 누름을 받을 함수를 등록한다. 지금은 「초기 배치로」 하나다. */
export function onCommand(fn) {
  commanded = fn;
}

/** 카드를 다시 그리고, 열려 있으면 호스트 뷰의 내용도 갱신한다. */
export function drawSettings() {
  if (!card) return;
  nav.textContent = "";
  for (const [id, name] of SECTIONS) {
    const b = document.createElement("button");
    b.className = "set-nav";
    b.type = "button";
    b.dataset.key = `nav:${id}`;
    b.dataset.on = String(id === here);
    b.textContent = name;
    nav.appendChild(b);
  }
  body.textContent = "";
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
 * 거기 등록한 리스너가 동작하지 않는다.
 */
function answer(key, val) {
  if (key === "" || key === "close") return closeSettings();
  if (key === "move") return moveBy(...val.split(",").map(Number));
  const [kind, a, b] = key.split(":");
  if (kind === "nav") { here = a; return drawSettings(); }
  // seg 의 버튼은 값을 key 에 담아 전달한다. 아래의 설정 이름 처리로 넘긴다.
  if (kind === "pick") return answer(a, b);
  if (kind === "theme") return applyTheme(a, modeName());
  if (kind === "press") return commanded(a);
  if (kind === "link") return link(a, b || null, val || null);
  // 손잡이는 다음 렌더에 반영된다. 알리지 않으면 바꾼 값이 화면에도, 검증 결과에도
  // 나타나지 않는다.
  if (kind === "knob") return setKnob(a, Number(val));
  // 나머지 key 는 설정 이름이다. 컨트롤이 문자열을 주므로 현재 값의 타입으로
  // 변환 방식을 결정한다.
  const now = value(key);
  set({ [key]: typeof now === "boolean" ? val === "true"
    : typeof now === "number" ? Number(val) : val });
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

/**
 * 카드 밖을 클릭하면 닫는다.
 *
 * 오버레이 클릭과 네이티브 표면 클릭이 같은 pointerdown 으로 도착한다. 표면 클릭은
 * 호스트가 보고하고 판이 해당 슬롯에서 pointerdown 을 발생시킨다(plane.js 의
 * pressSurface). 클릭 위치를 조건으로 따지지 않고 카드 내부인지만 확인한다.
 */
function pressedOutside(e) {
  if (!e.target.closest(".set-card")) closeSettings();
}

/** 모달을 연다. 호스트가 있으면 네이티브 뷰가, 없으면 이 문서가 렌더링한다. */
export function openSettings() {
  if (card) return;
  // 오버레이가 모달이 열린 동안 판의 포인터 입력을 차단한다. 없으면 카드 옆 divider
  // 드래그가 동작한다. 호스트가 카드를 렌더링해도 오버레이는 이 문서에 남는다.
  scrim = document.createElement("div");
  scrim.className = "set-scrim";
  card = makeCard();
  scrim.appendChild(card);
  document.body.appendChild(scrim);
  document.addEventListener("pointerdown", pressedOutside);
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
function closeSettings() {
  if (!card) return;
  document.removeEventListener("pointerdown", pressedOutside);
  if (native) overlay.hide(card);
  else standIn(false);
  scrim.remove();
  scrim = null;
  card = null;
  nav = null;
  body = null;
}

addEventListener("keydown", (e) => { if (e.key === "Escape") closeSettings(); });
