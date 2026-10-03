// 판 하나. 카드, 탭, 드래그, 레일, 선택 레이어, 렌더링을 담당한다.
//
// 표면의 위치를 카드 안 슬롯 요소에 기록하고, 그 위에 DOM 을 그릴 때 표면을 숨기도록
// 요청한다. 표면을 측정하고 보고하는 방법은 알지 않는다.
//
// 검증의 존재를 알지 않는다. 렌더링 완료만 통지하고 이후 처리는 문서가 정한다.
import { Soksak, SoksakView, outline } from "soksak";
import { borderWidth, cardRadius, halfGap, linkedSet, pluginSettings, set as setSetting, stagePad, value } from "./settings.js";
import { nextTextSize, notifyTextSize, setSurfaceTextSize, setTextScope, textScope } from "./text-size.js";
import { hasPlugin, isPlace, plugin, plugins } from "./registry.js";
import { clearSet, drawSet, restoreSidebarChoices, sidebarChoices } from "./sidebar-sections.js";
import { bindSidebarGrip } from "./sidebar-grip.js";
import { targetCardInsets } from "./card-insets.js";
import { CARD_TOOL_MENUS, createCardTools, updateCardTools } from "./card-tools.js";
import { SIDEBAR_SIDES, deviceGridSize, presentSidebars, effectiveSidebar, resolveSidebarSet, setSidebar, sideName, sizeSidebar, spaceFoldText, toggleSidebar } from "./card-sidebars.js";
import { arrangeWindowSidebars, keepWindowSidebarWidths, railSidebars, restoreWindowSidebars, standingLink, windowSidebarCards } from "./window-sidebars.js";
import { environment, pluginUnits } from "./environment.js";
import { checkStoredLayout } from "./stored-layout.js";
import { standIn } from "./compositor.js";
import { native, onSurfaceInput, overlay, report, shapes, windowSidecar } from "./host.js";
import { icon } from "./icons.js";
import { issueId } from "./ids.js";
import { bind, delegate, mark, run } from "./commands.js";
import { disposeSurface, focusSurface, mountSurface, placePluginPlaceholder } from "./surface-modules.js";
import { onPluginOperations, pluginOperations } from "./installed-plugins.js";
import { setSurfaceStatus, surfaceErrorText } from "./surface-status.js";
import { clearVisibleNotices, onTabReports, recordOrigin, setVisibleTab, tabFooter, tabLabel, tabNotice } from "./tab-reports.js";
import { configureSystemNotifications, systemNotifications } from "./system-notifications.js";

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
    // 기본값: 누른 점에 경계선이 없으면 잡은 경계선이 없다(null).
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

// 창 사이드바의 폭과 소유 탭을 공간에 보관하고 숨김·재표시 후에도 유지한다.
let windowSidebars = {};

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
// 기본값: 고정 좌우 사이드바 카드는 data가 null이므로 표면 탭이 없다.
const tabsOf = (card) => card?.data?.tabs ?? [];
const activeTab = (card) => tabsOf(card).find((t) => t.id === card.data.activeId);
// 기본값: 포커스된 카드가 없거나 탭이 없는 자리 카드이면 포커스된 플러그인이 없다(null).
const focusedPlugin = () => activeTab(grid.card(focusedId))?.plugin ?? null;
/** 탭에 보이는 이름: 표면이 알린 제목이 있으면 그것, 없으면 탭 이름. */
// 기본값: 표면이 제목을 알리지 않았으면 탭 이름을 보인다(docs/spec/plugins.md 의 tab.title).
const tabName = (t) => tabLabel(t.id) ?? t.title;

/** 새 탭 하나. 번호는 화면에 보이는 이름일 뿐이고 id 는 ids.js 가 발급한다. */
function newTab(kind) {
  const t = tab(kind, "");
  t.title = `${plugin(kind).mark} 탭 ${++named}`;
  return t;
}

/**
 * 해당 자리에 연결된 세트를 반환한다.
 *
 * 연결된 세트가 없으면 null 을 반환하고 사이드바를 표시하지 않는다.
 */
