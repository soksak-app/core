// 판 하나. 카드, 탭, 드래그, 레일, 선택 레이어, 렌더링을 담당한다.
//
// 표면의 위치를 카드 안 슬롯 요소에 기록하고, 그 위에 DOM 을 그릴 때 표면을 숨기도록
// 요청한다. 표면을 측정하고 보고하는 방법은 알지 않는다.
//
// 검증의 존재를 알지 않는다. 렌더링 완료만 통지하고 이후 처리는 문서가 정한다.
import { Soksak, SoksakView, outline } from "/dist/index.js";
import { cardRadius, halfGap, linkedSet, value } from "./settings.js";
import { isPlace, plugin, plugins, railId, railKind, section } from "./plugins/registry.js";
import { standIn } from "./compositor.js";
import { native, onSurfaceInput, overlay, shapes, surfaces as host } from "./host.js";
import { issueId } from "./ids.js";

const NEEDS = ["cards", "card", "insertAt", "moveTo", "standings", "moveBoundary", "zoneAt", "splitToward"];
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

const HEADER = 32, FOOTER = 22;

/* A host may place real native surfaces instead of the simulated ones.
   host.kinds lists the plugin kinds the application draws natively, and the
   simulator skips its own surface for those. host.place
   receives every commit record so the host places its views on the same frames.
   With no host both are absent and the page simulates every surface. */

/* 포커스를 잃은 표면의 흐림 여부. 표면은 카드마다 하나이므로 카드 단위로 판정한다. */
const dimmed = (cardId) =>
  value("dim") && cardId !== focusedId;

/* 표면은 네이티브 뷰이므로 그 위의 클릭이 이 문서에 도달하지 않는다. 호스트가 표면
   id 를 보고하면 해당 슬롯 요소에서 pointerdown 을 발생시킨다. 포커스 이동과 레이어
   닫기를 이미 pointerdown 을 수신하는 쪽이 처리한다. */
const pressSurface = (cardId) => {
  const slot = document.querySelector(
    `[data-native-surface-id="${cardId}"][data-native-surface]`);
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

/** 제목 번호와 id 번호를 일치시킨다. 다르면 화면과 로그의 탭 식별자가 어긋난다. */
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
  return { name: set.title, sections: set.sections.map((id) => section(id).name) };
}

function initial() {
  const cards = [
    { id: "left", c0: 0, c1: 1, r0: 0, r1: 2, width: 190, fixed: true },
    { id: "terminal", c0: 1, c1: 2, r0: 0, r1: 1,
      data: { tabs: [tab("terminal", ">_ 셸"), tab("terminal", ">_ 빌드")], activeId: null } },
    { id: "browser", c0: 1, c1: 2, r0: 1, r1: 2,
      data: { tabs: [tab("browser", "www 문서")], activeId: null } },
    { id: "right", c0: 2, c1: 3, r0: 0, r1: 2, width: 210, fixed: true },
  ];
  for (const c of cards) if (c.data) c.data.activeId = c.data.tabs[0].id;
  return { xs: [0, 1 / 3, 2 / 3, 1], ys: [0, 0.52, 1], cards };
}


/* ── 카드 ─────────────────────────────────────────────────────────────── */

