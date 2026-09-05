// 판 하나 — 카드, 탭, 드래그, 레일, 선택 레이어, 그리고 다시 그리기.
//
// 표면이 설 자리를 카드 안에 표시해 두고, 그 위에 DOM 을 그릴 때는 표면을
// 물러나게 해 달라고 말한다. 표면을 어떻게 재고 어떻게 공표하는지는 모른다.
//
// 검증이 무엇인지는 모른다. 다시 그렸다는 것만 알리고, 그 뒤에 무엇이 일어나는
// 지는 문서가 정한다.
import { Soksak, SoksakView, outline } from "/dist/index.js";
import { cardRadius, halfGap, linkedSet, value } from "./settings.js";
import { isPlace, plugin, plugins, railId, railKind, section } from "./plugins/registry.js";
import { standIn } from "./compositor.js";
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
   window.hostSurfaces.kinds lists the plugin kinds the host draws natively; the
   simulator skips its own surface for those. window.hostSurfaces.place receives
   every commit record so the host can position its views on the same frames.
   With no host, both are absent and the page simulates everything. */
const hostKinds = () => window.hostSurfaces?.kinds ?? [];

/* 포커스를 잃은 표면을 흐리게 할지. 표면은 카드 하나에 하나이므로 판단도
   카드 단위다. */
const dimmed = (cardId) =>
  value("dim") && cardId !== focusedId;

/* 표면은 네이티브라 그 위의 클릭이 이 문서에 닿지 않는다. 호스트가 알려 주면
   표면이 서 있는 자리 요소에서 pointerdown 을 낸다: 포커스도 레이어 닫기도
   이미 누름을 듣고 있는 쪽이 처리한다. 표면만의 경로를 따로 두면 누름에 반응
   하는 것이 늘 때마다 그 목록을 다시 맞춰야 한다. */
window.pressSurface = (cardId) => {
  const slot = document.querySelector(
    `[data-native-surface-id="${cardId}"][data-native-surface]`);
  if (!slot) return;
  slot.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
};


const plane = document.getElementById("plane");
const railPath = document.getElementById("railPath");
const dropEl = document.getElementById("drop");
const pickerEl = document.getElementById("picker");

// 레일이 물러나는 것은 닫는 것이므로 폭이 카드와 함께 사라진다. 사람이 드래그로
// 정한 폭은 그 사람의 결정이므로, 판이 종류별로 기억해 두었다가 다시 설 때 그
// 폭으로 세운다. 설정이 아니라 스페이스의 기억이다.
//
// 처음 폭은 자리의 것이지 종류의 것이 아니다. 등록된 종류마다 같은 값으로
// 채우므로, 플러그인이 늘어도 여기 적을 것이 없다.
const RAIL_WIDTH = 190;
const freshRailWidth = () =>
  Object.fromEntries(plugins().map((p) => [p.id, RAIL_WIDTH]));
const railWidth = freshRailWidth();

/* ── 자리 ─────────────────────────────────────────────────────────────────
   어디 서는가          무엇이 서는가
   left   첫 열, 고정폭      포커스와 무관하게 걸린 세트
   right  마지막 열, 고정폭   포커스된 플러그인에 걸린 세트
   rail   가운데 열, 고정폭   포커스된 플러그인에 걸린 세트 · 포커스를 따라 이동
   셋 다 카드다. 자리 사이에 모드 전환은 없다 — 자리가 곧 규칙이다.

   무엇이 서는지는 여기서 정하지 않는다. 사람이 섹션을 골라 세트로 묶고,
   설정에서 그 세트를 자리에 건다. 걸지 않으면 그 사이드바는 없다.        */

let grid, view, focusedId;
// 탭 제목에 붙는 번호. 식별자가 아니라 사람이 읽는 이름이므로 세어서 만든다.
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

/** 제목 번호와 id 번호를 일치시킨다. 다르면 화면과 로그의 탭 식별이 어긋난다. */
function newTab(kind) {
  const t = tab(kind, "");
  t.title = `${plugin(kind).mark} 탭 ${++named}`;
  return t;
}

/**
 * 그 자리에 선 세트와, 그 세트가 담은 섹션의 이름들.
 *
 * 걸린 것이 없으면 null 이다 — 연결하지 않으면 그 사이드바는 없다.
 */
