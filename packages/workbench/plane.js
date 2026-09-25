// 판 하나. 카드, 탭, 드래그, 레일, 선택 레이어, 렌더링을 담당한다.
//
// 표면의 위치를 카드 안 슬롯 요소에 기록하고, 그 위에 DOM 을 그릴 때 표면을 숨기도록
// 요청한다. 표면을 측정하고 보고하는 방법은 알지 않는다.
//
// 검증의 존재를 알지 않는다. 렌더링 완료만 통지하고 이후 처리는 문서가 정한다.
import { Soksak, SoksakView, outline } from "soksak";
import { cardRadius, halfGap, linkedSet, pluginSettings, set as setSetting, stagePad, value } from "./settings.js";
import { nextTextSize, notifyTextSize, setSurfaceTextSize, setTextScope, textScope } from "./text-size.js";
import { hasPlugin, isPlace, isRailId, plugin, plugins, railId, railKind, sectionNames } from "./registry.js";
import { environment } from "./environment.js";
import { standIn } from "./compositor.js";
import { native, onSurfaceInput, overlay, report, shapes, windowSidecar } from "./host.js";
import { issueId } from "./ids.js";
import { bind, delegate, mark, run } from "./commands.js";
import { disposeSurface, focusSurface, mountSurface } from "./surface-modules.js";
import { setSurfaceStatus } from "./surface-status.js";
import { clearVisibleNotices, onTabReports, recordOrigin, setVisibleTab, tabLabel, tabNotice } from "./tab-reports.js";

const NEEDS = ["cards", "card", "insertAt", "moveTo", "standings", "moveBoundary", "zoneAt",
  "splitToward", "replace"];
{
  const probe = new Soksak(undefined, { width: 100, height: 100 });
  const missing = NEEDS.filter((k) => typeof probe[k] === "undefined");
  if (missing.length) {
    document.body.innerHTML =
      '<h1>이 문서와 soksak 이 서로 다른 판이다</h1>' +
      '<p style="color:#ff7c7c;max-width:70ch">라이브러리에 <code>' + missing.join("</code>, <code>") +
      '</code> 가 없다. 브라우저가 둘 중 하나만 새로 받아온 상태이고, ' +
      '강제 새로고침(⇧⌘R)이면 사라진다. 그래도 남으면 라이브러리를 다시 빌드해야 한다.</p>';
    throw new Error("soksak mismatch: " + missing.join(", "));
  }
}

/* 카드의 머리와 발 높이. 이 값이 드롭 구획의 경계이자 스타일시트의 행 높이다. 두
   곳에 적으면 한쪽만 바뀌었을 때 구획이 머리 끝에서 어긋난다. */
const HEADER = 32, FOOTER = 22;
document.documentElement.style.setProperty("--head", `${HEADER}px`);
document.documentElement.style.setProperty("--foot", `${FOOTER}px`);


/* 포커스를 잃은 표면의 흐림 여부. 표면은 카드마다 하나이므로 카드 단위로 판정한다. */
const dimmed = (cardId) =>
  value("dim") && cardId !== focusedId;

/* 표면은 네이티브 뷰이므로 그 위의 클릭이 이 문서에 도달하지 않는다. 애플리케이션이
   표면 id 를 보고하면 해당 슬롯 요소에서 pointerdown 을 발생시킨다. 포커스 이동과
   레이어 닫기를 이미 pointerdown 을 수신하는 쪽이 처리한다.

   표면 하나는 탭 하나이므로 그 id 는 탭의 id 다. */
const pressSurface = (tabId) => {
  const slot = document.querySelector(
    `[data-native-surface-id="${tabId}"][data-native-surface]`);
  if (!slot) return;
  slot.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
};

/* 호스트가 넘긴 드래그를 잡고 있는 divider. 누를 때 정해지고 놓을 때 비운다. */
let heldDivider = null;

/* 왼쪽 버튼의 한 걸음. 호스트가 좌표를 이 문서의 것으로 변환해 보낸다.
   phase 는 0 이 누름, 1 이 이동, 2 가 놓음이다.

   divider 의 잡는 영역은 통로보다 넓다. 통로가 선 하나 폭이면 그 영역 전체가 표면
   아래에 놓여 누름이 이 문서에 도달하지 않으므로, 호스트가 좌표를 넘기고 여기서
   그 좌표가 어느 divider 위인지 판정한다. 뷰는 mouse 이벤트로도 divider 를 움직일
   수 있으므로 판이 아니라 그 요소에 이벤트를 낸다. */
export const surfaceInput = ({ phase, x, y }) => {
  if (phase === 0) {
    heldDivider = document.elementFromPoint(x, y)?.closest(".sp-divider") ?? null;
    heldDivider?.dispatchEvent(new MouseEvent("mousedown", {
      bubbles: true, clientX: x, clientY: y, button: 0, buttons: 1,
    }));
    return;
  }
  if (!heldDivider) return;
  if (phase === 1) {
    document.dispatchEvent(new MouseEvent("mousemove", {
      bubbles: true, clientX: x, clientY: y, buttons: 1,
    }));
    return;
  }
  document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: x, clientY: y }));
  heldDivider = null;
};

onSurfaceInput({ press: pressSurface, input: surfaceInput });


const plane = document.getElementById("plane");
const railPath = document.getElementById("railPath");
const dropEl = document.getElementById("drop");
const pickerEl = document.getElementById("picker");

// 레일을 닫으면 카드와 함께 폭도 사라진다. 사용자가 드래그로 지정한 폭을 플러그인
// 종류별로 보관했다가 다시 열 때 그 폭으로 복원한다. 설정이 아니라 스페이스의 값이다.
//
// 초기 폭은 종류와 무관하게 같은 값이다. 등록된 종류마다 같은 값으로 채우므로
// 플러그인이 늘어도 이 파일을 수정할 필요가 없다.
const RAIL_WIDTH = 190;
const freshRailWidth = () =>
  Object.fromEntries(plugins().map((p) => [p.id, RAIL_WIDTH]));
// 등록이 끝난 뒤에 채운다. 모듈 평가 시점에 읽으면 등록 순서에 따라 결과가 달라진다.
let railWidth = {};
let edgeWidth = {};

/* ── 자리 ─────────────────────────────────────────────────────────────────
   어디 서는가          무엇이 서는가
   left   첫 열, 고정폭      포커스와 무관하게 걸린 세트
   right  마지막 열, 고정폭   포커스된 플러그인에 걸린 세트
   rail   가운데 열, 고정폭   포커스된 플러그인에 걸린 세트 · 포커스를 따라 이동
   셋 다 카드다. 자리 사이에 모드 전환은 없다 — 자리가 곧 규칙이다.

   무엇이 서는지는 여기서 정하지 않는다. 사람이 섹션을 골라 세트로 묶고,
   설정에서 그 세트를 자리에 건다. 걸지 않으면 그 사이드바는 없다.        */

let grid, view, focusedId;
// 탭 제목의 번호. 식별자가 아니라 표시용 이름이므로 카운터로 만든다.
let named = 0;

/* ── 탭 규칙 ──────────────────────────────────────────────────────────────
   T1 카드는 탭 목록과 활성 탭 하나를 갖는다
   T2 + 와 쪼개기는 종류를 먼저 묻고 새 탭을 생성한다. + 는 같은 카드에, 쪼개기는 새 카드에
      기존 탭의 이동은 T3·T4 가 담당한다
   T3 가운데 드롭 = 대상 카드의 탭이 된다. 배치는 그대로다
   T4 변에 드롭 = 그쪽에 새 자리가 필요하다
   T5 마지막 탭이 떠나면 그 카드는 사라진다 — 빈 카드는 남지 않는다        */
const tab = (plugin, title) => ({ id: issueId("tab"), plugin, title });
const tabsOf = (card) => card?.data?.tabs ?? [];
const activeTab = (card) => tabsOf(card).find((t) => t.id === card.data.activeId) ?? tabsOf(card)[0];
const focusedPlugin = () => activeTab(grid.card(focusedId))?.plugin ?? null;
/** 탭에 보이는 이름: 표면이 알린 제목이 있으면 그것, 없으면 탭 이름. */
const tabName = (t) => tabLabel(t.id) ?? t.title;

/** 새 탭 하나. 번호는 화면에 보이는 이름일 뿐이고 id 는 ids.js 가 발급한다. */
function newTab(kind) {
  const t = tab(kind, "");
  t.title = `${plugin(kind).mark} 탭 ${++named}`;
  return t;
}

/**
 * 해당 자리에 연결된 세트와 그 세트가 담은 섹션 이름을 반환한다.
 *
 * 연결된 세트가 없으면 null 을 반환하고 사이드바를 표시하지 않는다.
 */
function standingSet(place) {
  // 레일은 자신의 플러그인 종류에 해당하는 세트를 표시한다. 포커스가 다른 종류로
  // 이동해도 레일의 종류는 바뀌지 않는다.
  const kind = railKind(place);
  const set = kind ? linkedSet("rail", kind)
    : place === "left" ? linkedSet("left", null)
    : linkedSet(place, focusedPlugin());
  if (!set) return null;
  return { name: set.title, sections: sectionNames(set.sections) };
}

