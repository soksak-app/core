// 설정 모달.
//
// 구 프로젝트의 모양 그대로다: 520px 카드, 머리에 잡이와 ✕, 왼쪽에 절 목록,
// 오른쪽에 「이름 130px + 조작」 줄, 절마다 설명 한 줄.
//
// [data-native-modal] 이다. 네이티브 표면은 OS 뷰라서 DOM 이 그 위에 그릴 수
// 없으므로, 호스트가 이 요소를 자기 뷰에 옮겨 표면들 위에 그린다. 그 뷰는 이
// 요소의 사본이므로 여기서 건 리스너는 그쪽에서 돌지 않는다 — 그래서 조작은
// 전부 data-key 를 달고, 답은 하나의 함수로 온다.
import { standIn } from "./compositor.js";
import { icon } from "./icons.js";
import { onGripDrag } from "./grip.js";
import { build } from "./plane.js";
import { knobs } from "./compositor.js";
import { plugins, section } from "./plugins/registry.js";
import {
  MODES, THEMES, applyTheme, halfGap, link, linkedId, modeName, set, sets, themeName, value,
} from "./settings.js";

/* 열려 있는 동안에만 있는 것들. 닫으면 사라진다 — 숨겨 두면 그 요소가 언제
   보이는지가 CSS 의 사정이 되고, 실제로 그렇게 새어 나왔다. */
let scrim = null;
let card = null;
let nav = null;
let body = null;

/** 지금 열려 있는 절. 닫아도 기억해 두었다가 다시 열 때 그 절로 연다. */
let here = "general";

/** 「이름 + 조작」 한 줄. */
function row(label, control) {
  const el = document.createElement("label");
  el.className = "set-row";
  const name = document.createElement("span");
  name.className = "set-row__name";
  name.textContent = label;
  el.append(name, control);
  return el;
}

/** 절의 설명 한 줄. */
function caption(text) {
  const el = document.createElement("p");
  el.className = "set-caption";
  el.textContent = text;
  return el;
}

/* 지금 값은 프로퍼티가 아니라 속성에 적는다.
   호스트가 이 카드를 네이티브 뷰로 넘길 때 보내는 것은 innerHTML 이고, 직렬화
   되는 것은 속성뿐이다. checked/selected/value 를 프로퍼티로만 적으면 사본은
   전부 초기값으로 그려지고, 값을 바꿔도 다시 그릴 때마다 되돌아간다. */

/** 고르는 것. 고른 값이 key 와 함께 돌아온다. */
function choose(key, options, now) {
  const el = document.createElement("select");
  el.dataset.set = key;
  for (const [v, label] of options) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = label;
    if (v === now) o.setAttribute("selected", "");
    el.appendChild(o);
  }
  return el;
}

/** 켜고 끄는 것. */
function toggle(key, now) {
  const el = document.createElement("input");
  el.type = "checkbox";
  el.dataset.set = key;
  el.toggleAttribute("checked", now);
  return el;
}

/** 끌어서 정하는 수. */
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

/** 누르는 것. */
function press(key, label) {
  const el = document.createElement("button");
  el.className = "set-press";
  el.type = "button";
  el.dataset.key = key;
  el.textContent = label;
  return el;
}

/** 테마 한 칸 — 바탕, 사이드바, 강조를 그대로 보여준다. */
function swatch(theme) {
  const el = document.createElement("button");
  el.className = "th";
  el.type = "button";
  el.dataset.key = `theme:${theme.name}`;
  el.dataset.on = String(theme.name === themeName());
  const c = theme[modeName()];
  el.innerHTML =
    `<span class="th__box" style="background:${c.bg}">` +
    `<span class="th__side" style="background:${c.card}"></span>` +
    `<span class="th__dot" style="background:${c.focus}"></span></span>` +
    `<span class="th__name">${theme.name}</span>`;
  return el;
}