function standingSet(place) {
  // 레일은 자기 종류의 세트를 보여준다. 포커스가 다른 종류에 가 있어도 그
  // 레일이 무엇의 레일인지는 바뀌지 않는다.
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
  // 카드 객체를 가두지 않고 엘리먼트의 data-card-id 를 읽는다. 배치가 바뀌면
  // 엘리먼트가 다른 카드를 받으므로, 가둔 참조는 옛 id 를 반환한다.
  el.addEventListener("pointerdown", (e) => {
    const id = el.dataset.cardId;
    if (!id || isPlace(id) || e.target.closest(".tab__x, .chrome__act")) return;
    if (focusedId !== id) { focusedId = id; settle(); }
  });
  return el;
}

/**
 * 바뀐 것만 고친다.
 *
 * 매 렌더마다 `chrome.innerHTML = ""` 로 다시 만들고 있었다. 판 안의 노드가
 * 87개인데 포인터 이동 한 번에 52개가 교체되었다 — 커서 밑의 엘리먼트가 매
 * 프레임 새로 태어나니 hover 와 포커스가 끊기고, 드래그 중이던 탭이 사라져
 * `pointerup` 이 오지 않는다. 탭 목록이 실제로 달라졌을 때만 다시 만든다.
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
    const name = place === "left" ? "좌측" : place === "right" ? "우측"
      : kind === "terminal" ? "터미널 레일" : kind === "browser" ? "브라우저 레일" : "레일";
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

  // 카드의 연산은 넷이다 — 탭을 더한다(T2), 세로로 쪼갠다, 가로로 쪼갠다, 닫는다.
  // 탭 ✕ 는 그 탭 하나를 닫고 마지막이면 카드가 함께 간다(T5). 카드 ✕ 는
  // 탭이 몇 개든 카드째로 닫는다 — 다른 연산이므로 둘 다 있어야 한다.
  if (!acts) {
    acts = document.createElement("span");
    acts.className = "chrome__acts";
    // 생성 버튼 3개를 앞에, 닫기를 끝에 배치한다. 닫기는 되돌릴 수 없으므로
    // 다른 버튼 사이에 두면 오클릭 위험이 크다.
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
        // 나머지 3개는 탭을 생성한다. + 는 이 카드에, 쪼개기는 새 카드에 생성한다.
        // 여기서는 레이어만 표시하고 생성하지 않는다. 미리 생성하면 취소 시 제거해야 한다.
        //
        // 쪼개기는 활성 탭을 이동시키지 않는다. 탭 이동은 T4(변에 드롭)가 담당한다.
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

  // 표면이 설 자리. 컴포지터는 판을 모르므로 필요한 것을 여기에 표시해 둔다.
  const slot = el.querySelector(".slot");
  slot.dataset.nativeSurface = "stub";
  slot.dataset.nativeSurfaceId = card.id;
  slot.dataset.nativeLayer = "10";
  slot.dataset.nativeVisible = "true";
  const shown = activeTab(card);
  slot.dataset.nativePlugin = shown.plugin;
  slot.dataset.nativeTitle = shown.title;
  slot.dataset.nativeDim = String(dimmed(card.id));
  setText(status, `열 ${card.c0}–${card.c1} · 행 ${card.r0}–${card.r1} · 탭 ${tabs.length}`);
}

/* ── T5 — 마지막 탭이 떠나면 카드가 사라진다 ─────────────────────────── */

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
    dropEl.hidden = true;
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
   레이어는 카드가 아니므로 배치에 영향을 주지 않고, Soksak 은 레이어를
   인식하지 않는다. 배치가 변경되면 레이어의 기준 위치가 무효가 되므로
   settle 이 먼저 레이어를 닫는다.                                          */

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
  // The button that opened the layer closes it on its own click, so a press on
  // it is not an outside press. Closing here would let the click reopen at once.
  if (picker?.anchor?.contains(e.target)) return;
  closePicker();
};
const onPickerKey = (e) => {
  if (e.key !== "Escape") return;
  e.stopPropagation();
  closePicker();
};

/** 새 탭의 종류를 묻는다. + 와 쪼개기가 공용으로 사용한다. */
function openPicker(anchor, what, cardId) {
  openLayer(anchor, PICKER_ASK[what] ?? PICKER_ASK.add,
    plugins().map((p) => ({ key: p.id, name: p.name, mark: p.mark, svg: p.svg })),
    (k) => (what === "add" ? addTab(cardId, k) : splitWith(cardId, what, k)));
}

/** 활성화할 탭을 묻는다. 헤더가 접혔을 때 탭 목록을 여기에 표시한다. */
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
 * 기준 버튼 아래에 배치하고 판 경계 안으로 제한한다. 판 밖은 표시할 수 없다.
 *
 * 항목 이름은 `textContent` 로 설정한다. 탭 제목은 사용자 입력이므로 마크업으로
 * 연결하면 제목이 레이어 구조를 변경할 수 있다.
 */