function createCard(card) {
  const el = document.createElement("article");
  el.className = "card";
  el.innerHTML = isPlace(card.id)
    ? '<header class="chrome"></header><div class="set"></div><footer class="status"></footer>'
    : '<header class="chrome"></header><div class="slot"></div><footer class="status"></footer>';
  // 카드 객체를 클로저에 담지 않고 요소의 data-card-id 를 읽는다. 배치가 바뀌면
  // 요소가 다른 카드에 재사용되므로 담아 둔 참조는 이전 id 를 반환한다.
  el.addEventListener("pointerdown", (e) => {
    const id = el.dataset.cardId;
    if (!id || isPlace(id) || e.target.closest(".tab__x, .chrome__act")) return;
    if (focusedId !== id) { focusedId = id; settle(); }
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
  el.dataset.role = card.fixed ? "fixed" : "pane";
  el.dataset.focused = String(card.id === focusedId);
  const chrome = el.querySelector(".chrome");
  const status = el.querySelector(".status");

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
  const key = tabs.map((t) => `${t.id}\u0000${t.title}`).join("\u0001");
  let ham = chrome.querySelector(".chrome__ham");
  if (!ham) {
    ham = document.createElement("button");
    ham.className = "chrome__ham";
    ham.type = "button";
    ham.title = "탭 목록";
    ham.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true">' +
      '<path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11"/></svg>';
    ham.addEventListener("click", () => {
      if (picker?.anchor === ham) { closePicker(); return; }
      openTabList(ham, el.dataset.cardId);
    });
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
      b.dataset.tabId = t.id;
      b.draggable = false;
      // 제목은 `textContent` 로 설정한다. 사용자 입력을 마크업으로 해석하지 않는다.
      b.innerHTML = '<span class="tab__name"></span>' +
        '<button class="tab__x" title="닫기">&#10005;</button>';
      b.querySelector(".tab__name").textContent = t.title;
      b.addEventListener("pointerdown", (e) => {
        if (e.target.closest(".tab__x")) return;
        const own = grid.card(el.dataset.cardId);
        if (!own) return;
        own.data.activeId = t.id;
        focusedId = own.id;
        beginTabDrag(e, own.id, t.id);
      });
      b.querySelector(".tab__x").addEventListener("click", () => closeTab(el.dataset.cardId, t.id));
      strip.appendChild(b);
    }
  }
  for (const b of strip.querySelectorAll(".tab")) {
    b.dataset.active = String(b.dataset.tabId === card.data.activeId);
  }

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
      b.dataset.title = title;
      b.title = title;
      b.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true">${svg}</svg>`;
      b.addEventListener("click", () => {
        const own = grid.card(el.dataset.cardId);
        if (!own) return;
        if (what === "close") {
          grid.close(own.id);
          if (!grid.card(focusedId)) focusedId = grid.cards.find((c) => !isPlace(c.id))?.id ?? null;
          settle();
          return;
        }
        // The button toggles: pressing the one that opened the layer closes it.
        if (picker?.anchor === b) { closePicker(); return; }
        // 나머지 3개는 탭을 생성한다. + 는 이 카드에, 분할은 새 카드에 생성한다.
        // 여기서는 선택 레이어만 표시하고 생성하지 않는다. 미리 생성하면 취소 시
        // 제거해야 한다.
        //
        // 분할은 활성 탭을 이동시키지 않는다. 탭 이동은 T4(변에 드롭)가 담당한다.
        // 두 방식이 겹치면 탭 개수에 따라 같은 버튼의 동작이 달라진다.
        focusedId = own.id;
        settle();
        openPicker(b, what, own.id);
      });
      acts.appendChild(b);
    }
    chrome.appendChild(acts);
  }
  for (const b of acts.querySelectorAll(".chrome__act")) {
    const what = b.dataset.do;
    const off = what === "close" ? !grid.canClose(card.id)
      : what === "add" ? false : !grid.canSplit(card.id, what);
    if (b.disabled !== off) b.disabled = off;
    const title = !off ? b.dataset.title
      : what === "close"
        ? (card.fixed ? "고정된 카드는 자기 스위치로 닫는다"
                      : "닫을 수 없다 — 어느 이웃도 이 자리를 빈틈없이 못 메운다")
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
  slot.dataset.nativeVisible = "true";
  slot.dataset.nativePlugin = shown.plugin;
  slot.dataset.nativeTitle = shown.title;
  slot.dataset.nativeDim = String(dimmed(card.id));
  setText(status, `열 ${card.c0}–${card.c1} · 행 ${card.r0}–${card.r1} · 탭 ${tabs.length}`);
}

/* ── T5 — 마지막 탭이 이동하면 카드를 닫는다 ─────────────────────────── */

function closeTab(cardId, tabId) {
  const card = grid.card(cardId);
  if (!card) return;
  card.data.tabs = tabsOf(card).filter((t) => t.id !== tabId);
  if (card.data.tabs.length === 0) {
    if (grid.canClose(cardId)) grid.close(cardId);
    else card.data.tabs = [tab(focusedPlugin() ?? "terminal", "빈 탭")];
  }
  if (!tabsOf(card).some((t) => t.id === card.data?.activeId)) {
    if (card.data) card.data.activeId = tabsOf(card)[0]?.id ?? null;
  }
  if (!grid.card(focusedId)) focusedId = grid.cards.find((c) => !isPlace(c.id))?.id ?? null;
  settle();
}

/* ── 탭 드래그 — T3/T4/T5 ─────────────────────────────────────────────── */

let tabDrag = null;