/** environment.json 의 workspace.grid 로 새 스페이스의 배치를 만든다. 탭 id 는 새로 발급한다. */
function initial() {
  const { grid: declared } = environment().workspace;
  const cards = declared.cards.map(({ tabs, ...card }) => {
    if (!tabs) return { ...card };
    const made = tabs.map((t) => tab(t.plugin, t.title));
    return { ...card, data: { tabs: made, activeId: made[0].id } };
  });
  return { xs: [...declared.xs], ys: [...declared.ys], cards };
}


/* ── 카드 ─────────────────────────────────────────────────────────────── */

function createCard(card) {
  const el = document.createElement("article");
  el.className = "card";
  el.dataset.expose = "core.card";
  el.innerHTML = isPlace(card.id)
    ? '<header class="chrome"></header><div class="set"></div><footer class="status"></footer>'
    : '<header class="chrome"></header><div class="slot"></div><footer class="status"></footer>';
  // 카드 객체를 클로저에 담지 않고 요소의 data-card-id 를 읽는다. 스페이스를
  // 바꾸면 같은 id 로 새 카드 객체가 만들어지므로, 담아 둔 참조는 없어진 객체다.
  el.dataset.command = "core.card.focus";
  el.addEventListener("pointerdown", (e) => {
    const id = el.dataset.cardId;
    // 누른 카드가 글자 크기의 범위다(docs/spec/text-size.md).
    if (id) setTextScope({ kind: "card", card: id });
    if (!id || isPlace(id) || e.target.closest(".tab__x, .chrome__act, .chrome__ham")) return;
    const active = activeTab(grid.card(id));
    if (focusedId !== id) {
      // 카드 포커스가 만든 렌더는 표시를 마치면 대기 중인 표면 포커스를 가져간다. 명령이 끝난 뒤에 적으면
      // 렌더가 먼저 끝나 포커스가 다음 렌더로 밀리므로, 명령을 실행하기 전에 적는다(V5-46).
      if (active) requestSurfaceFocus(active.id);
      return Promise.resolve(run("core.card.focus", { card: id })).catch((error) => {
        if (active) cancelSurfaceFocus(active.id);
        throw error;
      });
    }
    return active ? focusSurface(active.id) : false;
  });
  return el;
}

/**
 * 변경된 부분만 갱신한다.
 *
 * 이전에는 렌더마다 `chrome.innerHTML = ""` 로 다시 만들었다. 노드 87개 중 포인터
 * 이동 한 번에 52개가 교체되어 hover 와 포커스가 끊기고, 드래그 중이던 탭이 사라져
 * `pointerup` 이 도착하지 않았다. 탭 목록이 실제로 달라졌을 때만 다시 만든다.
 */
const setText = (el, text) => { if (el.textContent !== text) el.textContent = text; };
const setHTML = (el, html) => { if (el.dataset.html !== html) { el.innerHTML = html; el.dataset.html = html; } };

function updateCard(el, card) {
  const place = isPlace(card.id) ? card.id : null;
  // 카드 내용의 실제 글자 배율(프레임 배율 × 카드 배율). 배율이 1 이면 zoom 을 선언하지 않는다. 값이 1 인
  // zoom 선언만으로도 WebKit 이 표면 내용을 다시 그리는 비용이 커져 끌기 중 표시가 줄었다.
  const textZoom = value("textSize") * cardTextSize(card);
  if (textZoom === 1) {
    delete el.dataset.textZoom;
    el.style.removeProperty("--text-zoom");
  } else {
    el.dataset.textZoom = "";
    el.style.setProperty("--text-zoom", String(textZoom));
  }
  el.dataset.role = card.fixed ? "fixed" : "pane";
  el.dataset.focused = String(card.id === focusedId);
  const chrome = el.querySelector(".chrome");
  const status = el.querySelector(".status");
  let statusText = status.querySelector(".status__text");
  if (!statusText) {
    statusText = document.createElement("span");
    statusText.className = "status__text";
    status.appendChild(statusText);
  }

  if (place) {
    const kind = railKind(place);
    // 레일의 이름은 그 레일이 담당하는 플러그인의 이름에서 나온다. 여기에 적으면
    // 플러그인을 추가할 때마다 이 파일을 고쳐야 한다.
    const name = place === "left" ? "좌측" : place === "right" ? "우측"
      : kind ? `${plugin(kind).name} 레일` : "레일";
    setHTML(chrome, `<span class="tab" data-active="true">${name}</span>`);
    const set = standingSet(place);
    setHTML(el.querySelector(".set"), set
      ? `<b>${set.name}</b>${set.sections.join(" · ")}`
      : "<b>—</b>포커스된 플러그인 없음");
    setText(status, place === "left"
      ? `열 ${card.c0}–${card.c1} · 설치 전체가 한 세트`
      : kind
        ? `열 ${card.c0}–${card.c1} · ${kind}${focusedPlugin() === kind ? " · 포커스" : ""}`
        : `열 ${card.c0}–${card.c1} · 포커스: ${focusedPlugin() ?? "없음"}`);
    return;
  }

  const tabs = tabsOf(card);
  const key = tabs.map((t) => `${t.id}\u0000${tabName(t)}`).join("\u0001");
  let ham = chrome.querySelector(".chrome__ham");
  if (!ham) {
    ham = document.createElement("button");
    ham.className = "chrome__ham";
    ham.dataset.expose = "core.card.tab-list";
    ham.type = "button";
    ham.title = "탭 목록";
    ham.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true">' +
      '<path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11"/></svg>';
    bind(ham, "core.card.tab-list", () => ({ card: el.dataset.cardId }));
    chrome.insertBefore(ham, chrome.firstChild);
  }
  let strip = chrome.querySelector(".chrome__tabs");
  if (!strip) {
    strip = document.createElement("div");
    strip.className = "chrome__tabs";
    ham.after(strip);                                 // ≡, 탭 목록, 도구 순으로 배치한다
  }
  let acts = chrome.querySelector(".chrome__acts");

  if (chrome.dataset.tabs !== key) {
    chrome.dataset.tabs = key;
    for (const gone of [...strip.querySelectorAll(".tab")]) gone.remove();
    for (const t of tabs) {
      const b = document.createElement("span");
      b.className = "tab";
      b.dataset.expose = "core.card.tab";
      b.dataset.tabId = t.id;
      b.draggable = false;
      mark(b, "core.tab.select", { tab: t.id });
      // 제목은 `textContent` 로 설정한다. 사용자 입력을 마크업으로 해석하지 않는다.
      b.innerHTML = '<span class="tab__name"></span>' +
        '<button class="tab__x" title="닫기" data-expose="core.card.tab-close">&#10005;</button>';
      b.querySelector(".tab__name").textContent = tabName(t);
      // 누름은 탭을 고르고 드래그를 시작한다. 놓은 자리의 결과는 core.tab.move 가 만든다.
      b.addEventListener("pointerdown", (e) => {
        if (e.target.closest(".tab__x")) return;
        const own = grid.card(el.dataset.cardId);
        if (!own) return;
        beginTabDrag(e, own.id, t.id);
        return run("core.tab.select", { tab: t.id });
      });
      bind(b.querySelector(".tab__x"), "core.tab.close", { tab: t.id });
      strip.appendChild(b);
    }
  }
  for (const b of strip.querySelectorAll(".tab")) {
    b.dataset.active = String(b.dataset.tabId === card.data.activeId);
  }
  drawNotices(chrome, tabs);

  // 카드의 연산은 넷이다: 탭 추가(T2), 세로 분할, 가로 분할, 닫기.
  // 탭 ✕ 는 그 탭 하나를 닫고 마지막 탭이면 카드도 닫는다(T5). 카드 ✕ 는 탭 수와
  // 무관하게 카드를 닫는다. 서로 다른 연산이므로 둘 다 둔다.
  if (!acts) {
    acts = document.createElement("span");
    acts.className = "chrome__acts";
    // 생성 버튼 3개를 앞에, 닫기를 끝에 배치한다. 닫기는 되돌릴 수 없으므로 다른
    // 버튼 사이에 두지 않는다.
    for (const [what, title, svg] of [
      ["add", "이 카드에 탭 추가 — 무엇을 띄울지 묻는다", '<path d="M8 3v10M3 8h10"/>'],
      ["x", "세로선으로 쪼개기 — 좌우로 나뉜다",
        '<rect class="half" x="2" y="3" width="6" height="10" rx="1.5"/>' +
        '<rect x="2" y="3" width="12" height="10" rx="2"/><path d="M8 3v10"/>'],
      ["y", "가로선으로 쪼개기 — 위아래로 나뉜다",
        '<rect class="half" x="3" y="2" width="10" height="6" rx="1.5"/>' +
        '<rect x="3" y="2" width="10" height="12" rx="2"/><path d="M3 8h10"/>'],
      ["close", "이 카드를 닫는다 — 안의 탭이 몇 개든 함께 간다",
        '<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>'],
    ]) {
      const b = document.createElement("button");
      b.className = "chrome__act";
      b.dataset.do = what;
      b.dataset.expose = { add: "core.card.add", x: "core.card.split-x", y: "core.card.split-y", close: "core.card.close" }[what];
      b.dataset.title = title;
      b.title = title;
      b.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true">${svg}</svg>`;
      // 닫기는 카드를 닫는다. 나머지 3개는 무엇을 띄울지 묻는 메뉴를 연다.
      if (what === "close") bind(b, "core.card.close", () => ({ card: el.dataset.cardId }));
      else bind(b, "core.card.menu", () => ({ card: el.dataset.cardId, menu: MENU_OF[what] }));
      acts.appendChild(b);
    }
    chrome.appendChild(acts);
  }
  for (const b of acts.querySelectorAll(".chrome__act")) {
    const what = b.dataset.do;
    const off = what === "close" ? !grid.canClose(card.id)
      : what === "add" ? false : !grid.canSplit(card.id, what);
    if (b.disabled !== off) b.disabled = off;
    // 이 카드는 자리가 아니므로 `fixed` 가 아니다. 닫히지 않는 이유는 하나다.
    const title = off && what === "close"
      ? "닫을 수 없다 — 어느 이웃도 이 자리를 빈틈없이 못 메운다"
      : b.dataset.title;
    if (b.title !== title) b.title = title;
  }

  // 표면의 슬롯. 컴포지터는 판의 구조를 알지 않으므로 필요한 값을 여기에 기록한다.
  //
  // 표면의 정체는 탭이다. 카드로 하면 같은 카드의 다른 탭들이 표면 하나를 나눠
  // 쓰고, 카드 id 는 스페이스마다 같은 값이라 스페이스가 달라도 같은 표면이 된다.
  const slot = el.querySelector(".slot");
  const shown = activeTab(card);
  slot.dataset.nativeSurface = "stub";
  slot.dataset.nativeSurfaceId = shown.id;
  slot.dataset.nativeLayer = "10";
  slot.dataset.nativePlugin = shown.plugin;
  slot.dataset.nativeTitle = shown.title;
  slot.dataset.nativeDim = String(dimmed(card.id));
  const surface = plugin(shown.plugin).surface(shown.id);
  mountSurface(slot, surface, {
    onState: (state) => {
      slot.dataset.surfaceStatus = state.phase;
      setSurfaceStatus(status, state);
      surfaceStates.set(shown.id, {
        phase: state.phase ?? "loading",
        error: state.phase === "error" ? String(state.error?.message ?? state.error ?? "") : null,
      });
      surfaceStateChanged();
    },
  }).catch((error) => {
    report(`surface ${shown.id} mount failed: ${error.message}`);
  });
  setText(statusText, `열 ${card.c0}–${card.c1} · 행 ${card.r0}–${card.r1} · 탭 ${tabs.length}`);
}