function standingSet(place) {
  const link = standingLink(place, windowSidebarCards(pluginUnits(), value("links"), focusedPlugin()));
  return link === null ? null : linkedSet(link.place, link.plugin);
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
    ? '<header class="chrome"></header><div class="set"></div><footer class="status sidebar-status" data-expose="core.sidebar.status"></footer>'
    : '<header class="chrome" data-expose="core.card.header"></header><div class="slot"></div><footer class="status" data-expose="core.card.status"></footer>';
  // 카드 객체를 클로저에 담지 않고 요소의 data-card-id 를 읽는다. 스페이스를
  // 바꾸면 같은 id 로 새 카드 객체가 만들어지므로, 담아 둔 참조는 없어진 객체다.
  el.dataset.command = "core.card.focus";
  el.addEventListener("pointerdown", (e) => {
    const id = el.dataset.cardId;
    // 누른 카드가 글자 크기의 범위다(docs/spec/text-size.md).
    if (id) setTextScope({ kind: "card", card: id });
    if (!id || isPlace(id) || e.target.closest(".tab__x, .chrome__act, .chrome__ham, .card-sidebar__grip, .set button")) return;
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

function updateCard(el, card, rect) {
  // 네이티브 준비를 기다리던 이전 배치는 그 사이 닫힌 카드를 담을 수 있다. 닫힌 카드는 탭이 없고 그 표면은 이미
  // 해제되었으므로 내용을 고치거나 표면을 다시 마운트하지 않는다. 다음 배치가 그 카드를 지운다.
  if (!grid.card(card.id)) return;
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
    const { plugin: kind, side } = windowSidebarCards(pluginUnits(), value("links"), focusedPlugin()).find(item => item.id === place);
    // 사이드바 카드는 머리 줄을 보이지 않는다. 섹션이 맨 위에서 시작하고 자리 설명은 상태 줄이 한다.
    el.dataset.place = place;
    const set = standingSet(place);
    const holder = el.querySelector(".set");
    if (set) {
      // 플러그인 오버라이드는 포커스 카드의 활성 표면을 사용한다.
      const owner = kind === null ? { card: null, surface: null }
        : { card: focusedId, surface: activeTab(grid.card(focusedId)).id };
      // 일반 사이드바 내용은 카드·표면 연결과 레일이 없다.
      drawSet(holder, card.id, set, { ...owner, orientation: "vertical", window: true, plugin: kind, side });
    } else {
      clearSet(holder);
      holder.replaceChildren();
    }
    setText(statusText, `${side === "left" ? "왼쪽" : "오른쪽"} 창 사이드바${kind ? ` · ${kind}` : ""}`);
    // 상태 줄 끝의 접기 단추는 이 사이드바를 끈다. 다시 켜는 단추는 창 머리에 있다(docs/spec/plugins.md#sections).
    let fold = status.querySelector(".sidebar-status__fold");
    if (!fold || fold.dataset.side !== side) {
      fold?.remove();
      fold = document.createElement("button");
      fold.type = "button";
      fold.className = "sidebar-status__fold";
      fold.dataset.side = side;
      fold.dataset.expose = "core.sidebar.fold";
      fold.title = `${side === "left" ? "왼쪽" : "오른쪽"} 창 사이드바 접기`;
      fold.setAttribute("aria-label", fold.title);
      fold.innerHTML = icon(side === "left" ? "chevron-left" : "chevron-right");
      bind(fold, "core.settings.set", { patch: { [side]: false } });
      status.appendChild(fold);
    }
    return;
  }

  const folded = drawCardSidebars(el, card, rect);
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

  if (!acts) {
    acts = createCardTools(card.id);
    chrome.appendChild(acts);
  }
  updateCardTools(acts, {
    canClose: grid.canClose(card.id),
    canSplitX: grid.canSplit(card.id, "x"),
    canSplitY: grid.canSplit(card.id, "y"),
    fullscreen: el.dataset.fullscreen === "true",
  });

  // 표면의 슬롯. 컴포지터는 판의 구조를 알지 않으므로 필요한 값을 여기에 기록한다.
  //
  // 표면의 정체는 탭이다. 카드로 하면 같은 카드의 다른 탭들이 표면 하나를 나눠
  // 쓰고, 카드 id 는 스페이스마다 같은 값이라 스페이스가 달라도 같은 표면이 된다.
  const slot = el.querySelector(".slot");
  const shown = activeTab(card);
  if (!hasPlugin(shown.plugin)) {
    // 불러오지 않은 플러그인의 탭은 표면이 아니라 자리 표시다. 컴포지터가 표면으로 보지 않도록 표면 표시를 지운다.
    for (const key of ["nativeSurface", "nativeSurfaceId", "nativeLayer", "nativePlugin", "nativeTitle", "nativeDim"]) delete slot.dataset[key];
    placePluginPlaceholder(slot, shown.id, pluginPlaceholder(shown));
    slot.dataset.surfaceStatus = "ready";
    setSurfaceStatus(status, { phase: "ready" });
    surfaceStates.set(shown.id, { phase: "ready", error: null });
    surfaceStateChanged();
    cardFolds.set(card.id, folded);
    setText(statusText, cardStatusText(card, tabs, folded));
    return;
  }
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
        phase: state.phase,
        error: state.phase === "error" ? surfaceErrorText(state) : null,
      });
      surfaceStateChanged();
    },
  }).catch((error) => {
    report(`surface ${shown.id} mount failed: ${error.message}`);
  });
  cardFolds.set(card.id, folded);
  setText(statusText, cardStatusText(card, tabs, folded));
}

// 카드마다 마지막으로 그린 공간 부족 접힘 문구. 탭이 하단 글을 바꾸면 다시 그리지 않고 발만 고친다.
const cardFolds = new Map();
/** 카드 내용 발의 글: 활성 탭의 플러그인이 알린 하단 글과 공간 부족으로 접힌 면(docs/spec/example-model.md). */
function cardStatusText(card, tabs, folded) {
  // 기본값: 탭이 없거나 하단 글을 알리지 않은 탭의 발은 빈 글이다.
  const text = tabs.length ? tabFooter(activeTab(card).id) ?? "" : "";
  return [text, folded].filter((part) => part !== null && part !== "").join(" · ");
}