function beginTabDrag(e, cardId, tabId) {
  e.preventDefault();
  tabDrag = { cardId, tabId, from: { x: e.clientX, y: e.clientY }, moved: false, hit: null };
  const el = e.currentTarget;
  el.setPointerCapture(e.pointerId);
  el.dataset.dragging = "true";

  const onMove = (ev) => {
    if (!tabDrag) return;
    if (Math.hypot(ev.clientX - tabDrag.from.x, ev.clientY - tabDrag.from.y) > 4) tabDrag.moved = true;
    if (!tabDrag.moved) return;
    if (!tabDrag.stood) { tabDrag.stood = true; standIn(true); }
    const host = plane.getBoundingClientRect();
    const only = tabsOf(grid.card(tabDrag.cardId)).length === 1 ? tabDrag.cardId : undefined;
    tabDrag.hit = grid.zoneAt(ev.clientX - host.left, ev.clientY - host.top,
      { headerPx: HEADER, footerPx: FOOTER, centreOnly: only });
    showDrop(tabDrag.hit);
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
    if (drag.moved && drag.hit) dropTab(drag.cardId, drag.tabId, drag.hit);
    else settle();
  };
  el.addEventListener("pointermove", onMove);
  el.addEventListener("pointerup", onUp);
  el.addEventListener("pointercancel", onUp);
}

/* ── 선택 레이어 ──────────────────────────────────────────────────────────
   레이어는 카드가 아니므로 배치에 영향을 주지 않고 Soksak 도 인식하지 않는다.
   배치가 바뀌면 레이어의 기준 위치가 무효가 되므로 settle 이 먼저 닫는다.     */

let picker = null;

const PICKER_ASK = {
  add: "새 탭에 무엇을 띄울까",
  x: "새 자리에 무엇을 띄울까",
  y: "새 자리에 무엇을 띄울까",
};

pickerEl.addEventListener("click", (e) => {
  const item = e.target.closest(".picker__item");
  if (!item || !picker) return;
  const { pick } = picker, key = item.dataset.key;
  closePicker();
  pick(key);
});

const onPickerOutside = (e) => {
  if (pickerEl.contains(e.target)) return;
  // The button that opened the layer closes it on its own click, so a press on it
  // is not an outside press. Closing here would let that click reopen the layer.
  if (picker?.anchor?.contains(e.target)) return;
  closePicker();
};
const onPickerKey = (e) => {
  if (e.key !== "Escape") return;
  e.stopPropagation();
  closePicker();
};

/** 새 탭의 플러그인 종류를 선택받는다. + 와 분할 버튼이 함께 사용한다. */
function openPicker(anchor, what, cardId) {
  openLayer(anchor, PICKER_ASK[what] ?? PICKER_ASK.add,
    plugins().map((p) => ({ key: p.id, name: p.name, mark: p.mark, svg: p.svg })),
    (k) => (what === "add" ? addTab(cardId, k) : splitWith(cardId, what, k)));
}