/* ── T5 — 마지막 탭이 이동하면 카드를 닫는다 ─────────────────────────── */

function closeTab(cardId, tabId) {
  const card = grid.card(cardId);
  if (!card) return;
  if (!tabsOf(card).some((t) => t.id === tabId)) return;
  disposeSurface(tabId);
  card.data.tabs = tabsOf(card).filter((t) => t.id !== tabId);
  if (card.data.tabs.length === 0) {
    // 닫을 수 없는 카드는 남으므로 탭 하나를 다시 넣는다. 종류는 포커스가 보던
    // 것이고, 없으면 등록된 첫 플러그인이다. 여기에 이름을 적으면 플러그인을 더할
    // 때마다 이 파일을 고쳐야 한다.
    if (grid.canClose(cardId)) grid.close(cardId);
    else card.data.tabs = [newTab(focusedPlugin() ?? plugins()[0].id)];
  }
  if (!tabsOf(card).some((t) => t.id === card.data?.activeId)) {
    if (card.data) card.data.activeId = tabsOf(card)[0]?.id ?? null;
  }
  if (!grid.card(focusedId)) focusedId = grid.cards.find((c) => !isPlace(c.id))?.id ?? null;
  settle();
}

/* 등록되지 않은 플러그인의 탭과 레일을 치운다. 저장된 배치는 다른 환경에서
   만들어졌을 수 있다. 탭이 모두 없어진 카드는 탭을 닫을 때와 같이 닫거나, 닫을 수
   없으면 새 탭 하나를 받는다. */
function forgetUnknown() {
  for (const { id } of [...grid.cards]) {
    const card = grid.card(id);
    if (!card) continue;
    if (isRailId(id) && !isPlace(id)) { dismiss(id); continue; }
    const tabs = tabsOf(card);
    if (tabs.every((t) => hasPlugin(t.plugin))) continue;
    card.data.tabs = tabs.filter((t) => hasPlugin(t.plugin));
    if (card.data.tabs.length === 0) {
      if (grid.canClose(id)) { grid.close(id); continue; }
      const kind = focusedPlugin();
      card.data.tabs = [newTab(hasPlugin(kind) ? kind : plugins()[0].id)];
    }
    if (!tabsOf(card).some((t) => t.id === card.data.activeId)) card.data.activeId = card.data.tabs[0].id;
  }
  for (const kind of Object.keys(railWidth)) if (!hasPlugin(kind)) delete railWidth[kind];
}

/* ── 탭 드래그 — T3/T4/T5 ─────────────────────────────────────────────── */

let tabDrag = null;

/* 탭 드래그의 상태가 바뀔 때 호출할 함수. 공개 항목이 등록한다. */
let dragChanged = () => {};

/** 탭 드래그의 상태가 바뀔 때 호출할 함수를 등록한다. */
export function onDrag(fn) {
  dragChanged = fn;
}

/* 지금 그린 드롭 미리보기. 판 좌표다. */
let dropPreview = null;

/** 진행 중인 탭 드래그. 끌리는 탭, 출발 카드, 놓을 자리, 미리보기 사각형이다. */
export const dragState = () => (tabDrag ? {
  tab: tabDrag.tabId, card: tabDrag.cardId, moved: tabDrag.moved,
  target: tabDrag.hit ? { card: tabDrag.hit.id, zone: tabDrag.hit.zone } : null,
  preview: dropPreview,
} : null);

/* 카드 보더의 두께. 머리와 발은 보더 안쪽의 행이고 zoneAt 은 카드의 rect 로 재는데
   그 rect 는 보더를 포함하므로, 보더만큼 더해야 구획의 경계가 그려진 머리의 끝에
   선다. 이음새에서는 보더가 0 이므로 값을 적지 않고 그려진 카드에서 잰다. */
const cardBorder = () => {
  const el = plane.querySelector(".card");
  return el ? parseFloat(getComputedStyle(el).borderTopWidth) : 0;
};

/**
 * 드롭 구획이 카드의 머리와 발에 내주는 높이(px).
 *
 * 판이 `zoneAt` 에 넘기는 값이고, 검증이 그려진 머리·발과 비교하는 값이다. 두 곳이
 * 각자 계산하면 한쪽만 고쳤을 때 검증이 통과한 채로 구획이 어긋난다.
 */
export const dropBands = () => {
  const edge = cardBorder();
  return { headerPx: HEADER + edge, footerPx: FOOTER + edge };
};

function beginTabDrag(e, cardId, tabId) {
  e.preventDefault();
  // 보더는 드래그 한 번 동안 바뀌지 않으므로 시작할 때 한 번 잰다.
  const band = dropBands();
  tabDrag = { cardId, tabId, from: { x: e.clientX, y: e.clientY }, moved: false, hit: null };
  const el = e.currentTarget;
  el.setPointerCapture(e.pointerId);
  el.dataset.dragging = "true";
  dragChanged();

  const onMove = (ev) => {
    if (!tabDrag) return;
    if (Math.hypot(ev.clientX - tabDrag.from.x, ev.clientY - tabDrag.from.y) > 4) tabDrag.moved = true;
    if (!tabDrag.moved) return;
    if (!tabDrag.stood) { tabDrag.stood = true; standIn(true); }
    const host = plane.getBoundingClientRect();
    const only = tabsOf(grid.card(tabDrag.cardId)).length === 1 ? tabDrag.cardId : undefined;
    tabDrag.hit = grid.zoneAt(ev.clientX - host.left, ev.clientY - host.top,
      { headerPx: band.headerPx, footerPx: band.footerPx, centreOnly: only });
    // 구획이 없는 드롭은 놓아도 배치가 거절한다. 그 자리를 잡지 않는다.
    if (!showDrop(tabDrag.cardId, tabDrag.hit)) tabDrag.hit = null;
    dragChanged();
  };
  const onUp = (ev) => {
    if (!tabDrag) return;
    try { el.releasePointerCapture(ev.pointerId); } catch {}
    delete el.dataset.dragging;
    const drag = tabDrag;
    tabDrag = null;
    hideDrop();
    if (drag.stood) standIn(false);
    el.removeEventListener("pointermove", onMove);
    el.removeEventListener("pointerup", onUp);
    el.removeEventListener("pointercancel", onUp);
    dragChanged();
    if (drag.moved && drag.hit) return run("core.tab.move", { tab: drag.tabId, card: drag.hit.id, zone: drag.hit.zone });
    settle();
  };
  el.addEventListener("pointermove", onMove);
  el.addEventListener("pointerup", onUp);
  el.addEventListener("pointercancel", onUp);
}

/* ── 선택 레이어 ──────────────────────────────────────────────────────────
   레이어는 카드가 아니므로 배치에 영향을 주지 않고 Soksak 도 인식하지 않는다.
   배치가 바뀌면 레이어의 기준 위치가 무효가 되므로 settle 이 먼저 닫는다.     */

let picker = null;

/* 표면 페이지의 상태(불러오는 중, 준비, 오류). 카드 상태 줄에 보이는 값과 같다. */
const surfaceStates = new Map();
let surfaceStateChanged = () => {};

/** 표면 상태가 바뀔 때 호출할 함수를 등록한다. */
export function onSurfaceState(fn) {
  surfaceStateChanged = fn;
}