function openLayer(anchor, ask, items, pick, align = "right") {
  closePicker();
  pickerEl.textContent = "";
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
  // DOM cannot be drawn over a native view, but a webview is a native view that
  // draws DOM. A host that can raise one takes this element and draws it there,
  // so the surfaces underneath keep running. The element is handed over whole:
  // the host needs no knowledge of what a layer contains.
  if (window.hostOverlay) {
    window.hostOverlay.show(pickerEl, rect, (key) => { closePicker(); pick(key); });
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
  if (window.hostOverlay) window.hostOverlay.hide();
  else standIn(false);
}

/** + 버튼의 후속 처리. 배치는 변경하지 않고 탭만 추가한다. */
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
  // 복구할 것이 없다.
  const born = grid.split(cardId, axis, { data: { tabs: [t], activeId: t.id } });
  if (born) focusedId = born;
  settle();
}

function showDrop(hit) {
  if (!hit || isPlace(hit.id)) { dropEl.hidden = true; return; }
  const r = grid.rect(hit.id);
  const half = { x: r.x, y: r.y, w: r.w, h: r.h };
  if (hit.zone === "left") half.w = r.w / 2;
  if (hit.zone === "right") { half.x = r.x + r.w / 2; half.w = r.w / 2; }
  if (hit.zone === "top") half.h = r.h / 2;
  if (hit.zone === "bottom") { half.y = r.y + r.h / 2; half.h = r.h / 2; }
  dropEl.hidden = false;
  dropEl.style.left = `${half.x}px`; dropEl.style.top = `${half.y}px`;
  dropEl.style.width = `${half.w}px`; dropEl.style.height = `${half.h}px`;
}

/**
 * T4 와 T5 가 배치 연산을 가른다.
 *   출발 카드에 탭이 1개  → 카드째로 옮겨간다. 남는 것 없음      move()
 *   여러 개              → 카드는 남고 탭만 간다                splitToward()
 * move 가 close+split 조합이 아니라 한 연산이어야 하는 이유가 첫 줄이다.
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

/* ── 레일 — 카드이므로 이동도 move() 다 ───────────────────────────────── */

/**
 * 레일은 판을 가로지르는 카드다.
 *
 * 그래서 카드 하나를 쪼개서 만들 수 없다 — 그렇게 만들면 그 카드의 행만
 * 차지하는 또 하나의 판이 된다. 아무 카드도 넘지 않는 경계에 열로 끼우고,
 * 이동은 그 열을 빼서 다른 경계에 넣는 것이다. 닫고 다시 여는 것이 아니므로
 * 다른 카드의 행 경계는 움직이지 않는다.
 */
function standRail(kind) {
  const id = railId(kind);
  const has = !!grid.card(id);
  // 레일은 포커스가 잡은 것의 곁을 지킨다. 브라우저를 보는 동안 터미널 레일이
  // 남아 있으면 그것은 지금 보고 있는 것의 곁이 아니라 남겨진 자리다. 자기
  // 종류가 포커스를 잃으면 물러난다 — 그 종류의 레일을 꺼 두었다면 아무 레일도
  // 서지 않는 것이 맞다.
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
  // 서 있는 동안 사람이 끌어 바꾼 폭을 받아 둔다. 물러날 때만 읽으면 그 사이의
  // 조정을 놓친다.
  railWidth[kind] = grid.card(id).width ?? railWidth[kind];
  if (value("rail") !== "flow") return;                  // PIN — 자리를 지킨다
  const line = railTarget(id, kind);
  if (line !== null) grid.moveTo(id, "x", line);
}

/**
 * 레일이 서야 할 경계.
 *
 * 레일이 서 있는 열은 다른 카드의 위치를 190px 옮겨 놓는다. 그 위치를 기준으로
 * 고르면 답이 레일 자신에 따라 달라지므로, `standings` 에 레일을 무시하도록
 * 요청해 레일을 뺀 배치에서 잰다.
 */