function drawGeneral() {
  body.append(caption("테마는 형태와 색의 성격을 정하고, 모드는 그 테마의 밝은 쪽과 어두운 쪽을 고른다."));
  const grid = document.createElement("div");
  grid.className = "th-grid";
  for (const t of THEMES) grid.appendChild(swatch(t));
  body.append(grid);
  body.append(row("모드", choose("mode", MODES.map((m) => [m, m]), modeName())));

  body.append(caption("자리를 바꾸는 것들. 판의 크기와 카드의 자리가 함께 움직인다."));
  body.append(row("프로젝트 탭", choose("projectTabs", [["top", "위"], ["left", "왼쪽"]], value("projectTabs"))));
  body.append(row("레일 거동", choose("rail",
    [["flow", "FLOW — 포커스를 따라간다"], ["pin", "PIN — 자리를 지킨다"], ["off", "없음"]], value("rail"))));
  body.append(row("좌측 자리", toggle("left", value("left"))));
  body.append(row("우측 자리", toggle("right", value("right"))));
  body.append(row("포커스 밖 흐리게", toggle("dim", value("dim"))));
  body.append(row("통로", slide("gap", 0, 24, halfGap(), "px")));

  body.append(caption("보이는 것만 바꾸는 것들. 자리는 그대로다."));
  body.append(row("포커스 표시", choose("focusInd", [["border", "보더"], ["corner", "꺽쇠"]], value("focusInd"))));
  body.append(row("경계선", choose("fullRule", [["hide", "가림"], ["show", "보임"]], value("fullRule"))));
}

function drawSidebars() {
  body.append(caption("자리마다 세트를 건다. 걸지 않으면 그 사이드바는 없다."));
  const options = [["", "없음"], ...sets().map((s) => [s.id,
    `${s.title} — ${s.sections.map((id) => section(id).name).join(" · ")}`])];
  body.append(row("좌측", choose("link:left:", options, linkedId("left", null) ?? "")));
  for (const p of plugins()) {
    body.append(row(`${p.name} 레일`, choose(`link:rail:${p.id}`, options, linkedId("rail", p.id) ?? "")));
    body.append(row(`${p.name} 우측`, choose(`link:right:${p.id}`, options, linkedId("right", p.id) ?? "")));
  }
}

function drawCompositing() {
  body.append(caption("커밋 지연은 V7a 를, 적용 오차는 V7b 를 뒤집는다. 실제 앱의 어긋남을 여기서 만들어 본다."));
  body.append(row("커밋 지연", slide("knob:latency", 0, 600, knobs.latency, "ms")));
  body.append(row("적용 오차", slide("knob:skew", 0, 24, knobs.skew, "px")));
  body.append(row("", press("press:build", "초기 배치로")));
}

const SECTIONS = [
  ["general", "일반", drawGeneral],
  ["sidebars", "사이드바", drawSidebars],
  ["compositing", "합성", drawCompositing],
];

/** 카드 한 장. 열 때 만든다. */
function makeCard() {
  const el = document.createElement("div");
  el.className = "set-card";
  el.id = "settings";
  el.dataset.nativeModal = "";
  el.innerHTML =
    '<header class="set-card__head" data-grip>' +
      '<span class="set-grip">⠿</span>' +
      '<span class="set-card__title">설정</span>' +
      `<button class="act" type="button" data-key="close" title="닫는다">${icon("close")}</button>` +
    '</header>' +
    '<div class="set-card__body">' +
      '<nav class="set-card__nav"></nav>' +
      '<div class="set-card__pane"></div>' +
    '</div>';
  el.addEventListener("click", (e) => {
    const hit = e.target.closest("[data-key]");
    if (hit) answer(hit.dataset.key, "");
  });
  el.addEventListener("change", (e) => {
    const c = e.target.closest("[data-set]");
    if (c) answer(c.dataset.set, c.type === "checkbox" ? String(c.checked) : c.value);
  });
  // 호스트가 있으면 이 요소는 그려지지 않지만 자리는 지킨다. 그래서 잡이를 끄는
  // 일은 사본이 있는 뷰에서 일어나고, 그 답이 여기로 온다.
  onGripDrag(el, (dx, dy) => answer("move", `${dx},${dy}`));
  return el;
}

/** 카드를 다시 그리고, 열려 있으면 그 뷰에도 새 내용을 준다. */
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
  window.hostOverlay?.update(card);
}