/** 표면 id 의 상태 {phase, error}. 아직 보고가 없으면 불러오는 중이다. */
export const surfaceState = (id) => surfaceStates.get(id) ?? { phase: "loading", error: null };

/* 선택 레이어가 열리고 닫힐 때 호출할 함수. 공개 항목이 등록한다. */
let pickerChanged = () => {};

/** 선택 레이어가 열리고 닫힐 때 호출할 함수를 등록한다. */
export function onPicker(fn) {
  pickerChanged = fn;
}

/** 선택 레이어의 상태. 제목과 항목을 요소에서 읽는다. */
export const pickerState = () => ({
  open: picker !== null,
  title: picker ? pickerEl.getAttribute("aria-label") ?? "" : "",
  items: picker ? [...pickerEl.querySelectorAll(".picker__item")].map((b) => ({
    key: b.dataset.key, name: b.querySelector(".picker__name").textContent, active: b.dataset.active === "true",
  })) : [],
});

/* 카드 도구 버튼의 data-do 와 core.card.menu 의 menu 값. */
const MENU_OF = { add: "add", x: "split-x", y: "split-y" };
const DO_OF = Object.fromEntries(Object.entries(MENU_OF).map(([what, menu]) => [menu, what]));

const PICKER_ASK = {
  add: "새 탭에 무엇을 띄울까",
  x: "새 자리에 무엇을 띄울까",
  y: "새 자리에 무엇을 띄울까",
};

delegate(pickerEl);

const onPickerOutside = (e) => {
  if (pickerEl.contains(e.target)) return;
  // 레이어를 연 버튼은 자기 클릭으로 레이어를 닫으므로, 그 버튼 위의 누름은 바깥
  // 누름이 아니다. 여기서 닫으면 그 클릭이 레이어를 다시 연다.
  if (picker?.anchor?.contains(e.target)) return;
  return run("core.picker.close");
};
const onPickerKey = (e) => {
  if (e.key !== "Escape") return;
  e.stopPropagation();
  return run("core.picker.close");
};

/** 새 탭의 플러그인 종류를 선택받는다. + 와 분할 버튼이 함께 사용한다. */
function openPicker(anchor, what, cardId) {
  openLayer(anchor, PICKER_ASK[what],
    plugins().map((p) => ({ key: p.id, name: p.name, mark: p.mark, svg: p.svg })),
    (k) => (what === "add" ? addTab(cardId, k) : splitWith(cardId, what, k)));
}

/** 활성화할 탭을 선택받는다. 헤더가 접혔을 때 탭 목록을 표시한다. */
function openTabList(anchor, cardId) {
  const card = grid.card(cardId);
  if (!card?.data) return;
  openLayer(anchor, `탭 ${tabsOf(card).length}개`, tabsOf(card).map((t) => ({
    key: t.id, name: tabName(t), mark: plugin(t.plugin).mark, svg: plugin(t.plugin).svg, notice: tabNotice(t.id),
    active: t.id === card.data.activeId,
  })), (id) => {
    const c = grid.card(cardId);
    if (!c?.data || !tabsOf(c).some((t) => t.id === id)) return;
    c.data.activeId = id;
    focusedId = cardId;
    settle();
  }, "left");
}

/**
 * 기준 버튼 아래에 배치하고 판 경계 안으로 제한한다. 판 밖에는 표시할 수 없다.
 *
 * 항목 이름은 `textContent` 로 설정한다. 탭 제목은 사용자 입력이므로 마크업으로
 * 삽입하면 제목이 레이어 구조를 변경할 수 있다.
 */
function openLayer(anchor, ask, items, pick, align = "right") {
  closePicker();
  pickerEl.textContent = "";
  // 호스트가 이 레이어를 창으로 그릴 때 창 이름으로 쓴다. 보이는 물음과 같은 값이다.
  pickerEl.setAttribute("aria-label", ask);
  const head = document.createElement("div");
  head.className = "picker__head";
  head.textContent = ask;                  // 레이어 너비를 측정하기 전에 설정한다
  pickerEl.appendChild(head);
  for (const [index, it] of items.entries()) {
    const b = document.createElement("button");
    b.className = "picker__item";
    b.dataset.expose = "core.picker.item";
    mark(b, "core.picker.pick", { index });
    b.type = "button";
    b.dataset.key = it.key;
    b.dataset.active = String(!!it.active);
    if (it.notice) {
      b.dataset.notice = "true";
      b.title = it.notice;
    }
    b.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true">${it.svg}</svg>` +
      `<span class="picker__name"></span><small></small>`;
    b.querySelector(".picker__name").textContent = it.name;
    b.querySelector("small").textContent = it.mark;
    pickerEl.appendChild(b);
  }
  const host = plane.getBoundingClientRect();
  pickerEl.style.left = "0px";
  pickerEl.style.top = "0px";
  pickerEl.hidden = false;
  const p = pickerEl.getBoundingClientRect();
  const a = anchor.getBoundingClientRect();
  const fit = (v, span, room) => Math.max(2, Math.min(v, room - span - 2));
  const rect = {
    x: fit(align === "left" ? a.left - host.left : a.right - host.left - p.width, p.width, host.width),
    y: fit(a.bottom - host.top + 5, p.height, host.height),
    w: p.width, h: p.height,
  };
  pickerEl.style.left = `${rect.x}px`;
  pickerEl.style.top = `${rect.y}px`;
  picker = { anchor, pick, rect, keys: items.map((it) => it.key) };
  pickerChanged();
  // DOM 은 네이티브 뷰 위에 그릴 수 없고, 웹뷰는 DOM 을 렌더링하는 네이티브 뷰다.
  // 애플리케이션이 이 요소를 받아 그런 뷰에 렌더링하므로 아래의 표면은 계속 실행된다.
  // 요소를 통째로 넘기므로 애플리케이션은 그 내용을 알 필요가 없다.
  if (native) {
    // 모달은 닫힘을 빈 key 로 보고한다. 그것을 선택으로 넘기면 등록되지 않은
    // 플러그인을 찾다 예외가 난다.
    overlay.show(pickerEl, rect, (key) => {
      const index = items.findIndex((it) => it.key === key);
      return index < 0 ? run("core.picker.close") : run("core.picker.pick", { index });
    });
    pickerEl.hidden = true;
  } else {
    standIn(true, rect);
  }
  document.addEventListener("pointerdown", onPickerOutside, true);
  document.addEventListener("keydown", onPickerKey, true);
  // A native picker has its own WebView and receives focus when it reports ready.
  // Focusing the now-hidden DOM item here would return the first responder to the
  // main WebView and drop Escape before the native picker can close.
  if (!native) {
    (pickerEl.querySelector('.picker__item[data-active=true]') ??
     pickerEl.querySelector(".picker__item"))?.focus();
  }
}

function closePicker() {
  if (!picker) return;
  picker = null;
  pickerChanged();
  pickerEl.hidden = true;
  document.removeEventListener("pointerdown", onPickerOutside, true);
  document.removeEventListener("keydown", onPickerKey, true);
  if (native) overlay.hide(pickerEl);
  else standIn(false);
}

/** + 버튼의 후속 처리. 배치를 변경하지 않고 탭만 추가한다. */
function addTab(cardId, plugin) {
  const card = grid.card(cardId);
  if (!card?.data) return;
  const t = newTab(plugin);
  recordOrigin(t.id, activeTab(card)?.id);
  card.data.tabs.push(t);
  card.data.activeId = t.id;
  focusedId = cardId;
  settle();
  return t.id;
}

/** 쪼개기 버튼의 후속 처리. 새 카드를 만들고 선택한 종류의 탭을 그 카드에 추가한다. */
function splitWith(cardId, axis, plugin) {
  const card = grid.card(cardId);
  if (!card?.data) return;
  const t = newTab(plugin);
  recordOrigin(t.id, activeTab(card)?.id);
  // 공간이 없으면 split 이 null 을 반환한다. 원본 카드에서 제거한 탭이 없으므로
  // 복구할 상태가 없다.
  const born = grid.split(cardId, axis, { data: { tabs: [t], activeId: t.id } });
  if (born) focusedId = born;
  settle();
  return born ? { card: born, tab: t.id } : null;
}

/* 미리보기가 호스트의 뷰에 있는가. 드래그 한 번 동안 그 뷰를 유지하고 위치만
   갱신한다. 매 프레임 다시 만들면 깜빡인다. */
let dropShown = false;

/**
 * 이 드롭이 낳는 카드의 사각형. 배치가 그 연산을 거절하면 undefined 를 반환한다.
 *
 * 판의 사본에서 그 연산을 수행하고 결과를 읽는다. 사본이므로 살아 있는 판은 바뀌지
 * 않는다. 대상 카드의 절반을 계산하면 그려지는 자리와 다르다: 잘린 두 쪽은 사이의
 * 통로를 나눠 가지므로 각각 rect 의 절반이 아니고, 이동은 먼저 닫고 그 뒤에 자르므로
 * 대상의 크기가 자르기 전에 달라진다.
 */
function dropRect(fromId, hit) {
  const copy = new Soksak(grid.toJSON(),
    { gap: grid.gap, minSize: grid.minSize, width: grid.width, height: grid.height });
  if (hit.zone === "centre") return copy.rect(hit.id);
  // T5 — 탭이 하나뿐인 카드는 카드째 이동한다.
  if (tabsOf(grid.card(fromId)).length === 1) {
    return copy.move(fromId, hit.id, hit.zone) ? copy.rect(fromId) : undefined;
  }
  const born = copy.splitToward(hit.id, hit.zone, {});
  return born === null ? undefined : copy.rect(born);
}