function railTarget(id, kind) {
  // 레일 자신의 경계도 후보다. 이미 옳은 자리에 서 있으면 그 자리가 답이고,
  // moveTo 는 제자리 이동을 성공으로 반환한다.
  const stands = grid.standings("x", id);
  if (!stands.length) return null;

  // 자기 종류를 보여주는 카드 옆에 선다. 포커스가 그 종류면 그 카드, 아니면
  // 그 종류를 든 가장 왼쪽 카드 — 없으면 설 자리가 없다.
  const beside = focusedPlugin() === kind
    ? grid.card(focusedId)
    : grid.cards
        .filter((c) => !isPlace(c.id) && activeTab(c)?.plugin === kind)
        .sort((a, b) => grid.rect(a.id).x - grid.rect(b.id).x)[0];
  if (!beside) return null;
  const want = grid.rect(beside.id)?.x ?? 0;

  // P3 — 왼쪽에 붙는다. 바로 왼쪽에 설 수 없으면 더 왼쪽으로 물러난다.
  // 오른쪽으로는 넘어가지 않는다: 사이드바가 자기가 붙은 것의 반대편에
  // 나타나면 그건 다른 물건이다. 왼쪽에 아무 자리도 없을 때만 가장 왼쪽으로.
  const onLeft = stands.filter((k) => grid.boundaryPos("x", k) <= want + 0.5);
  return onLeft.length
    ? onLeft.reduce((a, k) => (grid.boundaryPos("x", k) > grid.boundaryPos("x", a) ? k : a))
    : stands[0];
}

/**
 * 자리를 치운다.
 *
 * `fixed` 는 레이아웃이 그 카드를 옮기거나 닫지 않는다는 뜻이므로, 호스트가
 * 직접 치우려면 먼저 그 역할을 해제한다. `canClose` 는 `fixed` 카드에 언제나
 * 거짓을 반환하므로 그것만으로는 치울 수 없다. 레일과 좌·우가 같은 함수를 쓴다.
 */
function dismiss(id) {
  if (!grid.card(id)) return;
  grid.setFixed(id, false);
  if (!grid.close(id)) { grid.setFixed(id, true); return; }   // 치우지 못했으면 역할도 그대로
  // 카드가 가면 그 카드가 읽던 선은 아무도 읽지 않는 선으로 남는다. 라이브러리는
  // 그런 선을 그대로 두고 언제 걷을지는 호스트에게 맡긴다 — 여기서는 걷는다.
  // 남겨 봐야 쓸 수 없다: 자란 카드가 그 선을 가로지르므로 `standings` 가
  // 후보로 내놓지 않고, 레일이 돌아올 때는 새 선을 끼운다. 그대로 두면 왕복할
  // 때마다 한 자리에 선이 하나씩 쌓인다.
  grid.tidy();
}

/**
 * 판의 끝에 서는 사이드바를 세우거나 치운다.
 *
 * 좌·우가 같은 일을 하므로 같은 함수를 쓴다.
 *
 * `splitToward` 가 아니라 `insertAt` 을 쓴다. 자르면 잘린 카드의 행 범위를
 * 물려받아 한 줄만 차지하는데, 사이드바는 판을 가로질러야 한다.
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

/* ── 그리고 다시 그린다 ───────────────────────────────────────────────── */

function settle() {
  closePicker();
  standEdge("left", value("left"), 190, "left");
  standEdge("right", value("right"), 210, "right");
  for (const p of plugins()) standRail(p.id);
  if (!grid.card(focusedId)) focusedId = grid.cards.find((c) => !isPlace(c.id))?.id ?? null;
  view.render();
}

/**
 * 꺽쇠를 포커스 카드의 본문 자리에 놓되, 1px 바깥에 세운다.
 *
 * 본문에 딱 맞추면 꺽쇠가 네이티브 표면 위에 얹혀 표면의 내용을 가린다. 한 픽셀
 * 물러나면 표면이 끝나는 자리에 서서 본문을 덮지 않는다.
 *
 * 카드 안이 아니라 표면과 같은 층이다: 표면은 CSS 스택에 참여하지 않으므로
 * 카드 안에 그린 표시는 실제 앱에서 표면 아래로 들어간다 — 시뮬레이터에서만
 * 보이게 두면 재현이 아니다.
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
 * 실행되지 않고 요청이 무시된다. SLIDE_MS 후 도착 여부를 확인하고 미도달이면
 * 즉시 이동시킨다.
 */
const SLIDE_MS = 350;