/**
 * 카드가 답한 것 하나. 무엇을(key), 무엇으로(value).
 *
 * 조작마다 리스너를 달지 않는다 — 네이티브 뷰가 그리는 것은 이 요소의 사본이라
 * 거기 붙인 리스너는 돌지 않는다.
 */
function answer(key, val) {
  if (key === "" || key === "close") return closeSettings();
  if (key === "move") return moveBy(...val.split(",").map(Number));
  const [kind, a, b] = key.split(":");
  if (kind === "nav") { here = a; return drawSettings(); }
  if (kind === "theme") return applyTheme(a, modeName());
  if (kind === "press") { if (a === "build") build(); return; }
  if (kind === "link") return link(a, b || null, val || null);
  if (kind === "knob") { knobs[a] = Number(val); return; }
  // 나머지는 설정의 이름 그대로다. 조작이 문자열을 주므로 그 이름의 지금 값을
  // 보고 무엇으로 읽을지 정한다.
  const now = value(key);
  set({ [key]: typeof now === "boolean" ? val === "true"
    : typeof now === "number" ? Number(val) : val });
}

/** 카드가 선 자리. 판을 기준으로 잰다 — 호스트가 그 좌표로 뷰를 놓는다. */
function cardRect() {
  const plane = document.getElementById("plane").getBoundingClientRect();
  const r = card.getBoundingClientRect();
  return { x: r.left - plane.left, y: r.top - plane.top, w: r.width, h: r.height };
}

/**
 * 잡이를 끈 만큼 옮긴다. 창 안에 8px 을 남기는 것은 구 프로젝트와 같다.
 *
 * 어디에 서 있는지는 요소가 안다. 따로 기억해 두면 요소와 기억이 갈라진다.
 */
function moveBy(dx, dy) {
  const r = card.getBoundingClientRect();
  card.style.left = `${Math.max(8, Math.min(innerWidth - r.width - 8, r.left + dx))}px`;
  card.style.top = `${Math.max(8, Math.min(innerHeight - r.height - 8, r.top + dy))}px`;
  card.style.transform = "none";
  const rect = cardRect();
  if (window.hostOverlay) window.hostOverlay.place(rect);
  else standIn(true, rect);
}

/**
 * 카드 밖을 누르면 닫는다.
 *
 * 막을 누른 것도, 네이티브 표면을 누른 것도 같은 하나의 누름으로 온다: 표면은
 * OS 뷰라 그 위의 누름이 이 문서에 닿지 않지만, 호스트가 알려 주면 판이 그
 * 표면의 자리 요소에서 pointerdown 을 낸다(plane.js 의 pressSurface). 그래서
 * 「어디를 눌렀나」를 조건으로 따지지 않고 카드 안인지만 본다.
 */
function pressedOutside(e) {
  if (!e.target.closest(".set-card")) closeSettings();
}

/** 연다. 호스트가 있으면 그 뷰가 표면들 위에 그리고, 없으면 여기서 그린다. */
export function openSettings() {
  if (card) return;
  // 막이 먼저다. 모달이 열린 동안 판은 누름을 받지 않는다 — 막이 없으면 카드
  // 옆의 divider 가 그대로 끌린다. 호스트가 카드를 가져가면 이 문서에 남는 것은
  // 막뿐이고, 막이 하는 일은 그때도 같다.
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
  if (window.hostOverlay) {
    // 호스트가 그리므로 여기서는 보이지 않는다. 자리는 그대로 지킨다 — 카드가
    // 어디에 얼마만 한 크기로 서 있는지는 이 요소에게 물어야 한다.
    card.style.visibility = "hidden";
    window.hostOverlay.show(card, rect, answer);
  } else {
    standIn(true, rect);
  }
}

/** 닫는다. 막과 카드는 사라진다. */
function closeSettings() {
  if (!card) return;
  document.removeEventListener("pointerdown", pressedOutside);
  if (window.hostOverlay) window.hostOverlay.hide();
  else standIn(false);
  scrim.remove();
  scrim = null;
  card = null;
  nav = null;
  body = null;
}

addEventListener("keydown", (e) => { if (e.key === "Escape") closeSettings(); });