/**
 * 드롭 미리보기를 그리고 그린 사각형을 반환한다. 그릴 것이 없으면 null 이다.
 *
 * 배치가 거절하는 드롭에는 낳을 자리가 없으므로 그리지 않는다. 그리면 놓아도 아무
 * 일도 일어나지 않는 자리를 자리라고 표시한다.
 */
function showDrop(fromId, hit) {
  const half = hit && !isPlace(hit.id) ? dropRect(fromId, hit) : undefined;
  if (!half) { hideDrop(); return null; }
  dropPreview = { x: half.x, y: half.y, w: half.w, h: half.h };
  // 미리보기는 표면 위에 그려야 한다. 호스트가 있으면 네이티브 도형으로 그린다 —
  // 채움이 반투명이라 웹뷰로는 표면 위에 합성되지 않는다. 모양은 이 문서의 CSS 가
  // 정하고 그 계산값을 그대로 보낸다.
  if (native) {
    const css = getComputedStyle(dropEl);
    shapes.set("drop", half, {
      radius: parseFloat(css.borderTopLeftRadius) || 0,
      lineWidth: parseFloat(css.borderTopWidth) || 0,
      fill: css.backgroundColor,
      line: css.borderTopColor,
    });
    dropShown = true;
    return half;
  }
  dropEl.hidden = false;
  dropEl.style.left = `${half.x}px`; dropEl.style.top = `${half.y}px`;
  dropEl.style.width = `${half.w}px`; dropEl.style.height = `${half.h}px`;
  return half;
}

/** 미리보기를 지운다. 호스트가 그리고 있으면 그 도형도 없앤다. */
function hideDrop() {
  dropPreview = null;
  if (dropShown) {
    shapes.clear("drop");
    dropShown = false;
  }
  dropEl.hidden = true;
}

/**
 * T4 와 T5 가 배치 연산을 결정한다.
 *   출발 카드의 탭이 1개  → 카드를 이동한다. 빈 카드가 남지 않는다   move()
 *   2개 이상             → 카드는 유지하고 탭만 이동한다            splitToward()
 * 첫 번째 경우 때문에 move 가 close + split 조합이 아니라 하나의 연산이어야 한다.
 */
function dropTab(fromId, tabId, hit) {
  const from = grid.card(fromId);
  const target = grid.card(hit.id);
  if (!from || !target || isPlace(hit.id)) return settle();
  const moving = tabsOf(from).find((t) => t.id === tabId);
  if (!moving) return settle();

  if (hit.zone === "centre") {                                  // T3
    if (target.id === fromId) { from.data.activeId = tabId; return settle(); }
    from.data.tabs = tabsOf(from).filter((t) => t.id !== tabId);
    target.data.tabs.push(moving);
    target.data.activeId = tabId;
    focusedId = target.id;
    if (tabsOf(from).length === 0 && grid.canClose(fromId)) grid.close(fromId);
    else if (!tabsOf(from).some((t) => t.id === from.data.activeId)) from.data.activeId = tabsOf(from)[0]?.id ?? null;
    return settle();
  }

  if (tabsOf(from).length === 1) {                               // T5 — 남길 것이 없다
    if (fromId === hit.id) return settle();
    grid.move(fromId, hit.id, hit.zone);
    focusedId = fromId;
    return settle();
  }

  from.data.tabs = tabsOf(from).filter((t) => t.id !== tabId);   // T4 — 자리는 남고 탭만
  if (!tabsOf(from).some((t) => t.id === from.data.activeId)) from.data.activeId = tabsOf(from)[0].id;
  const born = grid.splitToward(hit.id, hit.zone,
    { data: { tabs: [moving], activeId: moving.id } });
  if (born === null) {                                           // 자리가 없으면 되돌린다
    from.data.tabs.push(moving);
    from.data.activeId = moving.id;
  } else {
    focusedId = born;
  }
  settle();
}

/* ── 레일. 카드이므로 이동에 move() 를 사용한다 ───────────────────────── */

/**
 * 레일은 판을 가로지르는 카드다.
 *
 * 카드 하나를 분할해서 만들 수 없다. 분할하면 그 카드의 행 범위만 차지한다. 어떤
 * 카드도 걸치지 않는 경계에 열로 삽입하고, 이동은 그 열을 빼서 다른 경계에 넣는다.
 * 닫고 다시 여는 것이 아니므로 다른 카드의 행 경계가 움직이지 않는다.
 */
function standRail(kind) {
  const id = railId(kind);
  const has = !!grid.card(id);
  // 레일은 포커스한 카드 옆에 표시한다. 자기 플러그인 종류가 포커스를 잃으면
  // 닫는다. 그 종류의 레일을 연결하지 않았으면 아무 레일도 표시하지 않는다.
  if (!linkedSet("rail", kind) || value("rail") === "off" || focusedPlugin() !== kind) {
    if (has) {
      railWidth[kind] = grid.card(id).width ?? railWidth[kind];
      dismiss(id);
    }
    return;
  }
  if (!has) {
    const line = railTarget(id, kind);
    if (line === null) return;
    grid.insertAt("x", line, { id, data: null, size: railWidth[kind] });
    grid.setFixed(id, true);
    return;
  }
  // 표시 중에 사용자가 드래그로 바꾼 폭을 보관한다. 닫을 때만 읽으면 그 사이의
  // 변경을 놓친다.
  railWidth[kind] = grid.card(id).width ?? railWidth[kind];
  if (value("rail") !== "flow") return;                  // PIN — 자리를 지킨다
  const line = railTarget(id, kind);
  if (line !== null) grid.moveTo(id, "x", line);
}

/**
 * 레일을 배치할 경계를 반환한다.
 *
 * 레일이 차지한 열은 다른 카드의 위치를 190px 이동시킨다. 그 위치를 기준으로 고르면
 * 결과가 레일 자신에 의존하므로, `standings` 에 레일을 제외하도록 요청해 레일이 없는
 * 배치에서 측정한다.
 */
function railTarget(id, kind) {
  // 레일 자신의 경계도 후보에 포함한다. 이미 올바른 자리면 그 자리를 반환하고
  // moveTo 는 제자리 이동을 성공으로 처리한다.
  //
  // 판의 왼쪽 테두리는 어떤 카드도 가로지르지 않으므로 언제나 후보이고, 그 자리는
  // 0 이다. 그래서 후보가 없는 경우도, 기준 카드의 왼쪽에 후보가 없는 경우도 없다.
  const stands = grid.standings("x", id);

  // 자기 종류를 표시하는 카드 옆에 배치한다. 포커스가 그 종류면 그 카드, 아니면 그
  // 종류를 가진 가장 왼쪽 카드를 기준으로 한다. 없으면 배치하지 않는다.
  const beside = focusedPlugin() === kind
    ? grid.card(focusedId)
    : grid.cards
        .filter((c) => !isPlace(c.id) && activeTab(c)?.plugin === kind)
        .sort((a, b) => grid.rect(a.id).x - grid.rect(b.id).x)[0];
  if (!beside) return null;
  const want = grid.rect(beside.id).x;

  // P3 — 기준 카드의 왼쪽에 배치한다. 바로 왼쪽에 자리가 없으면 더 왼쪽으로 이동한다.
  // 오른쪽으로는 이동하지 않는다.
  const onLeft = stands.filter((k) => grid.boundaryPos("x", k) <= want + 0.5);
  return onLeft.reduce((a, k) => (grid.boundaryPos("x", k) > grid.boundaryPos("x", a) ? k : a));
}

/**
 * 고정 자리를 제거한다.
 *
 * `fixed` 는 레이아웃이 그 카드를 이동하거나 닫지 않는다는 뜻이므로 제거 전에 해제한다.
 * `canClose` 는 `fixed` 카드에 항상 false 를 반환한다. 레일과 좌·우가 같은 함수를 쓴다.
 */
function dismiss(id) {
  if (!grid.card(id)) return;
  grid.setFixed(id, false);
  if (!grid.close(id)) { grid.setFixed(id, true); return; }   // 치우지 못했으면 역할도 그대로
  // 카드를 닫으면 그 카드가 참조하던 선을 아무도 참조하지 않는다. 라이브러리는 그런
  // 선을 남기고 제거 시점을 호스트에 맡긴다. 남겨 두면 확장된 카드가 그 선을 가로질러
  // `standings` 가 후보로 반환하지 않고, 레일이 다시 열릴 때 새 선이 추가되어 같은
  // 자리에 선이 누적된다.
  grid.tidy();
}

/**
 * 판의 끝에 위치하는 사이드바를 추가하거나 제거한다. 좌·우가 같은 동작이므로 같은
 * 함수를 쓴다.
 *
 * `splitToward` 가 아니라 `insertAt` 을 사용한다. 분할하면 분할된 카드의 행 범위를
 * 상속해 한 행만 차지하지만, 사이드바는 판을 가로질러야 한다.
 */
function standEdge(id, on, side) {
  const has = !!grid.card(id);
  if (has) edgeWidth[id] = grid.card(id).width ?? edgeWidth[id];
  const size = edgeWidth[id];
  if (on && !has) {
    const line = side === "left" ? 0 : grid.lines("x").length - 1;
    if (grid.canInsertAt("x", line)) {
      grid.insertAt("x", line, { id, data: null, size });
      grid.setFixed(id, true);
    }
  } else if (!on && has) {
    dismiss(id);
  }
}

