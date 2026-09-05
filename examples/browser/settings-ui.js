// 설정 모달.
//
// 구 프로젝트의 모양 그대로다: 520px 카드, 머리에 잡이(⠿)와 ✕, 왼쪽에 절
// 목록, 오른쪽에 「이름 130px + 조작」 줄, 절마다 설명 한 줄.
//
// 판 위에 뜬다. 네이티브 표면은 OS 뷰라서 DOM 이 그 위에 그릴 수 없으므로,
// 열려 있는 동안 표면을 물러나게 하고 그 자리에 대역을 세운다 — 레이어가 쓰는
// 그 방법이다.
import { standIn } from "./compositor.js";
import { icon } from "./icons.js";
import { plugins, section } from "./plugins/registry.js";
import {
  MODES, THEMES, applyTheme, halfGap, link, linkedId, modeName, sets, set, themeName, value,
} from "./settings.js";
import { build } from "./plane.js";
import { knobs } from "./compositor.js";

const card = document.getElementById("settingsCard");
const nav = document.getElementById("settingsNav");
const body = document.getElementById("settingsBody");
const shade = document.getElementById("settingsShade");

/** 지금 열려 있는 절. */
let section_ = "general";

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

/** 절의 머리와 설명. */
function caption(text) {
  const el = document.createElement("p");
  el.className = "set-caption";
  el.textContent = text;
  return el;
}

/** 고르는 것 하나. */
function choose(options, now, take) {
  const el = document.createElement("select");
  for (const [v, label] of options) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = label;
    el.appendChild(o);
  }
  el.value = now;
  el.addEventListener("change", () => take(el.value));
  return el;
}

/** 끌어서 정하는 수 하나. */
function slide(min, max, now, unit, take) {
  const wrap = document.createElement("span");
  wrap.className = "set-slide";
  const el = document.createElement("input");
  el.type = "range";
  el.min = String(min);
  el.max = String(max);
  el.value = String(now);
  const out = document.createElement("output");
  out.textContent = `${now}${unit}`;
  el.addEventListener("input", () => {
    out.textContent = `${el.value}${unit}`;
    take(Number(el.value));
  });
  wrap.append(el, out);
  return wrap;
}

/** 색 하나. 비우면 테마의 색으로 돌아간다. */
function colour(token) {
  const el = document.createElement("input");
  el.type = "color";
  const root = document.documentElement;
  const now = getComputedStyle(root).getPropertyValue(token).trim();
  el.value = /^#[0-9a-f]{6}$/i.test(now) ? now : "#000000";
  el.addEventListener("input", () => root.style.setProperty(token, el.value));
  return el;
}

/** 누르는 것 하나. */
function press(label, take) {
  const el = document.createElement("button");
  el.className = "set-press";
  el.type = "button";
  el.textContent = label;
  el.addEventListener("click", take);
  return el;
}

/** 켜고 끄는 것 하나. */
function toggle(now, take) {
  const el = document.createElement("input");
  el.type = "checkbox";
  el.checked = now;
  el.addEventListener("change", () => take(el.checked));
  return el;
}

/** 테마 한 칸 — 바탕, 사이드바, 강조를 그대로 보여준다. */
function swatch(theme) {
  const el = document.createElement("button");
  el.className = "th";
  el.type = "button";
  el.dataset.on = String(theme.name === themeName());
  const c = theme[modeName()];
  el.innerHTML =
    `<span class="th__box" style="background:${c.bg}">` +
    `<span class="th__side" style="background:${c.card}"></span>` +
    `<span class="th__dot" style="background:${c.focus}"></span></span>` +
    `<span class="th__name">${theme.name}</span>`;
  el.addEventListener("click", () => applyTheme(theme.name, modeName()));
  return el;
}