/* ── 불러오지 않은 플러그인의 탭(docs/spec/plugins.md) ───────────────── */

/** 이유마다 자리 표시의 글. */
const PLACEHOLDER_LINES = {
  missing: (id) => `${id} 플러그인이 설치되어 있지 않습니다.`,
  disabled: (id) => `${id} 플러그인을 사용하지 않습니다.`,
  restart: (id) => `애플리케이션을 다시 시작하면 ${id} 플러그인이 열립니다.`,
  host: (id) => `${id} 플러그인은 네이티브 호스트가 있어야 설치됩니다.`,
  unread: (id) => `${id} 플러그인의 설치 상태를 읽지 못했습니다.`,
};

/** 불러오지 않은 플러그인 탭의 이유. 워크벤치는 첫 스페이스를 열기 전에 플러그인 상태를 읽는다. */
function placeholderReason(id) {
  if (!pluginOperations.hosted) return "host";
  if (pluginOperations.failure()?.kind === "state") return "unread";
  const row = pluginOperations.status().plugins.find((entry) => entry.id === id);
  if (!row?.installed) return "missing";
  return row.installed.enabled ? "restart" : "disabled";
}

/** 자리 표시 요소. 이유에 따라 설치나 사용 버튼이 있다. */
function pluginPlaceholder(tab) {
  const reason = placeholderReason(tab.plugin);
  const el = document.createElement("div");
  el.dataset.pluginPlaceholder = reason;
  el.dataset.plugin = tab.plugin;
  el.style.cssText = "position:absolute;inset:0;display:grid;place-content:center;justify-items:center;gap:10px;color:var(--muted)";
  const line = document.createElement("p");
  line.textContent = PLACEHOLDER_LINES[reason](tab.plugin);
  el.append(line);
  const row = pluginOperations.status().plugins.find((entry) => entry.id === tab.plugin);
  const action = reason === "missing" && row?.latest ? ["install", "설치"] : reason === "disabled" ? ["enable", "사용"] : null;
  if (action) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ui-button";
    button.dataset.expose = "core.card.placeholder-action";
    button.textContent = action[1];
    bind(button, `core.plugins.${action[0]}`, { plugin: tab.plugin });
    el.append(button);
  }
  return el;
}

// 플러그인 상태가 바뀌면 자리 표시의 이유와 버튼을 다시 정한다.
onPluginOperations(() => {
  if (grid && grid.cards.some((card) => tabsOf(card).some((tab) => !hasPlugin(tab.plugin)))) settle();
});

/* ── T5 — 마지막 탭이 이동하면 카드를 닫는다 ─────────────────────────── */

async function closeTab(cardId, tabId) {
  const card = grid.card(cardId);
  if (!card) return;
  if (!tabsOf(card).some((t) => t.id === tabId)) return;
  // 탭 닫기는 모듈이 native composition과 sidecar 세션을 해제한 뒤에야
  // 완료된다. command registry는 settled barrier를 실행하기 전에 이 promise를
  // 기다린다. 그렇지 않으면 barrier가 비동기 dispose와 경쟁하여, 탭이 아직
  // 호스트에 보이는 동안 시간 초과될 수 있다.
  await disposeSurface(tabId);
  card.data.tabs = tabsOf(card).filter((t) => t.id !== tabId);
  if (card.data.tabs.length === 0) {
    // 닫을 수 없는 카드는 남으므로 탭 하나를 다시 넣는다. 종류는 포커스가 보던
    // 것이고, 없으면 등록된 첫 플러그인이다. 여기에 이름을 적으면 플러그인을 더할
    // 때마다 이 파일을 고쳐야 한다.
    if (grid.canClose(cardId)) grid.close(cardId);
    // 기본값: 위 주석대로 포커스된 플러그인이 없으면 등록된 첫 플러그인의 탭을 연다.
    else card.data.tabs = [newTab(focusedPlugin() ?? plugins()[0].id)];
  }
  if (!tabsOf(card).some((t) => t.id === card.data?.activeId)) {
    // 기본값: 탭이 남지 않은 카드는 활성 탭이 없다(null).
    if (card.data) card.data.activeId = tabsOf(card)[0]?.id ?? null;
  }
  // 기본값: 자리 카드만 남으면 포커스할 카드가 없다(null).
  if (!grid.card(focusedId)) focusedId = grid.cards.find((c) => !isPlace(c.id))?.id ?? null;
  settle();
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
  restoreFullscreen();
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
    if (el.hasPointerCapture(ev.pointerId)) el.releasePointerCapture(ev.pointerId);
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
// 기본값: 위 주석대로 아직 상태를 알리지 않은 표면은 불러오는 중이다.
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
  title: picker ? pickerEl.getAttribute("aria-label") : "",
  items: picker ? [...pickerEl.querySelectorAll(".picker__item")].map((b) => ({
    key: b.dataset.key, name: b.querySelector(".picker__name").textContent, active: b.dataset.active === "true",
  })) : [],
});