function centreTab(strip, activeId) {
  const active = strip.querySelector(".tab[data-active=true]");
  if (!active) { strip.scrollLeft = 0; return; }
  const room = strip.scrollWidth - strip.clientWidth;
  // 두 rect 의 차이로 계산한다. `offsetLeft` 는 offsetParent 기준인데 탭 목록이
  // static 이라 기준이 카드가 되고, 헤더 좌우 padding 만큼 오차가 생긴다.
  const a = active.getBoundingClientRect(), box = strip.getBoundingClientRect();
  const to = room <= 0 ? 0 : Math.max(0, Math.min(
    strip.scrollLeft + (a.left + a.width / 2) - (box.left + box.width / 2), room));
  const picked = strip.dataset.centred !== String(activeId);
  strip.dataset.centred = String(activeId ?? "");
  clearTimeout(Number(strip.dataset.landTimer));      // 이전 타이머 제거
  if (Math.abs(strip.scrollLeft - to) < 0.5) return;
  if (!picked) { strip.scrollLeft = to; return; }
  strip.scrollTo({ left: to, behavior: "smooth" });
  strip.dataset.landTimer = String(setTimeout(() => {
    if (Math.abs(strip.scrollLeft - to) > 0.5) strip.scrollLeft = to;
  }, SLIDE_MS));
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

/* 렌더 완료 후에 측정한다. 너비가 갱신되기 전에 재면 잘못된 위치를 계산한다.
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
  const slot = on
    ? plane.querySelector(`[data-native-surface-id="${focusedId}"][data-native-surface]`)
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

function drawRail() {
  const pad = grid.gap / 2;
  // 포커스 카드와 묶이는 것은 그 카드의 종류를 맡은 레일뿐이다. 레일이 없으면
  // 묶을 것이 없다: `filter(Boolean)` 만 두면 포커스 카드 하나를 감싼 외곽선을
  // 그려 놓고 「레일 외곽선」이라 부르게 된다.
  const kind = focusedPlugin();
  const rail = kind ? grid.rect(railId(kind)) : null;
  const focused = grid.rect(focusedId);
  const rects = rail && focused ? [rail, focused] : [];
  // 획은 카드에서 pad 만큼 떨어져 돈다. 카드 모서리와 동심이려면 그만큼 더
  // 벌어진 반경이어야 하고, 그 값은 굽이의 방향과 무관하게 하나다.
  const shape = outline(rects, { pad, radius: cardRadius() + pad });
  document.getElementById("rail").setAttribute("viewBox", `0 0 ${grid.width} ${grid.height}`);
  railPath.setAttribute("d", shape.path);
  return { shape, rects };
}


/* 다시 그렸음을 듣는 쪽. 검증과 공표가 여기 붙는다. */
let listener = null;

/** 판을 다시 그릴 때마다 부를 함수를 건다. */
export function onRender(fn) {
  listener = fn;
}

/** 처음부터 다시 세운다. */
export function build() {
  view?.destroy();
  named = 0;
  const half = halfGap();
  grid = new Soksak(initial(), { gap: half * 2 });
  focusedId = "terminal";
  view = new SoksakView(plane, grid, {
    createCard, updateCard,
    // 평면은 stage 안쪽으로 이만큼 들어와 있다. 호스트만 아는 값이므로 뷰에게
    // 말해 준다 — 그래야 평면 가장자리에 닿는 선이 벽까지 이어진다.
    bleed: half,
    onChange: () => listener?.(),
  });
  const baseRender = view.render.bind(view);
  view.render = () => { baseRender(); markFocus(); centreTabs(); };
  Object.assign(window, { grid, view });   // 관측용 — build 마다 새로 걸어야 낡지 않는다
  settle();
}

/** 통로가 바뀌면 판과 뷰가 함께 따라간다. */
export function setGap(half) {
  grid.gap = half * 2;
  view.bleed = half;
}

/**
 * 지금 판을 한 벌로 걷는다. 스페이스가 담는 것이 이것이다.
 *
 * 배치와, 무엇을 보고 있었는지와, 접힌 레일이 다시 설 폭. 셋 다 그 스페이스의
 * 것이지 이 판의 것이 아니다 — 판은 한 번에 한 스페이스를 그린다.
 */
export const capture = () => ({
  state: grid.toJSON(),
  focusedId,
  railWidth: { ...railWidth },
  named,
});

/** 걷어 두었던 한 벌을 판에 건다. */
export function adopt(kept) {
  grid.replace(kept.state);
  focusedId = kept.focusedId;
  Object.assign(railWidth, kept.railWidth);
  named = kept.named;
  settle();
}

/** 아직 아무것도 없는 스페이스 한 벌. 새 스페이스가 이것으로 시작한다. */
export const fresh = () => ({
  state: initial(),
  focusedId: "terminal",
  railWidth: freshRailWidth(),
  named: 0,
});

export { settle, tabsOf, plane, drawRail };
export const render = () => view.render();
export const currentGrid = () => grid;
export const currentView = () => view;