/** 활성화할 탭을 선택받는다. 헤더가 접혔을 때 탭 목록을 표시한다. */
function openTabList(anchor, cardId) {
  const card = grid.card(cardId);
  if (!card?.data) return;
  openLayer(anchor, `탭 ${tabsOf(card).length}개`, tabsOf(card).map((t) => ({
    key: t.id, name: t.title, mark: plugin(t.plugin).mark, svg: plugin(t.plugin).svg,
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
  for (const it of items) {
    const b = document.createElement("button");
    b.className = "picker__item";
    b.type = "button";
    b.dataset.key = it.key;
    b.dataset.active = String(!!it.active);
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
  picker = { anchor, pick, rect };
  // DOM cannot be drawn over a native view, and a webview is a native view that
  // renders DOM. A host takes this element and renders it in such a view, so the
  // surfaces underneath keep running. The element is passed whole and the host
  // needs no knowledge of its contents.
  if (native) {
    overlay.show(pickerEl, rect, (key) => { closePicker(); pick(key); });
    pickerEl.hidden = true;
  } else {
    standIn(true, rect);
  }
  document.addEventListener("pointerdown", onPickerOutside, true);
  document.addEventListener("keydown", onPickerKey, true);
  (pickerEl.querySelector('.picker__item[data-active=true]') ??
   pickerEl.querySelector(".picker__item"))?.focus();
}

function closePicker() {
  if (!picker) return;
  picker = null;
  pickerEl.hidden = true;
  document.removeEventListener("pointerdown", onPickerOutside, true);
  document.removeEventListener("keydown", onPickerKey, true);
  if (native) overlay.hide();
  else standIn(false);
}

/** + 버튼의 후속 처리. 배치를 변경하지 않고 탭만 추가한다. */
function addTab(cardId, plugin) {
  const card = grid.card(cardId);
  if (!card?.data) return;
  const t = newTab(plugin);
  card.data.tabs.push(t);
  card.data.activeId = t.id;
  focusedId = cardId;
  settle();
}

/** 쪼개기 버튼의 후속 처리. 새 카드를 만들고 선택한 종류의 탭을 그 카드에 추가한다. */
function splitWith(cardId, axis, plugin) {
  const card = grid.card(cardId);
  if (!card?.data) return;
  const t = newTab(plugin);
  // 공간이 없으면 split 이 null 을 반환한다. 원본 카드에서 제거한 탭이 없으므로
  // 복구할 상태가 없다.
  const born = grid.split(cardId, axis, { data: { tabs: [t], activeId: t.id } });
  if (born) focusedId = born;
  settle();
}

/* 미리보기가 호스트의 뷰에 있는가. 드래그 한 번 동안 그 뷰를 유지하고 위치만
   갱신한다. 매 프레임 다시 만들면 깜빡인다. */
let dropShown = false;

function showDrop(hit) {
  if (!hit || isPlace(hit.id)) return hideDrop();
  const r = grid.rect(hit.id);
  const half = { x: r.x, y: r.y, w: r.w, h: r.h };
  if (hit.zone === "left") half.w = r.w / 2;
  if (hit.zone === "right") { half.x = r.x + r.w / 2; half.w = r.w / 2; }
  if (hit.zone === "top") half.h = r.h / 2;
  if (hit.zone === "bottom") { half.y = r.y + r.h / 2; half.h = r.h / 2; }
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
    return;
  }
  dropEl.hidden = false;
  dropEl.style.left = `${half.x}px`; dropEl.style.top = `${half.y}px`;
  dropEl.style.width = `${half.w}px`; dropEl.style.height = `${half.h}px`;
}

/** 미리보기를 지운다. 호스트가 그리고 있으면 그 도형도 없앤다. */
function hideDrop() {
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
  const stands = grid.standings("x", id);
  if (!stands.length) return null;

  // 자기 종류를 표시하는 카드 옆에 배치한다. 포커스가 그 종류면 그 카드, 아니면 그
  // 종류를 가진 가장 왼쪽 카드를 기준으로 한다. 없으면 배치하지 않는다.
  const beside = focusedPlugin() === kind
    ? grid.card(focusedId)
    : grid.cards
        .filter((c) => !isPlace(c.id) && activeTab(c)?.plugin === kind)
        .sort((a, b) => grid.rect(a.id).x - grid.rect(b.id).x)[0];
  if (!beside) return null;
  const want = grid.rect(beside.id)?.x ?? 0;

  // P3 — 기준 카드의 왼쪽에 배치한다. 바로 왼쪽에 자리가 없으면 더 왼쪽으로 이동한다.
  // 오른쪽으로는 이동하지 않는다. 왼쪽에 자리가 없을 때만 가장 왼쪽에 배치한다.
  const onLeft = stands.filter((k) => grid.boundaryPos("x", k) <= want + 0.5);
  return onLeft.length
    ? onLeft.reduce((a, k) => (grid.boundaryPos("x", k) > grid.boundaryPos("x", a) ? k : a))
    : stands[0];
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
function standEdge(id, on, size, side) {
  const has = !!grid.card(id);
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
  closePicker();
  standEdge("left", value("left"), 190, "left");
  standEdge("right", value("right"), 210, "right");
  for (const p of plugins()) standRail(p.id);
  if (!grid.card(focusedId)) focusedId = grid.cards.find((c) => !isPlace(c.id))?.id ?? null;
  view.render();
}

/**
 * 포커스 표식을 포커스 카드의 본문 영역에 배치하되 1px 바깥에 둔다.
 *
 * 본문에 맞추면 표식이 네이티브 표면 위에 겹쳐 표면 내용을 가린다. 1px 바깥이면
 * 표면 경계에 위치해 본문을 덮지 않는다.
 *
 * 카드 안이 아니라 표면과 같은 층에 둔다. 표면은 CSS 스택에 참여하지 않으므로 카드
 * 안에 그린 표식은 애플리케이션에서 표면 아래에 가려진다.
 */
const MARK_OUT = 1;

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

/* 진행 중인 scrollend 대기. 다음 요청이 이전 대기를 취소한다. */
const landing = new WeakMap();

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
const HAM_W = 20, GAP = 4, PEEK = 56, MIN_TAB = 48;

function fitChrome(chrome, strip) {
  const acts = chrome.querySelector(".chrome__acts");
  if (!acts) return;
  chrome.dataset.fit = "strip";
  const inner = chrome.clientWidth - GAP * 2;          // .chrome 좌우 padding 제외
  const all = [...acts.children];
  for (const b of all) b.hidden = false;
  const wide = acts.getBoundingClientRect().width;
  const tight = inner - wide < HAM_W + GAP;
  if (tight) for (const b of all) b.hidden = b.disabled;
  const room = inner - (tight ? acts.getBoundingClientRect().width : wide) - GAP;

  const tabs = [...strip.querySelectorAll(".tab")];
  const active = strip.querySelector(".tab[data-active=true]");
  const activeW = active ? active.getBoundingClientRect().width : 0;
  const whole = tabs.reduce((n, t) => n + t.getBoundingClientRect().width, 0)
    + Math.max(0, tabs.length - 1) * GAP;
  // 탭 전체가 들어가면 접지 않는다. 넘쳐도 활성 탭과 여유 너비가 있으면 strip 을 유지한다.
  chrome.dataset.fit = room >= Math.min(whole, activeW + PEEK) ? "strip"
    : room >= HAM_W + GAP + Math.min(activeW, MIN_TAB) ? "one"
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

function markFocus() {
  const mark = document.getElementById("focusMark");
  const on = document.documentElement.dataset.focusInd === "corner";
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
  mark.style.left = `${r.left - host.left - MARK_OUT}px`;
  mark.style.top = `${r.top - host.top - MARK_OUT}px`;
  mark.style.width = `${r.width + MARK_OUT * 2}px`;
  mark.style.height = `${r.height + MARK_OUT * 2}px`;
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
  const kind = focusedPlugin();
  const rail = kind ? grid.rect(railId(kind)) : null;
  const focused = grid.rect(focusedId);
  const rects = rail && focused ? [rail, focused] : [];
  // 획은 카드에서 pad 만큼 떨어진 경로를 그린다. 카드 모서리와 동심이려면 반경도
  // 그만큼 커야 하고, 그 값은 방향과 무관하게 하나다. 각진 카드의 동심 외곽선은
  // 각지다. pad 를 더하면 반경이 0 보다 커져 모서리가 깎이고, 그 경사 때문에 가로
  // 변의 두 끝이 서로 다른 줄에 놓인다.
  const corner = cardRadius();
  const shape = outline(rects, { pad, radius: corner === 0 ? 0 : corner + pad });
  document.getElementById("rail").setAttribute("viewBox", `0 0 ${grid.width} ${grid.height}`);
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

/** 현재 카드들의 사각형. */
export const rects = () => grid.rects();

/** 판을 처음부터 다시 만든다. */
export function build() {
  view?.destroy();
  named = 0;
  railWidth = freshRailWidth();
  const half = halfGap();
  grid = new Soksak(initial(), { gap: half * 2 });
  focusedId = "terminal";
  view = new SoksakView(plane, grid, {
    createCard, updateCard,
    // 판은 stage 안쪽으로 이 값만큼 들어와 있다. 호스트만 아는 값이므로 뷰에 전달해야
    // 판 가장자리에 닿는 선이 stage 경계까지 이어진다.
    bleed: half,
    commit: (made, draw) => (layouter ? layouter(made, draw) : draw()),
  });
  // 판의 렌더는 뷰가 그리는 것과 이 문서가 그리는 것으로 이루어진다. 뷰의 onChange 는
  // 뷰가 그린 직후에 발화하므로, 그 시점의 판은 아직 절반만 그려져 있다. 수신자는
  // 여기서 전부 그린 뒤에 호출한다.
  const baseRender = view.render.bind(view);
  view.render = (reason) => {
    baseRender(reason);
    markFocus();
    centreTabs();
    railShape = drawRail();
    listener?.(reason);
  };
  Object.assign(window, { grid, view });   // 관측용 — build 마다 새로 걸어야 낡지 않는다
  settle();
}

/** 통로 값을 판과 뷰에 적용한다. */
export function setGap(half) {
  grid.gap = half * 2;
  view.bleed = half;
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
  named,
});

/** 보관해 둔 상태 한 벌을 판에 적용한다. */
export function adopt(kept) {
  grid.replace(kept.state);
  focusedId = kept.focusedId;
  railWidth = { ...kept.railWidth };
  named = kept.named;
  settle();
}

/** 빈 스페이스 상태를 반환한다. 새 스페이스가 이 값으로 시작한다. */
export const fresh = () => ({
  state: initial(),
  focusedId: "terminal",
  railWidth: freshRailWidth(),
  named: 0,
});

export { settle, tabsOf, plane };
export const render = () => view.render();
export const currentGrid = () => grid;
export const currentView = () => view;