/* ── 렌더링 ───────────────────────────────────────────────────────────── */

function settle() {
  if (!grid) return;
  closePicker();
  // 자리가 켜져 있고 그 자리에 세트가 걸려 있을 때만 선다. 걸지 않은 사이드바는
  // 표시할 것이 없다.
  standEdge("left", value("left") && !!standingSet("left"), "left");
  standEdge("right", value("right") && !!standingSet("right"), "right");
  for (const p of plugins()) standRail(p.id);
  if (!grid.card(focusedId)) focusedId = grid.cards.find((c) => !isPlace(c.id))?.id ?? null;
  view.render();
  syncBackgroundSessions();
}

/* 진행 중인 scrollend 대기. 다음 요청이 이전 대기를 취소한다. */
const landing = new WeakMap();

// A card focus can replace the native surface at the same position. The native
// input owner must receive focus after that presentation, not before it.
let pendingSurfaceFocus = null;

export function requestSurfaceFocus(surfaceId) {
  pendingSurfaceFocus = surfaceId;
}

/** 명령이 실패해 렌더가 없으면 대기 중인 표면 포커스를 지운다. */
export function cancelSurfaceFocus(surfaceId) {
  if (pendingSurfaceFocus === surfaceId) pendingSurfaceFocus = null;
}

export function takeSurfaceFocus() {
  const surfaceId = pendingSurfaceFocus;
  pendingSurfaceFocus = null;
  return surfaceId;
}

// 영속 터미널 actor는 네이티브 이미지 표면이 아니라 창 사이드카가 소유한다.
// 따라서 숨겨진 탭은 WebView나 이미지 영역을 만들지 않고 PTY를 유지한다.
const backgroundSessions = new Map();

function syncBackgroundSessions() {
  if (!native || !grid) return;
  const tabs = new Map();
  for (const card of grid.cards) for (const tab of tabsOf(card)) tabs.set(tab.id, tab);
  for (const tab of tabs.values()) {
    const descriptor = plugin(tab.plugin).background;
    if (!descriptor || tabs.get(tab.id) !== tab) continue;
    const owner = grid.cards.find((card) => tabsOf(card).some((item) => item.id === tab.id));
    if (owner?.data?.activeId === tab.id || backgroundSessions.has(tab.id)) continue;
    const port = windowSidecar(descriptor.sidecar);
    if (!port) throw new Error(`background sidecar unavailable: ${descriptor.sidecar}`);
    const state = { stop: null };
    backgroundSessions.set(tab.id, state);
    Promise.resolve(port.on(tab.id, (body) => {
      if (body?.error || body?.body?.error) {
        const reply = body.error ? body : body.body;
        report(`background session ${tab.id}: ${reply.error}${typeof reply.reason === "string" ? `: ${reply.reason}` : ""}`);
      }
    })).then((stop) => { state.stop = stop; }, (error) => {
      report(`background session ${tab.id} listener failed: ${error.message}`);
    });
    // manifest가 연산을 명시한다. 사이드카 전송은 기존 wire 필드 `op`를 유지하며
    // 이 위치가 유일한 프로토콜 변환 지점이다.
    // background.settings 가 선언한 요청 필드에 그 플러그인 설정의 현재 값을 넣는다.
    const values = pluginSettings(tab.plugin);
    const fields = Object.fromEntries(Object.entries(descriptor.settings ?? {}).map(([field, setting]) => [field, values[setting]]));
    port.send(tab.id, { ...fields, operation: descriptor.operation }).catch((error) => {
      backgroundSessions.delete(tab.id);
      report(`background session ${tab.id} open failed: ${error.message}`);
    });
  }
  for (const [tabId, state] of backgroundSessions) {
    if (tabs.has(tabId)) continue;
    state.stop?.();
    backgroundSessions.delete(tabId);
  }
}

/**
 * 활성 탭을 탭 목록의 가운데로 스크롤한다.
 *
 * 애니메이션은 사용자가 탭을 선택했을 때만 사용한다. 배치 변경으로 가운데를
 * 다시 계산할 때는 즉시 이동한다. divider 드래그 중에는 너비가 프레임마다
 * 바뀌므로, 매번 새 애니메이션을 시작하면 목표 위치에 도달하지 못한다.
 *
 * `behavior:"smooth"` 는 브라우저가 처리하며, 창이 비활성이면 애니메이션이
 * 실행되지 않고 요청이 무시된다. 스크롤이 끝나면 scrollend 가 발생하므로, 그때
 * 도착 여부를 확인하고 미도달이면 즉시 이동시킨다.
 */
function centreTab(strip, activeId) {
  const active = strip.querySelector(".tab[data-active=true]");
  if (!active) { strip.scrollLeft = 0; return; }
  const room = strip.scrollWidth - strip.clientWidth;
  // 두 rect 의 차이로 계산한다. `offsetLeft` 는 offsetParent 기준이고 탭 목록이
  // static 이라 기준이 카드가 되어 헤더 좌우 padding 만큼 오차가 생긴다.
  const a = active.getBoundingClientRect(), box = strip.getBoundingClientRect();
  const to = room <= 0 ? 0 : Math.max(0, Math.min(
    strip.scrollLeft + (a.left + a.width / 2) - (box.left + box.width / 2), room));
  const picked = strip.dataset.centred !== String(activeId);
  strip.dataset.centred = String(activeId ?? "");
  landing.get(strip)?.abort();                        // 이전 대기 취소
  if (Math.abs(strip.scrollLeft - to) < 0.5) return;
  if (!picked) { strip.scrollLeft = to; return; }
  const wait = new AbortController();
  landing.set(strip, wait);
  strip.addEventListener("scrollend", () => {
    if (Math.abs(strip.scrollLeft - to) > 0.5) strip.scrollLeft = to;
  }, { once: true, signal: wait.signal });
  strip.scrollTo({ left: to, behavior: "smooth" });
}

/**
 * 헤더 너비를 측정해 표시 단계를 결정한다.
 *
 * 측정 전에 strip 단계로 되돌려 모든 탭을 표시한다. 접힌 상태로 측정하면 접힌
 * 너비를 얻고, 그 값으로 단계를 다시 정하면 한 번 접힌 헤더가 넓어져도 복귀하지
 * 못한다. 두 번의 쓰기 사이에는 렌더링이 일어나지 않으므로 화면에 나타나지 않는다.
 *
 * 도구 버튼은 비활성인 것부터 숨긴다. 96px 카드는 절반이 최소 너비보다 작아
 * 쪼갤 수 없고, 그래서 쪼개기 버튼은 이미 비활성이다.
 */
// PEEK    strip 단계를 유지하는 데 필요한 활성 탭 외 여유 너비
// MIN_TAB 말줄임한 활성 탭의 최소 너비. 이보다 좁으면 ham 단계로 내려간다
const PEEK = 56, MIN_TAB = 48;

function fitChrome(chrome, strip) {
  const acts = chrome.querySelector(".chrome__acts");
  if (!acts) return;
  chrome.dataset.fit = "strip";
  // 머리의 좌우 여백과 그 안의 요소 사이 간격, 그리고 ≡ 의 너비는 스타일시트가
  // 정하므로 재서 얻는다. 여기에 적으면 스타일시트와 갈리고, 갈린 만큼 헤더가
  // 접히는 너비가 어긋난다. 탭 사이의 간격을 재는 것과 같은 이유다.
  const head = getComputedStyle(chrome);
  const gap = parseFloat(head.columnGap) || 0;
  const inner = chrome.clientWidth
    - parseFloat(head.paddingLeft) - parseFloat(head.paddingRight);
  // ≡ 는 strip 단계에서 그려지지 않으므로 rect 가 아니라 선언된 너비를 읽는다.
  const ham = parseFloat(getComputedStyle(chrome.querySelector(".chrome__ham")).width);
  const all = [...acts.children];
  for (const b of all) b.hidden = false;
  const wide = acts.getBoundingClientRect().width;
  const tight = inner - wide < ham + gap;
  if (tight) for (const b of all) b.hidden = b.disabled;
  const room = inner - (tight ? acts.getBoundingClientRect().width : wide) - gap;

  const tabs = [...strip.querySelectorAll(".tab")];
  const active = strip.querySelector(".tab[data-active=true]");
  const activeW = active ? active.getBoundingClientRect().width : 0;
  // 탭 사이의 간격은 탭 목록이 갖는 값이다.
  const between = parseFloat(getComputedStyle(strip).columnGap) || 0;
  const whole = tabs.reduce((n, t) => n + t.getBoundingClientRect().width, 0)
    + Math.max(0, tabs.length - 1) * between;
  // 탭 전체가 들어가면 접지 않는다. 넘쳐도 활성 탭과 여유 너비가 있으면 strip 을 유지한다.
  chrome.dataset.fit = room >= Math.min(whole, activeW + PEEK) ? "strip"
    : room >= ham + gap + Math.min(activeW, MIN_TAB) ? "one"
    : "ham";
}

/* 렌더 완료 후에 측정한다. 너비가 갱신되기 전에 측정하면 잘못된 위치를 계산한다.
   탭 드래그 중에는 스크롤하지 않는다. 드래그 중인 탭의 좌표가 어긋난다. */