/* 카드 도구 버튼의 data-do 와 core.card.menu 의 menu 값. */
const MENU_OF = CARD_TOOL_MENUS;
const DO_OF = Object.fromEntries(Object.entries(MENU_OF).map(([what, menu]) => [menu, what]));

const PICKER_ASK = {
  add: "새 탭에 무엇을 띄울까",
  x: "새 위치에 무엇을 띄울까",
  y: "새 위치에 무엇을 띄울까",
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
    (k) => (what === "add" ? addTab(cardId, k) : splitWith(cardId, TOOL_SPLIT_SIDE[what], k)));
}

/** 활성화할 탭을 선택받는다. 헤더가 접혔을 때 탭 목록을 표시한다. */
function openTabList(anchor, cardId) {
  const card = grid.card(cardId);
  if (!card?.data) return;
  openLayer(anchor, `탭 ${tabsOf(card).length}개`, tabsOf(card).map((t) => ({
    // 불러오지 않은 플러그인의 탭은 표시 없이 이름만 보인다.
    key: t.id, name: tabName(t), mark: hasPlugin(t.plugin) ? plugin(t.plugin).mark : "?", svg: hasPlugin(t.plugin) ? plugin(t.plugin).svg : "",
    notice: tabNotice(t.id),
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
      b.title = systemNotifications.tooltip(it.notice);
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
  // native picker는 자체 WebView를 가지며 ready를 보고할 때 focus를 받는다.
  // 여기서 이제 숨겨진 DOM 항목에 focus를 주면 first responder가 main WebView로
  // 돌아가고, native picker가 닫히기 전에 Escape를 잃는다.
  if (!native) {
    // 기본값: 고른 항목이 없는 선택기는 첫 항목에 포커스한다.
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
  if (view.fullscreenCard !== cardId) restoreFullscreen();
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
/** 새 카드를 놓는 변. 카드 도구의 세로선 분할은 오른쪽, 가로선 분할은 아래에 새 카드를 둔다. */
const SPLIT_SIDES = ["left", "right", "top", "bottom"];
const TOOL_SPLIT_SIDE = { x: "right", y: "bottom" };

function splitWith(cardId, side, plugin) {
  restoreFullscreen();
  const card = grid.card(cardId);
  if (!card?.data) return;
  const t = newTab(plugin);
  recordOrigin(t.id, activeTab(card)?.id);
  // 공간이 없으면 splitToward 가 null 을 반환한다. 원본 카드에서 제거한 탭이 없으므로
  // 복구할 상태가 없다.
  const born = grid.splitToward(cardId, side, { data: { tabs: [t], activeId: t.id } });
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
      radius: parseFloat(css.borderTopLeftRadius),
      lineWidth: parseFloat(css.borderTopWidth),
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
    // 기본값: 탭이 남지 않은 카드는 활성 탭이 없다(null).
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

/* ── 카드 사이드바 ─────────────────────────────────────────────────────
   각 변의 세트와 배치는 독립적이다. 사이드바는 카드 크기를 바꾸지 않고 내용 영역을 나눈다. */

/** 카드 사이드바의 공용 크기 설정. */
const sidebarDefaults = () => ({ size: value("sidebarWidth"), min: value("sidebarMinWidth"), max: value("sidebarMaxWidth") });
const sidebarSets = () => Object.fromEntries(value("sets").map((set) => [set.id, set]));
function sidebarCard(id) {
  const card = grid?.card(id);
  if (!card?.data) throw new Error(`card ${String(id)} has no content`);
  return card;
}
function linkedCardSet(card, side) {
  const kind = activeTab(card)?.plugin;
  return kind ? linkedSet(`card-${side}`, kind) : null;
}
export function cardSidebars(card, rect) {
  if (!card.data) return {};
  const report = {};
  for (const side of SIDEBAR_SIDES) {
    const current = effectiveSidebar(card, side, sidebarDefaults(), linkedCardSet(card, side));
    if (current !== null) report[side] = current;
  }
  const el = cardElement(card.id);
  if (!el || !rect) throw new Error(`card ${card.id} has no sidebar presentation geometry`);
  const style = getComputedStyle(el);
  // 기본값: 조작한 면이 없는 카드는 축마다 위나 왼쪽을 먼저 연다(빈 선택, docs/spec/example-model.md).
  const operated = sidebarOperated.get(card.data) ?? {};
  return presentSidebars(report, rect, { header: HEADER, footer: FOOTER, border: parseFloat(style.getPropertyValue("--bw")),
    divider: parseFloat(style.getPropertyValue("--divider")), minimum: grid.minSize, sidebarMinimum: sidebarDefaults().min },
    operated);
}
// 카드마다 축별로 마지막으로 클릭하거나 끈 면. 두 면이 함께 들어가지 않을 때 이 면을 연다(docs/spec/example-model.md).
// 표시 순간의 선택이므로 저장하지 않고 카드의 데이터 객체에 묶는다. 배치를 바꾸거나 복원하면 새 데이터 객체이므로
// 같은 id 의 카드에도 앞 배치의 선택이 남지 않는다.
const sidebarOperated = new WeakMap();
function operateSidebar(card, side) {
  const axis = side === "left" || side === "right" ? "width" : "height";
  sidebarOperated.set(card.data, { ...sidebarOperated.get(card.data), [axis]: side });
}
export function assignSidebar(id, side, set) {
  setSidebar(sidebarCard(id), side, set, sidebarSets());
  settle();
}
export function foldSidebar(id, side) {
  const card = sidebarCard(id);
  const shown = cardSidebars(card, presentedCardRect(card.id))[side];
  if (!shown) throw new Error(`card ${String(card.id)} has no ${String(side)} sidebar`);
  operateSidebar(card, side);
  toggleSidebar(card, side, sidebarDefaults(), linkedCardSet(card, side), shown.collapsed);
  settle();
}
export function resizeSidebar(id, side, size) {
  const card = sidebarCard(id);
  operateSidebar(card, side);
  sizeSidebar(card, side, size, sidebarDefaults(), linkedCardSet(card, side));
  settle();
}

/** 카드의 사방 사이드바를 그리고, 공간이 부족해 접힌 면이 있으면 상태 줄 문구를 돌려준다(없으면 null). 없는 변은 공간을 차지하지 않는다. */
function drawCardSidebars(el, card, rect) {
  // 기본값: 사이드바 기록이 없는 카드에는 공간 부족으로 접힌 면이 없다(null).
  if (!card.data) return null;
  const defaults = sidebarDefaults();
  const sets = sidebarSets();
  const presentation = cardSidebars(card, rect);
  for (const side of SIDEBAR_SIDES) {
    const existing = el.querySelector(`:scope > .card-sidebar[data-side-of="${side}"]`);
    // 기본값: 표시 상태가 없는 면에는 사이드바가 없다.
    const state = presentation[side] ?? null;
    const set = resolveSidebarSet(card, side, sets, defaults, linkedCardSet(card, side));
    if (state === null || set === null) {
      if (existing) clearSet(existing.querySelector(".set"));
      existing?.remove();
      delete el.dataset[`sidebar${side[0].toUpperCase()}${side.slice(1)}`];
      el.style.removeProperty(`--p${side[0]}`);
      continue;
    }
    let body = existing;
    if (!body) {
      body = document.createElement("aside");
      body.className = "card-sidebar";
      body.dataset.sideOf = side;
      // 사이드바는 자기 면과 세트를 말하는 상태 줄로 끝난다(docs/spec/example-model.md).
      body.innerHTML = '<div class="set"></div><footer class="card-sidebar__status" data-expose="core.card.sidebar.status"></footer>';
      const handle = document.createElement("div");
      handle.className = "card-sidebar__grip";
      handle.dataset.sideOf = side;
      handle.dataset.expose = "core.card.sidebar.grip";
      body.appendChild(handle);
      // 그림 영역 뒤는 표면이 아니라 사이드바 프레임이므로 .slot 뒤가 아니라 카드 끝에 둔다.
      const status = el.querySelector(".status");
      if (!status) throw new Error(`card ${card.id} has no status region`);
      status.before(body);
      bindSidebarGrip(el, handle, side, defaults, run);
    }
    const handle = body.querySelector(".card-sidebar__grip");
    mark(handle, "core.card.sidebar.size", { card: card.id, side });
    const name = sideName(side);
    setText(body.querySelector(".card-sidebar__status"), `${name} 사이드바 · ${set.title}`);
    handle.title = state.autoCollapsed ? `공간 부족으로 ${name} 사이드바 자동 접힘` : state.collapsed ? `눌러 ${name} 사이드바 펼치기` : `끌어 크기 바꾸기 · 눌러 ${name} 사이드바 접기`;
    el.dataset[`sidebar${side[0].toUpperCase()}${side.slice(1)}`] = state.collapsed ? "folded" : "open";
    el.style.setProperty(`--p${side[0]}`, state.collapsed ? "var(--divider)" : `${deviceGridSize(state.shownSize, devicePixelRatio)}px`);
    // 기본값: 탭 없는 카드의 사이드바 섹션에는 표면 문맥이 없다(null) — 좌측 창 사이드바와 같은 문맥이다.
    const surface = activeTab(card) === null || activeTab(card) === undefined ? null : activeTab(card).id;
    drawSet(body.querySelector(".set"), `${card.id}:${side}`, set, { card: card.id, surface, orientation: side === "top" || side === "bottom" ? "horizontal" : "vertical" });
  }
  return spaceFoldText(presentation);
}

/**
 * 고정 자리를 제거한다.
 *
 * `fixed` 는 레이아웃이 그 카드를 이동하거나 닫지 않는다는 뜻이므로 제거 전에 해제한다.
 * `canClose` 는 `fixed` 카드에 항상 false 를 반환한다.
 */
function dismiss(id) {
  if (!grid.card(id)) return;
  grid.setFixed(id, false);
  if (!grid.close(id)) { grid.setFixed(id, true); throw new Error(`cannot remove window sidebar ${id}`); }   // 치우지 못했으면 역할도 그대로
  // 카드를 닫으면 그 카드가 참조하던 선을 아무도 참조하지 않는다. 라이브러리는 그런
  // 선을 남기고 제거 시점을 호스트에 맡긴다. 남겨 두면 확장된 카드가 그 선을 가로질러
  // `standings` 가 후보로 반환하지 않고, 사이드바가 다시 열릴 때 새 선이 추가되어 같은
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
function settle() {
  if (!grid) return;
  closePicker();
  arrangeWindowSidebars(grid, windowSidebarCards(pluginUnits(), value("links"), focusedPlugin()), windowSidebars,
    value("sidebarWidth"), side => value(side), dismiss);
  // 기본값: 자리 카드만 남으면 포커스할 카드가 없다(null).
  if (!grid.card(focusedId)) focusedId = grid.cards.find((c) => !isPlace(c.id))?.id ?? null;
  view.render();
  syncBackgroundSessions();
}

/* 진행 중인 scrollend 대기. 다음 요청이 이전 대기를 취소한다. */
const landing = new WeakMap();

// 카드 focus는 같은 위치의 native surface를 교체할 수 있다. native 입력 소유자는
// 그 표시 전이 아니라 표시 뒤에 focus를 받아야 한다.
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
    // 불러오지 않은 플러그인의 탭에는 배경 세션이 없다.
    const descriptor = hasPlugin(tab.plugin) ? plugin(tab.plugin).background : null;
    if (!descriptor || tabs.get(tab.id) !== tab) continue;
    const owner = grid.cards.find((card) => tabsOf(card).some((item) => item.id === tab.id));
    if (owner?.data?.activeId === tab.id || backgroundSessions.has(tab.id)) continue;
    const port = windowSidecar(descriptor.sidecar);
    if (!port) throw new Error(`background sidecar unavailable: ${descriptor.sidecar}`);
    const state = { stop: null };
    backgroundSessions.set(tab.id, state);
    // manifest가 연산을 명시한다. 사이드카 전송은 기존 wire 필드 `op`를 유지하며
    // 이 위치가 유일한 프로토콜 변환 지점이다.
    // background.settings 가 선언한 요청 필드에 그 플러그인 설정의 현재 값을 넣는다.
    const open = () => {
      const values = pluginSettings(tab.plugin);
      // 기본값: background.settings 는 선택 필드이며 없으면 설정 값을 넣지 않는다(docs/spec/plugins.md).
      const fields = Object.fromEntries(Object.entries(descriptor.settings ?? {}).map(([field, setting]) => [field, values[setting]]));
      return port.send(tab.id, { ...fields, operation: descriptor.operation });
    };
    Promise.resolve(port.on(tab.id, (body) => {
      // 영속 사이드카의 연결이 다시 맺히면 백그라운드 세션도 다시 연다 — 재스폰된
      // 서비스에는 그 세션이 없다(V5-106). 실패 알림은 세션 오류로 남긴다.
      if (body?.event === "connection") {
        if (body.connected === true) {
          open().catch((error) => {
            report(`background session ${tab.id} reopen failed: ${error.message}`);
          });
        } else {
          report(`background session ${tab.id}: sidecar connection failed${typeof body.reason === "string" ? `: ${body.reason}` : ""}`);
        }
        return;
      }
      if (body?.error || body?.body?.error) {
        const reply = body.error ? body : body.body;
        report(`background session ${tab.id}: ${reply.error}${typeof reply.reason === "string" ? `: ${reply.reason}` : ""}`);
      }
    })).then((stop) => { state.stop = stop; }, (error) => {
      report(`background session ${tab.id} listener failed: ${error.message}`);
    });
    open().catch((error) => {
      backgroundSessions.delete(tab.id);
      report(`background session ${tab.id} open failed: ${error.message}`);
    });
  }
  for (const [tabId, state] of backgroundSessions) {
    if (tabs.has(tabId)) continue;
    // 기본값: 수신 등록은 비동기로 끝나므로 그 전에 탭이 사라지면 멈출 함수가 아직 없다.
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
  // 기본값: 활성 탭이 없는 카드는 가운데 둔 탭이 없다(빈 문자열).
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
  // 기본값: columnGap 의 계산값 normal 은 수가 아니며 flex 에서 0 이다.
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
  // 기본값: columnGap 의 계산값 normal 은 수가 아니며 flex 에서 0 이다.
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
let railShape = { shape: { path: "", loops: [], corners: 0, sharp: 0 }, rects: [], groups: [] };

/** 마지막으로 그린 레일 외곽선과 그 대상 사각형. */
export const railOutline = () => railShape;

function drawRail() {
  const sidebars = railSidebars(windowSidebarCards(pluginUnits(), value("links"), focusedPlugin()), id => grid.card(id));
  // 합침은 반 통로의 pad 로 정하고, 선이 반 통로 안쪽의 온전한 픽셀에 그려지도록 합친 윤곽을 선 굵기의 절반만큼 줄인다.
  const pad = grid.gap / 2, corner = cardRadius(), inset = borderWidth() / 2;
  const groups = [];
  if (sidebars.length) {
    const card = focusedId;
    const rects = [card, ...sidebars].map(id => view.painted(id)).filter(rect => rect && rect.w > 0 && rect.h > 0);
    if (rects.length === sidebars.length + 1) {
      const shape = outline(rects, { pad, inset, radius: corner === 0 ? 0 : corner + pad - inset });
      groups.push({ card, sidebars, ...shape, rects });
    }
  }
  const shape = { path: groups.map(group => group.path).join(" "), loops: groups.flatMap(group => group.loops),
    corners: groups.reduce((n,group) => n + group.corners,0), sharp: groups.reduce((n,group) => n + group.sharp,0) };
  railPath.setAttribute("d", shape.path);
  return { shape, rects: groups.flatMap(group => group.rects), groups };
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
function seats(rects) {
  const out = new Map();
  for (const card of grid.cards) {
    if (isPlace(card.id)) continue;
    const el = cardElement(card.id);
    const slot = el?.querySelector(":scope > .slot[data-native-surface]");
    let inset = null;
    if (slot) {
      const folded = parseFloat(getComputedStyle(el).getPropertyValue("--divider"));
      if (!Number.isFinite(folded) || folded < 0) throw new Error("invalid sidebar divider width");
      const effective = cardSidebars(card, rects.get(card.id));
      const bands = Object.fromEntries(SIDEBAR_SIDES.map(side => {
        const state = effective[side];
        return [side, state ? (state.collapsed ? folded : deviceGridSize(state.shownSize, devicePixelRatio)) : 0];
      }));
      inset = targetCardInsets(el, slot, bands);
    }
    out.set(card.id, { id: activeTab(card).id, dim: dimmed(card.id), inset });
  }
  return out;
}

function restoreWindowState(kept) {
  checkStoredLayout(kept);
  return restoreWindowSidebars(Object.hasOwn(kept, "windowSidebars") ? kept.windowSidebars : {});
}

/** 판을 처음부터 다시 만든다. */
function build(kept) {
  const restored = restoreWindowState(kept);
  view?.destroy();
  named = kept.named;
  // 사이드바마다 고른 탭과 접은 섹션. sidebars 가 없는 배치에는 저장된 선택이 없다(docs/spec/projects.md#persistence).
  // 기본값: sidebars 가 없는 저장 배치에는 저장된 선택이 없다(docs/spec/projects.md#persistence).
  restoreSidebarChoices(Object.hasOwn(kept, "sidebars") ? kept.sidebars : {});
  windowSidebars = restored;
  const half = halfGap();
  grid = new Soksak(kept.state, { gap: half * 2 });
  focusedId = kept.focusedId;
  view = new SoksakView(plane, grid, {
    createCard, updateCard,
    // 판은 stage 안쪽으로 이 값만큼 들어와 있다. 호스트만 아는 값이므로 뷰에 전달해야
    // 판 가장자리에 닿는 선이 stage 경계까지 이어진다.
    bleed: stagePad(),
    commit: (made, draw) => layouter ? layouter(made, draw, seats(made)) : draw(),
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
      // 기본값: onRender 가 수신자를 등록하기 전의 그리기는 알릴 곳이 없다.
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
      b.title = systemNotifications.tooltip(notice);
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
  ham.title = notices.length ? systemNotifications.tooltip(notices.join("\n")) : "탭 목록";
}

// 탭이 보인다는 것은 포커스된 카드의 활성 탭이라는 뜻이다. 그 탭에 온 알림은 두지 않는다.
setVisibleTab((id) => {
  const card = grid?.card(focusedId);
  return Boolean(card?.data) && activeTab(card)?.id === id;
});

// 표면이 탭 제목이나 알림을 알리면 탭 이름과 점만 다시 쓴다. 레이아웃은 바뀌지 않으므로 다시 그리거나 저장하지 않는다.
// 시스템 알림 권한이 바뀌면 알림 도움말도 다시 쓴다.
const redrawTabReports = () => {
  for (const el of document.querySelectorAll(".card[data-card-id]")) {
    const card = grid?.card(el.dataset.cardId);
    const chrome = el.querySelector(".chrome");
    if (!card?.data || !chrome) continue;
    for (const name of chrome.querySelectorAll(".tab[data-tab-id] .tab__name")) {
      const t = tabsOf(card).find((item) => item.id === name.parentElement.dataset.tabId);
      if (t) name.textContent = tabName(t);
    }
    drawNotices(chrome, tabsOf(card));
    const statusText = el.querySelector(":scope > .status .status__text");
    // 기본값: 아직 그리지 않은 카드에는 접힌 면 문구가 없다.
    if (statusText && !isPlace(card.id)) setText(statusText, cardStatusText(card, tabsOf(card), cardFolds.get(card.id) ?? null));
  }
};
onTabReports(redrawTabReports);
systemNotifications.onChange(redrawTabReports);

// 시스템 알림의 제목은 탭 이름이고, 누른 알림은 선언된 명령으로 그 탭을 고른다.
configureSystemNotifications({
  tabName: (id) => {
    const card = grid?.card(cardOfTab(id)?.id);
    const t = card ? tabsOf(card).find((item) => item.id === id) : null;
    return t ? tabName(t) : id;
  },
  select: (id) => run("core.tab.select", { tab: id }),
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
 * 배치, 포커스와 고정 창 사이드바 폭은 공간의 값이다.
 * 판은 한 번에 스페이스 하나를 그린다.
 */
export const capture = () => {
  keepWindowSidebarWidths(grid.cards, windowSidebars);
  return {
    state: grid.toJSON(), focusedId,
    windowSidebars: structuredClone(windowSidebars),
    named, sidebars: sidebarChoices(),
  };
};

/** 보관해 둔 상태 한 벌을 판에 적용한다. */
export function adopt(kept) {
  if (!grid) return build(kept);
  const restored = restoreWindowState(kept);
  grid.replace(kept.state);
  focusedId = kept.focusedId;
  windowSidebars = restored;
  named = kept.named;
  // 기본값: sidebars 가 없는 저장 배치에는 저장된 선택이 없다(docs/spec/projects.md#persistence).
  restoreSidebarChoices(Object.hasOwn(kept, "sidebars") ? kept.sidebars : {});
  settle();
}

/** 빈 스페이스 상태를 반환한다. 새 스페이스가 이 값으로 시작한다. */
export const fresh = () => ({
  state: initial(),
  focusedId: environment().workspace.focus,
  windowSidebars: Object.fromEntries(environment().workspace.grid.cards
    .filter(card => card.id === "left" || card.id === "right")
    // 기본값: 환경 선언에서 너비를 생략한 고정 사이드바는 sidebarWidth 설정의 너비로 시작한다.
    .map(card => [card.id, { width: card.width ?? value("sidebarWidth") }])),
  named: 0,
  sidebars: {},
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

// 기본값: 전체 화면 카드가 없으면 null 이다.
export const fullscreenCard = () => plane.querySelector('.card[data-fullscreen="true"]')?.dataset.cardId ?? null;
export const presentedCardRect = (id) => view?.painted(id);

function restoreFullscreen() {
  if (view?.fullscreenCard !== null && view?.fullscreenCard !== undefined) view.fullscreen(null);
}

export function toggleCardFullscreen(id) {
  paneCard(id);
  focusedId = id;
  closePicker();
  view.fullscreen(view.fullscreenCard === id ? null : id);
}

export function focusCard(id) {
  paneCard(id);
  if (view.fullscreenCard !== id) restoreFullscreen();
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

export function splitCard(id, side, kind) {
  paneCard(id);
  knownPlugin(kind);
  if (!SPLIT_SIDES.includes(side)) throw new Error(`unknown side ${side}; use left, right, top or bottom`);
  const made = splitWith(id, side, kind);
  if (!made) throw new Error(`card ${id} cannot split toward ${side}`);
  return made;
}

export function closeCard(id) {
  paneCard(id);
  if (!grid.canClose(id)) throw new Error(`card ${id} cannot close`);
  restoreFullscreen();
  grid.close(id);
  // 기본값: 자리 카드만 남으면 포커스할 카드가 없다(null).
  if (!grid.card(focusedId)) focusedId = grid.cards.find((c) => !isPlace(c.id))?.id ?? null;
  settle();
}

export function selectTab(tabId) {
  const card = cardOfTab(tabId);
  if (view.fullscreenCard !== card.id) restoreFullscreen();
  card.data.activeId = tabId;
  focusedId = card.id;
  settle();
}

export async function closeTabById(tabId) {
  const card = cardOfTab(tabId);
  restoreFullscreen();
  await closeTab(card.id, tabId);
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
  restoreFullscreen();
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
    ["close", "fullscreen"].includes(b.dataset.do) ? b.dataset.do : MENU_OF[b.dataset.do],
    { enabled: !b.disabled, hidden: b.hidden, title: b.title },
  ]));
  // 기본값: 탭 줄을 아직 맞추지 않은 카드의 머리는 접히지 않은 strip 이다.
  return { ...buttons, fit: chrome.dataset.fit ?? "strip" };
}

/** 레일 외곽선과 포커스 표식. */
export function railState() {
  const mark = document.getElementById("focusMark");
  return {
    path: railShape.shape.path,
    groups: railShape.groups,
    focusMark: mark.hidden ? null : {
      x: parseFloat(mark.style.left), y: parseFloat(mark.style.top),
      w: parseFloat(mark.style.width), h: parseFloat(mark.style.height),
    },
  };
}

export { settle, tabsOf, activeTab, plane };
export const currentGrid = () => grid;
/** 카드의 글자 크기 배율. 값이 없으면 1 이다. */
// 기본값: 위 주석대로 글자 크기 배율을 정하지 않은 카드는 1 이다.
const cardTextSize = (card) => card?.data?.textSize ?? 1;

/** 글자 크기의 현재 범위. 아직 누른 곳이 없으면 포커스된 카드다. */
export function currentTextScope() {
  // 기본값: 위 주석대로 아직 누른 곳이 없으면 포커스된 카드다.
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
  // 기본값: 판을 만들기 전에는 카드가 없다.
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
  // 기본값: 자리 카드는 data 가 null 이므로 글자 크기만 담는다.
  grid.setData(card.id, { ...(card.data ?? {}), textSize: nextTextSize(cardTextSize(card), direction) });
  settle();
}

/** 포커스된 카드의 id. */
export const focused = () => focusedId;