function drawGeneral() {
  body.append(caption("테마는 형태와 색의 성격을 정하고, 모드는 그 테마의 밝은 쪽과 어두운 쪽을 고른다."));
  const grid = document.createElement("div");
  grid.className = "th-grid";
  for (const t of THEMES) grid.appendChild(swatch(t));
  body.append(grid);
  body.append(row("모드", choose(MODES.map((m) => [m, m]), modeName(),
    (m) => applyTheme(themeName(), m))));

  body.append(caption("자리를 바꾸는 것들. 판의 크기와 카드의 자리가 함께 움직인다."));
  body.append(row("프로젝트 탭", choose([["top", "위"], ["left", "왼쪽"]],
    value("projectTabs"), (v) => set({ projectTabs: v }))));
  body.append(row("레일 거동", choose(
    [["flow", "FLOW — 포커스를 따라간다"], ["pin", "PIN — 자리를 지킨다"], ["off", "없음"]],
    value("rail"), (v) => set({ rail: v }))));
  body.append(row("좌측 자리", toggle(value("left"), (v) => set({ left: v }))));
  body.append(row("우측 자리", toggle(value("right"), (v) => set({ right: v }))));
  body.append(row("포커스 밖 흐리게", toggle(value("dim"), (v) => set({ dim: v }))));
  body.append(row("통로", slide(0, 24, halfGap(), "px", (v) => set({ gap: v }))));

  body.append(caption("보이는 것만 바꾸는 것들. 자리는 그대로다."));
  body.append(row("포커스 표시", choose([["border", "보더"], ["corner", "꺽쇠"]],
    value("focusInd"), (v) => set({ focusInd: v }))));
  body.append(row("경계선", choose([["hide", "가림"], ["show", "보임"]],
    value("fullRule"), (v) => set({ fullRule: v }))));
  body.append(row("포커스 색", colour("--focus")));
  body.append(row("레일 색", colour("--rail")));
  body.append(row("", press("테마 색으로", () => {
    for (const t of ["--focus", "--rail"]) document.documentElement.style.removeProperty(t);
    drawSettings();
  })));
}

/* 합성의 손잡이. 설정이 아니라 이 시뮬레이터가 실제 앱의 지연을 흉내 내는
   값이다 — 저장할 것이 아니므로 컴포지터가 갖는다. */
function drawCompositing() {
  body.append(caption("커밋 지연은 V7a 를, 적용 오차는 V7b 를 뒤집는다. 실제 앱의 어긋남을 여기서 만들어 본다."));
  body.append(row("커밋 지연", slide(0, 600, knobs.latency, "ms", (v) => { knobs.latency = v; })));
  body.append(row("적용 오차", slide(0, 24, knobs.skew, "px", (v) => { knobs.skew = v; })));
  body.append(row("", press("초기 배치로", build)));
}

function drawSidebars() {
  body.append(caption("자리마다 세트를 건다. 걸지 않으면 그 사이드바는 없다."));
  const options = () => [["", "없음"], ...sets().map((s) => [s.id,
    `${s.title} — ${s.sections.map((id) => section(id).name).join(" · ")}`])];
  body.append(row("좌측", choose(options(), linkedId("left", null) ?? "",
    (v) => link("left", null, v || null))));
  for (const p of plugins()) {
    body.append(row(`${p.name} 레일`, choose(options(), linkedId("rail", p.id) ?? "",
      (v) => link("rail", p.id, v || null))));
    body.append(row(`${p.name} 우측`, choose(options(), linkedId("right", p.id) ?? "",
      (v) => link("right", p.id, v || null))));
  }
}

const SECTIONS = [
  ["general", "일반", drawGeneral],
  ["sidebars", "사이드바", drawSidebars],
  ["compositing", "합성", drawCompositing],
];

/** 지금 절을 다시 그린다. 설정이 바뀌면 부른다. */
export function drawSettings() {
  if (shade.hidden) return;
  nav.textContent = "";
  for (const [id, name] of SECTIONS) {
    const b = document.createElement("button");
    b.className = "set-nav";
    b.type = "button";
    b.dataset.on = String(id === section_);
    b.textContent = name;
    b.addEventListener("click", () => { section_ = id; drawSettings(); });
    nav.appendChild(b);
  }
  body.textContent = "";
  SECTIONS.find(([id]) => id === section_)[2]();
}

/** 모달이 열려 있는가. */
export const settingsOpen = () => !shade.hidden;

/** 연다. 판 위에 뜨므로 표면은 물러나고 대역이 그 자리를 지킨다. */
export function openSettings() {
  shade.hidden = false;
  standIn(true);
  drawSettings();
}

/** 닫는다. 표면이 돌아온다. */
export function closeSettings() {
  shade.hidden = true;
  standIn(false);
}

shade.addEventListener("pointerdown", (e) => { if (e.target === shade) closeSettings(); });
document.getElementById("settingsClose").addEventListener("click", closeSettings);
addEventListener("keydown", (e) => { if (e.key === "Escape" && settingsOpen()) closeSettings(); });

/* 잡이를 끌면 카드가 움직인다. 판 위를 덮으므로, 보고 싶은 곳을 비켜 둘 수 있어야 한다. */
{
  const grip = document.getElementById("settingsGrip");
  let from = null;
  grip.addEventListener("pointerdown", (e) => {
    from = { x: e.clientX, y: e.clientY, left: card.offsetLeft, top: card.offsetTop };
    grip.setPointerCapture(e.pointerId);
  });
  grip.addEventListener("pointermove", (e) => {
    if (!from) return;
    card.style.left = `${from.left + e.clientX - from.x}px`;
    card.style.top = `${from.top + e.clientY - from.y}px`;
    card.style.margin = "0";
  });
  grip.addEventListener("pointerup", () => { from = null; });
}