function centreTabs() {
  for (const strip of plane.querySelectorAll(".chrome__tabs")) {
    const chrome = strip.parentElement;
    const card = grid.card(strip.closest(".card")?.dataset.cardId);
    if (!card?.data) continue;
    fitChrome(chrome, strip);
    if (!tabDrag) centreTab(strip, card.data.activeId);
  }
}

/**
 * 포커스 표식을 포커스 카드의 본문 영역에 배치하되 획 두께만큼 바깥에 둔다.
 *
 * 본문에 맞추면 표식이 네이티브 표면 위에 겹쳐 표면 내용을 가린다. 획 두께만큼
 * 바깥이면 획이 표면 경계 밖에 놓여 본문을 덮지 않는다. 그 두께는 스타일시트가
 * 정하므로 재서 얻는다.
 *
 * 카드 안이 아니라 표면과 같은 층에 둔다. 표면은 CSS 스택에 참여하지 않으므로 카드
 * 안에 그린 표식은 애플리케이션에서 표면 아래에 가려진다.
 */
function markFocus() {
  const mark = document.getElementById("focusMark");
  const on = value("focusInd") === "corner";
  // 슬롯은 탭 단위이고 포커스는 카드 단위다. 포커스 카드의 활성 탭이 그 카드의
  // 슬롯이다.
  const card = on ? grid.card(focusedId) : null;
  const shown = card ? activeTab(card) : null;
  const slot = shown
    ? plane.querySelector(`[data-native-surface-id="${shown.id}"][data-native-surface]`)
    : null;
  if (!slot) { mark.hidden = true; return; }
  const host = plane.getBoundingClientRect();
  const r = slot.getBoundingClientRect();
  // 표식은 획 두께만큼 바깥에 선다. 그 두께는 스타일시트가 정하므로 재서 얻는다.
  const out = parseFloat(getComputedStyle(mark).getPropertyValue("--t"));
  mark.style.left = `${r.left - host.left - out}px`;
  mark.style.top = `${r.top - host.top - out}px`;
  mark.style.width = `${r.width + out * 2}px`;
  mark.style.height = `${r.height + out * 2}px`;
  mark.hidden = false;
}

/* 마지막으로 그린 레일 외곽선. 검증기가 읽는다. */
let railShape = { shape: { path: "", loops: [], corners: 0, sharp: 0 }, rects: [] };

/** 마지막으로 그린 레일 외곽선과 그 대상 사각형. */
export const railOutline = () => railShape;

function drawRail() {
  const pad = grid.gap / 2;
  // 포커스 카드와 묶는 대상은 그 카드의 종류를 담당하는 레일뿐이다. 레일이 없으면
  // 외곽선을 그리지 않는다. `filter(Boolean)` 만 두면 포커스 카드 하나만 감싼
  // 외곽선을 레일 외곽선으로 그리게 된다.
  // 격자는 준비 중인 다음 배치를 이미 담을 수 있다. 카드 요소는 그린 배치에 있으므로
  // 외곽선도 그린 사각형으로 그려야 카드와 같은 자리에 선다.
  const kind = focusedPlugin();
  const rail = kind ? view.painted(railId(kind)) : null;
  const focused = view.painted(focusedId);
  // 변 없이 그려진 카드는 감쌀 것이 없다. 획은 카드에서 통로의 절반만큼 떨어져
  // 지나므로, 두께 없는 카드를 감싸면 그 획이 이웃 카드의 안쪽을 가로지른다.
  const drawable = (r) => r !== undefined && r.w > 0 && r.h > 0;
  const rects = drawable(rail) && drawable(focused) ? [rail, focused] : [];
  // 획은 카드에서 pad 만큼 떨어진 경로를 그린다. 카드 모서리와 동심이려면 반경도
  // 그만큼 커야 하고, 그 값은 방향과 무관하게 하나다. 각진 카드의 동심 외곽선은
  // 각지다. pad 를 더하면 반경이 0 보다 커져 모서리가 깎이고, 그 경사 때문에 가로
  // 변의 두 끝이 서로 다른 줄에 놓인다.
  const corner = cardRadius();
  const shape = outline(rects, { pad, radius: corner === 0 ? 0 : corner + pad });
  // viewBox 를 두면 판이 커질 때 요소가 먼저 늘어나면서 이전 경로가 함께 늘어나, 레일이 카드보다
  // 먼저 움직이는 것으로 보인다. 좌표계를 CSS 픽셀로 두면 다시 그릴 때까지 카드처럼 제자리에 있다.
  railPath.setAttribute("d", shape.path);
  return { shape, rects };
}


/* 렌더 완료 수신자. 검증과 보고가 여기에 연결된다. */
let listener = null;

/** 판을 다시 그릴 때마다 호출할 함수를 등록한다. */
export function onRender(fn) {
  listener = fn;
}

/* 배치를 바꾸기로 했을 때의 수신자. 그리기 전에 호출된다. */
let layouter = null;

/**
 * 배치를 렌더링하기 전에 호출할 함수를 등록한다.
 *
 * 판 위에는 CSS 가 적용되지 않는 OS 뷰가 있고 별도 경로로 배치된다. 그 경로가 더
 * 느리므로 먼저 처리한다. 받은 사각형으로 OS 뷰를 옮긴 뒤 draw 를 호출하면 둘이 같은
 * 프레임에 반영된다. 등록하지 않으면 판이 즉시 렌더링한다.
 */
export function onLayout(fn) {
  layouter = fn;
}

/**
 * 이 판이 앉힐 표면: 카드 id 마다 그 카드가 보여줄 탭의 id 와 흐림 여부.
 *
 * 표면의 정체는 탭이므로, 카드가 보여주는 탭이 바뀌면 같은 자리에 다른 표면이 앉는다.
 * 아직 그리기 전의 DOM 은 이전 탭을 담고 있고, 그것만 읽으면 지난 표면을 새 배치에
 * 앉히라고 호스트에 알리게 된다. 흐림도 같은 이유로 여기서 전달한다. 포커스는 그리기
 * 전에 이미 이동했으므로, DOM 에서 읽으면 지난 포커스의 흐림을 게시한다.
 */
function seats() {
  const out = new Map();
  for (const card of grid.cards) {
    if (isPlace(card.id)) continue;
    out.set(card.id, { id: activeTab(card).id, dim: dimmed(card.id) });
  }
  return out;
}

/** 판을 처음부터 다시 만든다. */
export function build(kept = fresh()) {
  view?.destroy();
  named = kept.named;
  railWidth = { ...kept.railWidth };
  edgeWidth = { ...kept.edgeWidth };
  const half = halfGap();
  grid = new Soksak(kept.state, { gap: half * 2 });
  focusedId = kept.focusedId;
  forgetUnknown();
  view = new SoksakView(plane, grid, {
    createCard, updateCard,
    // 판은 stage 안쪽으로 이 값만큼 들어와 있다. 호스트만 아는 값이므로 뷰에 전달해야
    // 판 가장자리에 닿는 선이 stage 경계까지 이어진다.
    bleed: stagePad(),
    commit: (made, draw) => layouter ? layouter(made, draw, seats()) : draw(),
    // 판의 렌더는 뷰가 그리는 것과 이 문서가 그리는 것으로 이루어진다. onChange 는
    // 뷰가 그린 직후에 발생하므로, 나머지를 여기서 그리고 그 뒤에 수신자를 호출한다.
    onChange: (reason) => {
      // 경계선의 잡는 영역은 뷰가 만든다. 이름은 여기서 붙인다.
      for (const divider of plane.querySelectorAll(".sp-divider:not([data-expose])")) {
        divider.dataset.expose = "core.divider";
      }
      markFocus();
      // 보이게 된 탭의 알림을 지운다.
      clearVisibleNotices();
      centreTabs();
      railShape = drawRail();
      // 탭이 카드를 옮기거나 카드 배율이 바뀌면 표면의 실제 배율이 바뀐다.
      notifyTextSize();
      listener?.(reason);
    },
  });
  settle();
}

/** 알림이 있는 탭과, 그런 탭을 가진 카드의 탭 목록 버튼에 점과 도움말을 둔다. */
function drawNotices(chrome, tabs) {
  for (const b of chrome.querySelectorAll(".chrome__tabs .tab[data-tab-id]")) {
    const notice = tabNotice(b.dataset.tabId);
    if (notice) {
      b.dataset.notice = "true";
      b.title = notice;
    } else if (b.dataset.notice) {
      delete b.dataset.notice;
      b.removeAttribute("title");
    }
  }
  const ham = chrome.querySelector(".chrome__ham");
  if (!ham) return;
  const notices = tabs.map((t) => tabNotice(t.id)).filter(Boolean);
  if (notices.length) ham.dataset.notice = "true";
  else delete ham.dataset.notice;
  ham.title = notices.length ? notices.join("\n") : "탭 목록";
}

// 탭이 보인다는 것은 포커스된 카드의 활성 탭이라는 뜻이다. 그 탭에 온 알림은 두지 않는다.
setVisibleTab((id) => {
  const card = grid?.card(focusedId);
  return Boolean(card?.data) && activeTab(card)?.id === id;
});

// 표면이 탭 제목이나 알림을 알리면 탭 이름과 점만 다시 쓴다. 레이아웃은 바뀌지 않으므로 다시 그리거나 저장하지 않는다.
onTabReports(() => {
  for (const el of document.querySelectorAll(".card[data-card-id]")) {
    const card = grid?.card(el.dataset.cardId);
    const chrome = el.querySelector(".chrome");
    if (!card?.data || !chrome) continue;
    for (const name of chrome.querySelectorAll(".tab[data-tab-id] .tab__name")) {
      const t = tabsOf(card).find((item) => item.id === name.parentElement.dataset.tabId);
      if (t) name.textContent = tabName(t);
    }
    drawNotices(chrome, tabsOf(card));
  }
});

/** 통로 값을 판과 뷰에 적용한다. */
export function setGap(half) {
  if (!grid) return;
  grid.gap = half * 2;
  view.bleed = stagePad();
  // 통로는 stage 의 안쪽 여백이기도 하므로 통로가 바뀌면 판의 크기도 바뀐다. 옵저버를
  // 기다리면 그 사이의 렌더가 이전 크기로 그려지고 표면에도 그 값이 전달된다.
  grid.resize(plane.clientWidth, plane.clientHeight);
}

/**
 * 현재 판의 상태를 한 벌로 반환한다. 스페이스가 이 값을 보관한다.
 *
 * 배치, 포커스, 닫힌 레일의 복원 폭. 셋 다 스페이스의 값이고 판의 값이 아니다.
 * 판은 한 번에 스페이스 하나를 그린다.
 */
export const capture = () => ({
  state: grid.toJSON(),
  focusedId,
  railWidth: { ...railWidth },
  edgeWidth: { ...edgeWidth },
  named,
});

/** 보관해 둔 상태 한 벌을 판에 적용한다. */
export function adopt(kept) {
  if (!grid) return build(kept);
  grid.replace(kept.state);
  focusedId = kept.focusedId;
  railWidth = { ...kept.railWidth };
  edgeWidth = { ...kept.edgeWidth };
  named = kept.named;
  forgetUnknown();
  settle();
}

/** 빈 스페이스 상태를 반환한다. 새 스페이스가 이 값으로 시작한다. */
export const fresh = () => ({
  state: initial(),
  focusedId: environment().workspace.focus,
  railWidth: freshRailWidth(),
  edgeWidth: { left: 190, right: 210 },
  named: 0,
});

export function clear() {
  view?.destroy();
  view = null;
  grid = null;
  railPath.setAttribute("d", "");
  document.getElementById("focusMark").hidden = true;
}

/* ── 명령이 부르는 연산 ────────────────────────────────────────────────────
   UI 요소는 명령을 실행하고, 명령은 아래 연산을 부른다. 잘못된 대상은 예외로 알린다. */

/** 판의 일반 카드. 없거나 자리 카드이면 예외를 던진다. */
function paneCard(id) {
  const card = grid?.card(id);
  if (!card || isPlace(id)) throw new Error(`no card ${id}`);
  return card;
}

/** 탭을 가진 카드. 없으면 예외를 던진다. */
function cardOfTab(tabId) {
  const card = grid?.cards.find((c) => tabsOf(c).some((t) => t.id === tabId));
  if (!card) throw new Error(`no tab ${tabId}`);
  return card;
}

function knownPlugin(id) {
  if (!plugins().some((p) => p.id === id)) throw new Error(`unknown plugin ${id}`);
}

/** 카드의 요소. 도구 버튼과 탭 목록 버튼이 그 안에 있다. */
const cardElement = (id) => plane.querySelector(`.card[data-card-id="${CSS.escape(id)}"]`);

export function focusCard(id) {
  paneCard(id);
  focusedId = id;
  settle();
}

/** 카드의 추가·분할 메뉴를 연다. 같은 메뉴가 열려 있으면 닫는다. */
export function openCardMenu(id, menu) {
  paneCard(id);
  const what = DO_OF[menu];
  if (!what) throw new Error(`unknown menu ${menu}`);
  const anchor = cardElement(id)?.querySelector(`.chrome__act[data-do="${what}"]`);
  if (!anchor) throw new Error(`card ${id} has no ${menu} button`);
  if (anchor.disabled) throw new Error(`card ${id} cannot ${menu}`);
  if (picker?.anchor === anchor) { closePicker(); return; }
  focusedId = id;
  settle();
  openPicker(anchor, what, id);
}

/** 카드의 탭 목록을 연다. 열려 있으면 닫는다. */
export function openCardTabs(id) {
  paneCard(id);
  const anchor = cardElement(id)?.querySelector(".chrome__ham");
  if (!anchor) throw new Error(`card ${id} has no tab list button`);
  if (picker?.anchor === anchor) { closePicker(); return; }
  openTabList(anchor, id);
}

export function addTabTo(id, kind) {
  paneCard(id);
  knownPlugin(kind);
  return addTab(id, kind);
}

export function splitCard(id, axis, kind) {
  paneCard(id);
  knownPlugin(kind);
  if (axis !== "x" && axis !== "y") throw new Error(`unknown axis ${axis}`);
  const made = splitWith(id, axis, kind);
  if (!made) throw new Error(`card ${id} cannot split on ${axis}`);
  return made;
}

export function closeCard(id) {
  paneCard(id);
  if (!grid.canClose(id)) throw new Error(`card ${id} cannot close`);
  grid.close(id);
  if (!grid.card(focusedId)) focusedId = grid.cards.find((c) => !isPlace(c.id))?.id ?? null;
  settle();
}

export function selectTab(tabId) {
  const card = cardOfTab(tabId);
  card.data.activeId = tabId;
  focusedId = card.id;
  settle();
}

export function closeTabById(tabId) {
  closeTab(cardOfTab(tabId).id, tabId);
}

const ZONES = ["centre", "left", "right", "top", "bottom"];

/** 탭을 카드의 가운데나 변으로 옮긴다. 드래그를 놓은 결과와 같다. */
export function moveTab(tabId, cardId, zone) {
  const from = cardOfTab(tabId);
  paneCard(cardId);
  if (!ZONES.includes(zone)) throw new Error(`unknown zone ${zone}`);
  const hit = { id: cardId, zone };
  if (zone !== "centre" && dropRect(from.id, hit) === undefined) {
    throw new Error(`tab ${tabId} cannot move to the ${zone} of ${cardId}`);
  }
  dropTab(from.id, tabId, hit);
}

/** 열린 선택 레이어의 항목 하나를 고른다. */
export function pickItem(index) {
  if (!picker) throw new Error("no menu is open");
  const key = picker.keys[index];
  if (key === undefined) throw new Error(`the menu has no item ${index}`);
  const { pick } = picker;
  closePicker();
  pick(key);
}

export { closePicker };

/** 카드 도구 버튼의 상태. 비활성, 숨김, 머리의 접힘 단계. */
export function cardActs(id) {
  const chrome = cardElement(id)?.querySelector(".chrome");
  const acts = chrome?.querySelector(".chrome__acts");
  if (!acts) return null;
  const buttons = Object.fromEntries([...acts.querySelectorAll(".chrome__act")].map((b) => [
    b.dataset.do === "close" ? "close" : MENU_OF[b.dataset.do],
    { enabled: !b.disabled, hidden: b.hidden, title: b.title },
  ]));
  return { ...buttons, fit: chrome.dataset.fit ?? "strip" };
}

/** 레일 외곽선과 포커스 표식. */
export function railState() {
  const mark = document.getElementById("focusMark");
  return {
    path: railShape.shape.path,
    focusMark: mark.hidden ? null : {
      x: parseFloat(mark.style.left), y: parseFloat(mark.style.top),
      w: parseFloat(mark.style.width), h: parseFloat(mark.style.height),
    },
  };
}

export { settle, tabsOf, activeTab, plane };
export const currentGrid = () => grid;
/** 카드의 글자 크기 배율. 값이 없으면 1 이다. */
const cardTextSize = (card) => card?.data?.textSize ?? 1;

/** 글자 크기의 현재 범위. 아직 누른 곳이 없으면 포커스된 카드다. */
export function currentTextScope() {
  return textScope() ?? { kind: "card", card: focusedId };
}

/** 표면(탭)의 실제 글자 배율. 프레임 배율과 그 탭을 담은 카드의 배율을 곱한다. 판에 없는 탭은 null 이다. */
function surfaceTextSize(surfaceId) {
  const card = grid?.cards.find((item) => tabsOf(item).some((t) => t.id === surfaceId));
  return card ? value("textSize") * cardTextSize(card) : null;
}

setSurfaceTextSize(surfaceTextSize);

/** 모든 카드의 글자 크기 배율. */
export function cardTextSizes() {
  return Object.fromEntries((grid?.cards ?? []).map((card) => [card.id, cardTextSize(card)]));
}

/**
 * 현재 범위의 글자 크기를 direction 으로 옮긴다. 1 은 크게, -1 은 작게, 0 은 기본이다.
 * 프레임 배율은 공통 설정이고, 카드 배율은 카드의 레이아웃 데이터에 저장된다.
 */
export async function changeTextSize(direction) {
  const scope = currentTextScope();
  if (scope.kind === "frame") {
    await setSetting({ textSize: nextTextSize(value("textSize"), direction) }, "common");
    return;
  }
  const card = grid?.card(scope.card);
  if (!card) throw new Error(`text size card ${scope.card} is not in the layout`);
  grid.setData(card.id, { ...(card.data ?? {}), textSize: nextTextSize(cardTextSize(card), direction) });
  settle();
}

/** 포커스된 카드의 id. */
export const focused = () => focusedId;
