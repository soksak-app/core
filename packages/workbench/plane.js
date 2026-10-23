// One plane. It handles cards, tabs, dragging, the rail, the picker layer, and rendering.
//
// It records the position of a surface in the slot element inside a card and asks the surface to hide when DOM is drawn
// over it. It does not know how a surface is measured and reported.
//
// It does not know that verification exists. It only announces that rendering finished, and the document decides what follows.
import { Soksak, SoksakView, outline, sliceTree } from "soksak";
import { borderWidth, cardRadius, halfGap, linkedSet, pluginSettings, set as setSetting, stagePad, value } from "./settings.js";
import { effectiveTextScope, nextTextSize, notifyTextSize, setSurfaceTextSize, setTextScope, textScope } from "./text-size.js";
import { applyFrameText, chromeRow, measureAt } from "./frame-text.js";
import { hasPlugin, isPlace, plugin, plugins } from "./registry.js";
import { clearSet, drawSet, restoreSidebarChoices, sidebarChoices } from "./sidebar-sections.js";
import { bindSidebarGrip } from "./sidebar-grip.js";
import { targetCardInsets } from "./card-insets.js";
import { CARD_TOOL_MENUS, createCardTools, updateCardTools } from "./card-tools.js";
import { SIDEBAR_SIDES, deviceGridSize, presentSidebars, effectiveSidebar, resolveSidebarSet, setSidebar, sideName, sizeSidebar, spaceFoldText, toggleSidebar } from "./card-sidebars.js";
import { arrangeWindowSidebars, keepWindowSidebarWidths, railSidebars, restoreWindowSidebars, standingLink, windowSidebarCards } from "./window-sidebars.js";
import { environment, pluginUnits } from "./environment.js";
import { checkStoredLayout, recordStoredOrigins } from "./stored-layout.js";
import { checkTabParams, storedParamsProblem } from "./tab-params.js";
import { chooseOpener } from "./file-open.js";
import { clearSlotSurface, setSlotSurface, standIn } from "./compositor.js";
import { native, onSurfaceInput, overlay, report, shapes, windowSidecar } from "./host.js";
import { icon } from "./icons.js";
import { issueId } from "./ids.js";
import { bind, delegate, mark, run, runOn } from "./commands.js";
import { fillPicker, pickerAnswer, pickerColumns, pickerGroups, pickerItems } from "./picker-layer.js";
import { mountSurface, mountedSurface, placePluginPlaceholder, surfaceForTab } from "./surface-modules.js";
import { emitEvent } from "./page-log.js";
import { trace } from "./performance.js";
import { onPluginOperations, pluginOperations } from "./installed-plugins.js";
import { setSurfaceStatus, surfaceErrorText } from "./surface-status.js";
import { clearVisibleNotices, missingOriginRecords, onTabReports, recordOrigin, reportError, setVisibleTab, storedLayoutState, tabButtonData, tabError, tabFooter,
  tabModified, tabNotice } from "./tab-reports.js";
import { hideError, showError } from "./shown-errors.js";
import { registry } from "./exposure.js";
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

/* The height of the head and the foot of a card. This value is the boundary of the drop zones and also the row height of the
   stylesheet. If each is written in its own place, the zones drift at the end of the head when only one of them changes. */
const HEADER = 32, FOOTER = 22;
document.documentElement.style.setProperty("--head", `${HEADER}px`);
document.documentElement.style.setProperty("--foot", `${FOOTER}px`);


/* Whether a surface that lost focus is dimmed. A card has one surface, so it is decided per card. */
const dimmed = (cardId) =>
  value("dim") && cardId !== focusedId;

/* A surface is a native view, so a click on it does not reach this document. When the application reports a surface id, the
   plane dispatches pointerdown on the matching slot element. The code that already receives pointerdown handles the focus
   move and the closing of the layer.

   One surface is one tab, so its id is the id of the tab. */
const pressSurface = (tabId) => {
  const slot = document.querySelector(
    `[data-native-surface-id="${tabId}"][data-native-surface]`);
  if (!slot) return;
  slot.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
};

/* The divider that holds a drag passed by the host. It is set on press and cleared on release. */
let heldDivider = null;

/* One step of the left button. The host converts the coordinates into those of this document and sends them.
   phase is 0 for press, 1 for move, and 2 for release.

   The grab area of a divider is wider than the gap. When the gap is one line wide, the whole area lies under a surface and
   the press does not reach this document, so the host passes the coordinates and this code decides which divider they are
   on. The view can also move a divider through mouse events, so the event is dispatched on that element and not on the plane. */
export const surfaceInput = ({ phase, x, y }) => {
  if (phase === 0) {
    // default: a point with no boundary line under it grabs no boundary line (null).
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

// It keeps the width and the owning tab of the window sidebar in the space and retains them after hiding and showing again.
let windowSidebars = {};

let grid, view, focusedId;
// The number in a tab title. It is a display name and not an identifier, so a counter produces it.
let named = 0;

/* ── Tab rules ──────────────────────────────────────────────────────────────
   T1 A card has a tab list and one active tab.
   T2 + and split ask for the kind first and then create a new tab. + puts it in the same card, split puts it in a new card.
      T3 and T4 handle moving an existing tab.
   T3 Drop in the center = the tab joins the target card. The layout stays as it is.
   T4 Drop on an edge = a new slot is needed on that side.
   T5 When the last tab leaves, the card disappears — no empty card remains.        */
// A tab stores params only when it was opened with them (docs/spec/plugins.md#pluginjson).
const tab = (plugin, title, params) => (params === null
  ? { id: issueId("tab"), plugin, title } : { id: issueId("tab"), plugin, title, params });
// default: the fixed left and right sidebar cards have null data, so they have no surface tab.
const tabsOf = (card) => card?.data?.tabs ?? [];
const activeTab = (card) => tabsOf(card).find((t) => t.id === card.data.activeId);
// default: when no card is focused, or the focused card is a place card without tabs, there is no focused plugin (null).
const focusedPlugin = () => activeTab(grid.card(focusedId))?.plugin ?? null;
/** The name shown on a tab: the title that the surface announced if there is one, otherwise the tab name. */
// default: a surface that announced no title shows the tab name (tab.title in docs/spec/plugins.md).
// A modified tab shows a dot before its name (docs/spec/plugins.md#tab-reports).
const tabName = (t) => tabButtonData(t).name;

/**
 * One new tab. The number is only a displayed name; ids.js issues the id. fromTabId is the source tab whose directory the new tab
 * records as its origin, or null when there is no source tab (docs/spec/projects.md#tab-origin).
 */
function newTab(kind, params, fromTabId, path) {
  if (fromTabId === undefined) throw new TypeError("newTab requires fromTabId, null when there is no source tab");
  const t = tab(kind, "", params);
  t.title = `${plugin(kind).mark} 탭 ${++named}`;
  recordOrigin(t.id, fromTabId, path);
  return t;
}

/**
 * Returns the set linked to the slot.
 *
 * Returns null when no set is linked, and the sidebar is not shown.
 */
function standingSet(place) {
  const link = standingLink(place, windowSidebarCards(pluginUnits(), value("links"), focusedPlugin()));
  return link === null ? null : linkedSet(link.place, link.plugin);
}

/** It builds the layout of a new space from workspace.grid of environment.json. Tab ids are issued anew. */
function initial() {
  const { grid: declared } = environment().workspace;
  const cards = declared.cards.map(({ tabs, ...card }) => {
    if (!tabs) return { ...card };
    // A tab of a new space has no source tab, so it records null (docs/spec/projects.md#tab-origin).
    const made = tabs.map((t) => {
      const opened = tab(t.plugin, t.title, null);
      recordOrigin(opened.id, null, "new space");
      return opened;
    });
    return { ...card, data: { tabs: made, activeId: made[0].id } };
  });
  return { xs: [...declared.xs], ys: [...declared.ys], cards };
}


/* ── Card ─────────────────────────────────────────────────────────────── */

function createCard(card) {
  const el = document.createElement("article");
  el.className = "card";
  el.dataset.expose = "core.card";
  el.innerHTML = isPlace(card.id)
    ? '<header class="chrome"></header><div class="set"></div><footer class="status sidebar-status" data-expose="core.sidebar.status"></footer>'
    : '<header class="chrome" data-expose="core.card.header"></header><div class="slot"></div><footer class="status" data-expose="core.card.status"></footer>';
  // It reads data-card-id of the element and does not capture the card object in a closure. Switching the space creates new
  // card objects with the same ids, so a captured reference is an object that no longer exists.
  el.dataset.command = "core.card.focus";
  el.addEventListener("pointerdown", (e) => {
    const id = el.dataset.cardId;
    // The pressed card is the scope of the text size (docs/spec/text-size.md).
    if (id) setTextScope({ kind: "card", card: id });
    if (!id || isPlace(id) || e.target.closest(".tab__x, .chrome__act, .chrome__ham, .card-sidebar__grip, .set button")) return;
    if (focusedId !== id) {
      return Promise.resolve(run("core.card.focus", { card: id }));
    }
  });
  return el;
}

/**
 * Updates only the changed parts.
 *
 * Earlier, every render rebuilt the chrome with `chrome.innerHTML = ""`. A single pointer move replaced 52 of 87 nodes, which
 * broke hover and focus, and the dragged tab disappeared so `pointerup` never arrived. The chrome is rebuilt only when the
 * tab list actually changed.
 */
const setText = (el, text) => { if (el.textContent !== text) el.textContent = text; };
const setHTML = (el, html) => { if (el.dataset.html !== html) { el.innerHTML = html; el.dataset.html = html; } };

function updateCard(el, card, rect) {
  // A previous layout that waited for native preparation can contain a card closed in the meantime. A closed card has no tabs
  // and its surface is already released, so its content is not fixed and its surface is not mounted again. The next layout removes that card.
  if (!grid.card(card.id)) return;
  const place = isPlace(card.id) ? card.id : null;
  // The actual text scale of the card content (frame scale × card scale). When the scale is 1, no zoom is declared. Even a zoom
  // declaration with the value 1 raised the cost for WebKit to redraw the surface content and reduced the display during a drag.
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
    // A sidebar card does not show a head row. The section starts at the top, and the status line describes the slot.
    el.dataset.place = place;
    const set = standingSet(place);
    const holder = el.querySelector(".set");
    if (set) {
      // A plugin override uses the active surface of the focused card.
      const owner = kind === null ? { card: null, surface: null }
        : { card: focusedId, surface: activeTab(grid.card(focusedId)).id };
      // The content of an ordinary sidebar has no card-surface link and no rail.
      drawSet(holder, card.id, set, { ...owner, orientation: "vertical", window: true, plugin: kind, side });
    } else {
      clearSet(holder);
      holder.replaceChildren();
    }
    setText(statusText, `${side === "left" ? "왼쪽" : "오른쪽"} 창 사이드바${kind ? ` · ${kind}` : ""}`);
    // The fold button at the end of the status line turns this sidebar off. The button that turns it on again is in the window head (docs/spec/plugins.md#sections).
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
  // The space app button at the very start of the head of a fullscreen card. CSS hides it when the card is not fullscreen (docs/spec/example-model.md).
  if (!chrome.querySelector(".chrome__apps")) {
    const apps = document.createElement("button");
    apps.className = "chrome__apps";
    apps.dataset.expose = "core.card.space-apps";
    apps.type = "button";
    apps.title = "스페이스 앱";
    apps.setAttribute("aria-label", apps.title);
    apps.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true">' +
      '<path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11"/></svg>';
    bind(apps, "core.space.apps", () => ({ card: el.dataset.cardId }));
    chrome.insertBefore(apps, chrome.firstChild);
  }
  let strip = chrome.querySelector(".chrome__tabs");
  if (!strip) {
    strip = document.createElement("div");
    strip.className = "chrome__tabs";
    ham.after(strip);                                 // Arranged in the order ≡, tab list, tools
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
      // The title is set with `textContent`. User input is not interpreted as markup.
      b.innerHTML = '<span class="tab__name"></span>' +
        '<button class="tab__x" title="닫기" data-expose="core.card.tab-close">&#10005;</button>';
      b.querySelector(".tab__name").textContent = tabName(t);
      // A name longer than the width bound of a tab is cut, so the tooltip shows the whole name.
      b.title = tabName(t);
      // A press selects the tab and starts a drag. The result at the drop position is produced by core.tab.move.
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
    b.dataset.tabState = tabButtonData({ id: b.dataset.tabId }).tabState;
  }
  drawNotices(chrome, tabs);

  if (!acts) {
    acts = createCardTools(card.id);
    chrome.appendChild(acts);
    // The menu button that replaces the tools in a narrow head where the tools do not fit in one row. It is placed after the tools.
    const more = document.createElement("button");
    more.className = "chrome__more";
    more.dataset.expose = "core.card.tools";
    more.type = "button";
    more.title = "카드 도구";
    more.setAttribute("aria-label", more.title);
    more.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true">' +
      '<circle cx="3.5" cy="8" r="1"/><circle cx="8" cy="8" r="1"/><circle cx="12.5" cy="8" r="1"/></svg>';
    bind(more, "core.card.tools", () => ({ card: el.dataset.cardId }));
    chrome.appendChild(more);
  }
  updateCardTools(acts, {
    canClose: grid.canClose(card.id),
    canSplitX: grid.canSplit(card.id, "x"),
    canSplitY: grid.canSplit(card.id, "y"),
    fullscreen: el.dataset.fullscreen === "true",
  });
  drawSideToggles(acts, el, card.id);

  // The slot of a surface. The compositor does not know the structure of the plane, so the needed values are recorded here.
  //
  // The identity of a surface is the tab. If it were the card, the tabs of one card would share one surface, and since a card
  // id has the same value in every space, the same surface would be used even in a different space.
  const slot = el.querySelector(".slot");
  const shown = activeTab(card);
  const paramsProblem = hasPlugin(shown.plugin) ? storedParamsProblem(shown.plugin,
    pluginUnits().find((unit) => unit.id === shown.plugin).version, plugin(shown.plugin).params, shown.params) : null;
  if (!hasPlugin(shown.plugin) || paramsProblem) {
    // The tab of a plugin that is not loaded is a placeholder and not a surface. The surface mark is cleared so the compositor does not treat it as a surface.
    clearSlotSurface(slot);
    for (const key of ["nativeSurface", "nativeSurfaceId", "nativeLayer", "nativePlugin", "nativeTitle", "nativeDim"]) delete slot.dataset[key];
    placePluginPlaceholder(slot, shown.id, pluginPlaceholder(shown, paramsProblem));
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
  // default: a tab opened without parameters mounts with params null.
  const surface = surfaceForTab(shown);
  setSlotSurface(slot, surface);
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
  showTabError(status, shown.id);
}

/* The operation error of the active tab, shown in its card's status row (docs/spec/plugins.md#tab-reports). */
function showTabError(status, tabId) {
  let line = status.querySelector(".status__error");
  if (!line) {
    line = document.createElement("span");
    line.className = "status__error";
    status.appendChild(line);
  }
  const where = `tab error ${tabId}`;
  const text = tabError(tabId);
  if (text !== null) {
    showError(line, where, text);
    return;
  }
  line.hidden = true;
  hideError(line, where);
}

// The last drawn out-of-space fold text of each card. When a tab changes the bottom text, only the foot is fixed and nothing is redrawn.
const cardFolds = new Map();
/** The text of the card content foot: the bottom text announced by the plugin of the active tab, and the side folded because of lack of space (docs/spec/example-model.md). */
function cardStatusText(card, tabs, folded) {
  // default: the foot of a card without tabs, or of a tab that announced no bottom text, is empty text.
  const text = tabs.length ? tabFooter(activeTab(card).id) ?? "" : "";
  return [text, folded].filter((part) => part !== null && part !== "").join(" · ");
}

/* ── Tab of a plugin that is not loaded (docs/spec/plugins.md) ───────────────── */

// The places of the placeholder errors that the current view draw shows, and the places that the previous draw showed (F217).
let placeholderErrorPlaces = new Set();
let shownPlaceholderErrors = new Set();

/** The text of the placeholder for each reason. */
const PLACEHOLDER_LINES = {
  missing: (id) => `${id} 플러그인이 설치되어 있지 않습니다.`,
  disabled: (id) => `${id} 플러그인을 사용하지 않습니다.`,
  reload: (id) => `창을 다시 불러오면 ${id} 플러그인이 열립니다.`,
  host: (id) => `${id} 플러그인은 네이티브 호스트가 있어야 설치됩니다.`,
  unread: (id) => `${id} 플러그인의 설치 상태를 읽지 못했습니다.`,
};

/** The reason of a tab of a plugin that is not loaded. The workbench reads the plugin states before it opens the first space. */
function placeholderReason(id) {
  if (!pluginOperations.hosted) return "host";
  if (pluginOperations.failure()?.kind === "state") return "unread";
  const row = pluginOperations.status().plugins.find((entry) => entry.id === id);
  if (!row?.installed) return "missing";
  return row.installed.enabled ? "reload" : "disabled";
}

/**
 * The placeholder of a tab whose plugin is not loaded, or whose stored params do not match the loaded plugin
 * (paramsProblem). Depending on the reason it has an install or enable button.
 */
function pluginPlaceholder(tab, paramsProblem) {
  const reason = paramsProblem ? "params" : placeholderReason(tab.plugin);
  const el = document.createElement("div");
  el.dataset.pluginPlaceholder = reason;
  el.dataset.plugin = tab.plugin;
  el.style.cssText = "position:absolute;inset:0;display:grid;place-content:center;justify-items:center;gap:10px;color:var(--muted)";
  const line = document.createElement("p");
  const text = reason === "params" ? paramsProblem : PLACEHOLDER_LINES[reason](tab.plugin);
  // The reasons unread and params state a failure (the install state could not be read, or the stored params do not match the declaration),
  // so their lines are errors shown through the error display path (F217). The other reasons are the designed states of a saved layout and stay plain text.
  if (reason === "unread" || reason === "params") {
    const where = `surface ${tab.id} placeholder`;
    showError(line, where, text);
    placeholderErrorPlaces.add(where);
  } else {
    line.textContent = text;
  }
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

// When a plugin state changes, the reason and the button of the placeholder are decided again.
onPluginOperations(() => {
  if (grid && grid.cards.some((card) => tabsOf(card).some((tab) => !hasPlugin(tab.plugin)))) settle();
});

/* ── T5 — closing the card when the last tab moves ─────────────────────────── */

async function closeTab(cardId, tabId) {
  const card = grid.card(cardId);
  if (!card) return;
  if (!tabsOf(card).some((t) => t.id === tabId)) return;
  // The surface is released by the commit of this change after its place succeeds, because the place closes the regions of
  // the surface in the host (docs/spec/native-surfaces.md#region-lifetime); the settled barrier of the command waits for that commit.
  card.data.tabs = tabsOf(card).filter((t) => t.id !== tabId);
  if (card.data.tabs.length === 0) {
    // A card that cannot be closed remains, so one tab is inserted again. Its kind is what the focus was showing, or the first
    // registered plugin if there is none. If a name were written here, this file would have to change each time a plugin is added.
    if (grid.canClose(cardId)) grid.close(cardId);
    // default: as the comment above says, when no plugin is focused, a tab of the first registered plugin is opened.
    // The closed tab leaves no source tab, so the new tab records null, as the released workbench does (docs/spec/projects.md#tab-origin).
    else card.data.tabs = [newTab(focusedPlugin() ?? plugins()[0].id, null, null, "card refill")];
  }
  if (!tabsOf(card).some((t) => t.id === card.data?.activeId)) {
    // default: a card with no tabs left has no active tab (null).
    if (card.data) card.data.activeId = tabsOf(card)[0]?.id ?? null;
  }
  // default: when only place cards remain, there is no card to focus (null).
  if (!grid.card(focusedId)) focusedId = grid.cards.find((c) => !isPlace(c.id))?.id ?? null;
  settle();
}

/* ── Tab drag — T3/T4/T5 ─────────────────────────────────────────────── */

let tabDrag = null;

/* The function to call when the state of a tab drag changes. The public entry registers it. */
let dragChanged = () => {};

/** Registers the function to call when the state of a tab drag changes. */
export function onDrag(fn) {
  dragChanged = fn;
}

/* The drop preview drawn now, in plane coordinates. */
let dropPreview = null;

/** The tab drag in progress: the dragged tab, the origin card, the drop position, and the preview rectangle. */
export const dragState = () => (tabDrag ? {
  tab: tabDrag.tabId, card: tabDrag.cardId, moved: tabDrag.moved,
  target: tabDrag.hit ? { card: tabDrag.hit.id, zone: tabDrag.hit.zone } : null,
  preview: dropPreview,
} : null);

/* The thickness of the card border. The head and the foot are rows inside the border, and zoneAt measures with the rect of
   the card, which includes the border, so the border is added for the zone boundary to stand at the end of the drawn head.
   At the seam the border is 0, so the value is not written but measured from the drawn card. */
const cardBorder = () => {
  const el = plane.querySelector(".card");
  return el ? parseFloat(getComputedStyle(el).borderTopWidth) : 0;
};

/**
 * The height (px) that the drop zones leave to the head and the foot of a card.
 *
 * The plane passes this value to `zoneAt`, and verification compares it with the drawn head and foot. If each computed it
 * alone, a fix in only one place would leave the zones misaligned while verification still passed.
 */
export const dropBands = () => {
  const edge = cardBorder();
  return { headerPx: HEADER + edge, footerPx: FOOTER + edge };
};

function beginTabDrag(e, cardId, tabId) {
  e.preventDefault();
  // The border does not change during one drag, so it is measured once at the start.
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
    // Only a press that moved is a drag. The drop zones are on cards of the ordinary layout, so fullscreen is released then;
    // a press that did not move (a click) keeps fullscreen (docs/spec/example-model.md#card-fullscreen).
    if (!tabDrag.stood) { tabDrag.stood = true; restoreFullscreen(); standIn(true); }
    const host = plane.getBoundingClientRect();
    const only = tabsOf(grid.card(tabDrag.cardId)).length === 1 ? tabDrag.cardId : undefined;
    tabDrag.hit = grid.zoneAt(ev.clientX - host.left, ev.clientY - host.top,
      { headerPx: band.headerPx, footerPx: band.footerPx, centreOnly: only });
    // A drop with no zone is rejected by the layout even if released. That position is not taken.
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

/* ── Picker layer ──────────────────────────────────────────────────────────
   A layer is not a card, so it does not affect the layout and Soksak does not recognize it.
   When the layout changes, the reference position of the layer becomes invalid, so settle closes it first.     */

let picker = null;

/* The state of a surface page (loading, ready, error). It is the same value that the card status line shows. */
const surfaceStates = new Map();
let surfaceStateChanged = () => {};

/** Registers the function to call when a surface state changes. */
export function onSurfaceState(fn) {
  surfaceStateChanged = fn;
}

/** The state {phase, error} of a surface id. A surface with no report yet is loading. */
// default: as the comment above says, a surface that has announced no state is loading.
export const surfaceState = (id) => surfaceStates.get(id) ?? { phase: "loading", error: null };

/* The function to call when the picker layer opens and closes. The public entry registers it. */
let pickerChanged = () => {};

/** Registers the function to call when the picker layer opens and closes. */
export function onPicker(fn) {
  pickerChanged = fn;
}

/** The state of the picker layer. The title and the items are read from the element. */
export const pickerState = () => ({
  open: picker !== null,
  title: picker ? pickerEl.getAttribute("aria-label") : "",
  items: picker ? pickerItems(pickerEl) : [],
  groups: picker ? pickerGroups(pickerEl) : [],
  columns: picker ? picker.columns : { groups: [], items: [] },
});

/* The data-do of a card tool button and the menu value of core.card.menu. */
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
  // The button that opened the layer closes the layer with its own click, so a press on that button is not an outside press.
  // If it were closed here, that click would open the layer again.
  if (picker?.anchor?.contains(e.target)) return;
  return run("core.picker.close");
};
const onPickerKey = (e) => {
  if (e.key !== "Escape") return;
  e.stopPropagation();
  return run("core.picker.close");
};

/** Asks which plugin kind a new tab takes. The + button and the split button share it. */
function openPicker(anchor, what, cardId) {
  openLayer(anchor, PICKER_ASK[what],
    plugins().map((p) => ({ key: p.id, name: p.name, mark: p.mark, svg: p.svg })),
    (k) => (what === "add" ? addTab(cardId, k, null) : splitWith(cardId, TOOL_SPLIT_SIDE[what], k)));
}

/** Asks which tab to activate. It shows the tab list when the header is folded. */
function openTabList(anchor, cardId) {
  const card = grid.card(cardId);
  if (!card?.data) return;
  openLayer(anchor, `탭 ${tabsOf(card).length}개`, tabsOf(card).map((t) => ({
    // The tab of a plugin that is not loaded shows only its name, without a mark.
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
 * It is placed below the reference button and limited to the plane boundary. Nothing can be shown outside the plane.
 *
 * The item name is set with `textContent`. A tab title is user input, so if it were inserted as markup, the title could
 * change the structure of the layer.
 */
function openLayer(anchor, ask, items, pick, align = "right", groups = [{ heading: null, items }]) {
  closePicker("replaced");
  // The window name when the host draws this layer as a window. It is the same value as the visible question.
  pickerEl.setAttribute("aria-label", ask);
  // A list with group titles has many items, so it is drawn taller.
  pickerEl.classList.toggle("picker--grouped", groups.some((group) => group.heading));
  const keys = fillPicker(pickerEl, ask, groups, (b, index, it) => {
    mark(b, "core.picker.pick", { index });
    if (it.notice) {
      b.dataset.notice = "true";
      b.title = systemNotifications.tooltip(it.notice);
    }
  });
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
  picker = { anchor, pick, rect, keys, columns: pickerColumns(pickerEl) };
  pickerChanged();
  // DOM cannot be drawn over a native view, and a web view is a native view that renders DOM. The application receives this
  // element and renders it in such a view, so the surfaces below keep running. The whole element is passed, so the
  // application does not need to know its content.
  if (native) {
    overlay.show(pickerEl, rect, pickerAnswer(keys, run));
    pickerEl.hidden = true;
  } else {
    standIn(true, rect);
  }
  document.addEventListener("pointerdown", onPickerOutside, true);
  document.addEventListener("keydown", onPickerKey, true);
  // The native picker has its own WebView and receives focus when it reports ready. If focus were given here to the now
  // hidden DOM item, the first responder would return to the main WebView, and Escape would be lost before the native picker closes.
  if (!native) {
    // default: a picker with no chosen item focuses the first item.
    (pickerEl.querySelector('.picker__item[data-active=true]') ??
     pickerEl.querySelector(".picker__item"))?.focus();
  }
}

function closePicker(reason) {
  if (!picker) return;
  // The close is an event of the page trace with the reason that closed the layer (docs/spec/performance-trace.md#producers).
  trace("picker.close", { reason });
  // A question that waits for its answer learns that the layer closed without a pick.
  const { dismiss } = picker;
  picker = null;
  pickerChanged();
  pickerEl.hidden = true;
  document.removeEventListener("pointerdown", onPickerOutside, true);
  document.removeEventListener("keydown", onPickerKey, true);
  if (native) overlay.hide(pickerEl);
  else standIn(false);
  // default: only a question that waits for its answer has dismiss; another layer closes without a notice.
  dismiss?.();
}

/** Follow-up of the + button. It adds only a tab and does not change the layout. */
function addTab(cardId, plugin, params) {
  if (view.fullscreenCard !== cardId) restoreFullscreen();
  const card = grid.card(cardId);
  if (!card?.data) return;
  // default: a card without an active tab has no tab to inherit.
  const t = newTab(plugin, params, activeTab(card)?.id ?? null, "new tab");
  card.data.tabs.push(t);
  card.data.activeId = t.id;
  focusedId = cardId;
  settle();
  return t.id;
}

/** Follow-up of the split button. It creates a new card and adds a tab of the selected kind to that card. */
/** The side where the new card is placed: the vertical-line split of the card tools puts it on the right, the horizontal-line split below. */
const SPLIT_SIDES = ["left", "right", "top", "bottom"];
const TOOL_SPLIT_SIDE = { x: "right", y: "bottom" };

function splitWith(cardId, side, plugin) {
  restoreFullscreen();
  const card = grid.card(cardId);
  if (!card?.data) return;
  // default: a card without an active tab has no tab to inherit.
  const t = newTab(plugin, null, activeTab(card)?.id ?? null, "split");
  // When there is no space, splitToward returns null. No tab was removed from the source card, so there is no state to
  // restore.
  const born = grid.splitToward(cardId, side, { data: { tabs: [t], activeId: t.id } });
  if (born) focusedId = born;
  settle();
  return born ? { card: born, tab: t.id } : null;
}

/* Whether the preview is in a view of the host. The view is kept during one drag and only its position is updated.
   Recreating it every frame makes it flicker. */
let dropShown = false;

/**
 * The rectangle of the card that this drop produces. It returns undefined when the layout rejects the operation.
 *
 * The operation runs on a copy of the plane and the result is read. Because it is a copy, the live plane does not change.
 * Computing half of the target card differs from the drawn position: the two cut pieces share the gap between them, so
 * each is not half of the rect, and a move closes first and cuts afterward, so the size of the target differs from before the cut.
 */
function dropRect(fromId, hit) {
  const copy = new Soksak(grid.toJSON(),
    { gap: grid.gap, minSize: grid.minSize, width: grid.width, height: grid.height });
  if (hit.zone === "centre") return copy.rect(hit.id);
  // T5 — a card with only one tab moves as a whole card.
  if (tabsOf(grid.card(fromId)).length === 1) {
    return copy.move(fromId, hit.id, hit.zone) ? copy.rect(fromId) : undefined;
  }
  const born = copy.splitToward(hit.id, hit.zone, {});
  return born === null ? undefined : copy.rect(born);
}

/**
 * Draws the drop preview and returns the drawn rectangle. It returns null when there is nothing to draw.
 *
 * A drop that the layout rejects has no slot to create, so nothing is drawn. If it were drawn, it would mark as a slot a
 * position where releasing does nothing.
 */
function showDrop(fromId, hit) {
  const half = hit && !isPlace(hit.id) ? dropRect(fromId, hit) : undefined;
  if (!half) { hideDrop(); return null; }
  dropPreview = { x: half.x, y: half.y, w: half.w, h: half.h };
  // The preview must be drawn over the surface. When there is a host, it is drawn as a native shape — the fill is
  // translucent, so a web view cannot compose it over a surface. The CSS of this document decides the shape, and its computed
  // values are sent as they are.
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

/** Clears the preview. If the host is drawing it, that shape is removed too. */
function hideDrop() {
  dropPreview = null;
  if (dropShown) {
    shapes.clear("drop");
    dropShown = false;
  }
  dropEl.hidden = true;
}

/**
 * T4 and T5 decide the layout operation.
 * The origin card has 1 tab    → move the card. No empty card remains.            move()
 * It has 2 or more tabs        → keep the card and move only the tab.             splitToward()
 * Because of the first case, move must be one operation and not a combination of close + split.
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
    // default: a card with no tabs left has no active tab (null).
    else if (!tabsOf(from).some((t) => t.id === from.data.activeId)) from.data.activeId = tabsOf(from)[0]?.id ?? null;
    return settle();
  }

  if (tabsOf(from).length === 1) {                               // T5 — nothing is left to keep
    if (fromId === hit.id) return settle();
    grid.move(fromId, hit.id, hit.zone);
    focusedId = fromId;
    return settle();
  }

  from.data.tabs = tabsOf(from).filter((t) => t.id !== tabId);   // T4 — the slot stays and only the tab moves
  if (!tabsOf(from).some((t) => t.id === from.data.activeId)) from.data.activeId = tabsOf(from)[0].id;
  const born = grid.splitToward(hit.id, hit.zone,
    { data: { tabs: [moving], activeId: moving.id } });
  if (born === null) {                                           // If there is no slot, revert
    from.data.tabs.push(moving);
    from.data.activeId = moving.id;
  } else {
    focusedId = born;
  }
  settle();
}

/* ── Card sidebar ─────────────────────────────────────────────────────
   The set and the layout of each side are independent. A sidebar does not change the card size; it divides the content area. */

/** The common size settings of the card sidebars. */
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
  // default: a card with no operated side opens the top or the left first on each axis (empty selection, docs/spec/example-model.md).
  const operated = sidebarOperated.get(card.data) ?? {};
  return presentSidebars(report, rect, { header: HEADER, footer: FOOTER, border: parseFloat(style.getPropertyValue("--bw")),
    divider: parseFloat(style.getPropertyValue("--divider")), minimum: grid.minSize, sidebarMinimum: sidebarDefaults().min },
    operated);
}
// The side that was last clicked or turned off on each axis of each card. When two sides do not fit together, this side
// opens (docs/spec/example-model.md). It is the selection at the moment of display, so it is not stored and is bound to the
// data object of the card. Changing or restoring the layout creates a new data object, so the selection of the previous layout does not remain even for a card with the same id.
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

/** Draws the sidebars on all four sides of the card, and returns the status line text when a side is folded for lack of space (null if none). A side that does not exist takes no space. */
function drawCardSidebars(el, card, rect) {
  // default: a card with no sidebar record has no side folded for lack of space (null).
  if (!card.data) return null;
  const defaults = sidebarDefaults();
  const sets = sidebarSets();
  // The drawing of a layout transaction draws the display state that the transaction used when it predicted the surface
  // positions. If a later size command mixed into the drawing of the previous transaction, the DOM and the native surface would diverge (F33).
  // default: a drawing that was not predicted (a document without a host, a card with no element at prediction time) draws the current state.
  const presentation = transactionSeats?.get(card.id)?.presentation ?? cardSidebars(card, rect);
  for (const side of SIDEBAR_SIDES) {
    const existing = el.querySelector(`:scope > .card-sidebar[data-side-of="${side}"]`);
    // default: a side with no display state has no sidebar.
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
      // A sidebar ends with a status line that describes its own side and set (docs/spec/example-model.md).
      body.innerHTML = '<div class="set"></div><footer class="card-sidebar__status" data-expose="core.card.sidebar.status"></footer>';
      const handle = document.createElement("div");
      handle.className = "card-sidebar__grip";
      handle.dataset.sideOf = side;
      handle.dataset.expose = "core.card.sidebar.grip";
      body.appendChild(handle);
      // What follows the drawing area is the sidebar frame and not a surface, so it is placed at the end of the card and not after .slot.
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
    // default: a sidebar section of a card with no tabs has no surface context (null) — it is the same context as the left window sidebar.
    const surface = activeTab(card) === null || activeTab(card) === undefined ? null : activeTab(card).id;
    drawSet(body.querySelector(".set"), `${card.id}:${side}`, set, { card: card.id, surface, orientation: side === "top" || side === "bottom" ? "horizontal" : "vertical" });
  }
  return spaceFoldText(presentation);
}

/**
 * Removes the fixed slot.
 *
 * `fixed` means that the layout neither moves nor closes that card, so it is released before removal.
 * `canClose` always returns false for a `fixed` card.
 */
function dismiss(id) {
  if (!grid.card(id)) return;
  grid.setFixed(id, false);
  if (!grid.close(id)) { grid.setFixed(id, true); throw new Error(`cannot remove window sidebar ${id}`); }   // If it could not be removed, the role stays as it was
  // After a card is closed, nothing references the lines that card referenced. The library leaves such lines and leaves the time
  // of their removal to the host. If they remain, an expanded card does not cross such a line and `standings` does not return
  // it as a candidate, and when the sidebar opens again a new line is added, so lines accumulate in the same slot.
  grid.tidy();
}

/**
 * Adds or removes the sidebar at the end of the plane. The left and the right behave the same, so they use the same
 * function.
 *
 * It uses `insertAt` and not `splitToward`. A split inherits the row range of the split card and occupies only one row,
 * but a sidebar must span the plane.
 */
function settle() {
  if (!grid) return;
  closePicker("settled");
  arrangeWindowSidebars(grid, windowSidebarCards(pluginUnits(), value("links"), focusedPlugin()), windowSidebars,
    value("sidebarWidth"), side => value(side), dismiss);
  // default: when only place cards remain, there is no card to focus (null).
  if (!grid.card(focusedId)) focusedId = grid.cards.find((c) => !isPlace(c.id))?.id ?? null;
  view.render();
  syncBackgroundSessions();
}

/* The scrollend wait in progress. The next request cancels the previous wait. */
const landing = new WeakMap();

// A persistent surface actor is owned by the window sidecar and not by a native image surface.
// So a hidden tab keeps its session without creating a WebView or an image region.
const backgroundSessions = new Map();

// The last decision recorded for each tab with a background declaration, so a settle that changes nothing records nothing.
const backgroundDecisions = new Map();

/**
 * Records a decision of the background session of a tab (F192): `open` and `reopen` send the declared operation, `skip` sends
 * nothing for a tab whose surface is mounted, `stop` ends the session of a tab whose surface mounted. `surface` is `mounted`
 * or `absent`. A reopen is recorded each time, because each one sends.
 */
function recordBackground(tab, descriptor, action, surface) {
  const decision = `${action}:${surface}`;
  if (action !== "reopen" && backgroundDecisions.get(tab.id) === decision) return;
  backgroundDecisions.set(tab.id, decision);
  emitEvent("info", "page.background.session", { tab: tab.id, plugin: tab.plugin, sidecar: descriptor.sidecar, action, surface });
}

function syncBackgroundSessions() {
  if (!native || !grid) return;
  const tabs = new Map();
  for (const card of grid.cards) for (const tab of tabsOf(card)) tabs.set(tab.id, tab);
  for (const tab of tabs.values()) {
    // The tab of a plugin that is not loaded has no background session.
    const descriptor = hasPlugin(tab.plugin) ? plugin(tab.plugin).background : null;
    if (!descriptor || tabs.get(tab.id) !== tab) continue;
    const owner = grid.cards.find((card) => tabsOf(card).some((item) => item.id === tab.id));
    const active = owner?.data?.activeId === tab.id;
    const surface = mountedSurface(tab.id) ? "mounted" : "absent";
    // A shown tab and a tab whose surface stays mounted while another tab of its card is shown own their session through the
    // surface, which opened it with its image region. A background open for them would be a second owner of the same surface,
    // and a reconnection would send it again, so the background session of such a tab ends and none opens (F192).
    if (active || surface === "mounted") {
      const session = backgroundSessions.get(tab.id);
      if (session) {
        stopBackground(session);
        backgroundSessions.delete(tab.id);
        recordBackground(tab, descriptor, "stop", surface);
      } else if (!active) {
        recordBackground(tab, descriptor, "skip", surface);
      }
      continue;
    }
    if (backgroundSessions.has(tab.id)) continue;
    recordBackground(tab, descriptor, "open", surface);
    const port = windowSidecar(descriptor.sidecar);
    if (!port) throw new Error(`background sidecar unavailable: ${descriptor.sidecar}`);
    const state = { stop: null, stopped: false };
    backgroundSessions.set(tab.id, state);
    // The manifest states the operation. The sidecar transport keeps the existing wire field `op`, and this location is the
    // only protocol conversion point.
    // The request fields declared by background.settings receive the current values of the settings of that plugin.
    const open = () => {
      const values = pluginSettings(tab.plugin);
      // default: background.settings is an optional field, and when it is absent no setting value is added (docs/spec/plugins.md).
      const fields = Object.fromEntries(Object.entries(descriptor.settings ?? {}).map(([field, setting]) => [field, values[setting]]));
      return port.send(tab.id, { ...fields, operation: descriptor.operation });
    };
    Promise.resolve(port.on(tab.id, (body) => {
      // When the connection of a persistent sidecar is made again, the background session is opened again — the respawned
      // service does not have that session (V5-106). A failure notification is left as a session error.
      if (state.stopped) return;
      if (body?.event === "connection") {
        if (body.connected === true) {
          recordBackground(tab, descriptor, "reopen", mountedSurface(tab.id) ? "mounted" : "absent");
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
    })).then((stop) => {
      // A session that stopped before its subscription finished ends the subscription as soon as it exists.
      if (state.stopped) stop();
      else state.stop = stop;
    }, (error) => {
      report(`background session ${tab.id} listener failed: ${error.message}`);
    });
    open().catch((error) => {
      if (backgroundSessions.get(tab.id) === state) backgroundSessions.delete(tab.id);
      report(`background session ${tab.id} open failed: ${error.message}`);
    });
  }
  for (const [tabId, state] of backgroundSessions) {
    if (tabs.has(tabId)) continue;
    stopBackground(state);
    backgroundSessions.delete(tabId);
  }
  for (const tabId of backgroundDecisions.keys()) if (!tabs.has(tabId)) backgroundDecisions.delete(tabId);
}

/** Ends a background session: its listener stops now, or when its subscription finishes if that has not happened yet. */
function stopBackground(state) {
  state.stopped = true;
  // default: the subscription finishes asynchronously, so before that there is no function to stop yet; the subscription
  // stops itself when it finishes, because the session is marked stopped.
  state.stop?.();
}

/**
 * Scrolls the active tab to the center of the tab list.
 *
 * Animation is used only when the user selected the tab. When a layout change recomputes the center, it moves
 * immediately. During a divider drag the width changes every frame, so starting a new animation each time never reaches the
 * target position.
 *
 * `behavior:"smooth"` is handled by the browser, and when the window is inactive the animation does not run and the
 * request is ignored. When the scroll ends, scrollend fires; then it checks whether the target was reached, and moves
 * immediately if it was not.
 */
function centreTab(strip, activeId) {
  const active = strip.querySelector(".tab[data-active=true]");
  if (!active) { strip.scrollLeft = 0; return; }
  const room = strip.scrollWidth - strip.clientWidth;
  // It is computed from the difference of two rects. `offsetLeft` is relative to the offsetParent, and the tab list is
  // static, so the reference becomes the card and an error of the left and right padding of the header arises.
  const a = active.getBoundingClientRect(), box = strip.getBoundingClientRect();
  const to = room <= 0 ? 0 : Math.max(0, Math.min(
    strip.scrollLeft + (a.left + a.width / 2) - (box.left + box.width / 2), room));
  const picked = strip.dataset.centred !== String(activeId);
  // default: a card with no active tab has no centered tab (empty string).
  strip.dataset.centred = String(activeId ?? "");
  landing.get(strip)?.abort();                        // Cancel the previous wait
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
 * Measures the header width and decides the display stage.
 *
 * Before measuring, it returns to the strip stage and the tool row so all tabs and tools are shown. Measuring in the
 * folded state yields the folded width, and if the stage were decided again from that value, a header folded once could not
 * return even after it widened. No rendering happens between the two writes, so nothing appears on the screen.
 *
 * If the tools do not fit with the current tab title, the tool row folds into the ⋯ menu (F81). The title stays longer
 * than the tools.
 */
// PEEK    the spare width other than the active tab that is needed to keep the strip stage
// MIN_TAB the minimum width of an active tab that is truncated with an ellipsis. Narrower than this, it drops to the ham stage
const PEEK = 56, MIN_TAB = 48;

function fitChrome(chrome, strip) {
  const acts = chrome.querySelector(".chrome__acts");
  if (!acts) return;
  // To measure at every stage, it starts with all tabs and the tool row shown.
  chrome.dataset.fit = "strip";
  chrome.dataset.tools = "bar";
  // The side margins of the head, the gap between the elements inside it, and the widths of ≡ and ⋯ are decided by the
  // stylesheet, so they are obtained by measuring. If they were written here, they would diverge from the stylesheet, and the
  // width at which the header folds would shift by that difference. It is the same reason as measuring the gap between tabs.
  const head = getComputedStyle(chrome);
  // default: the computed value normal of columnGap is not a number and is 0 in flex.
  const gap = parseFloat(head.columnGap) || 0;
  // The head starts with ≡, or with the space app button in a fullscreen card, so it is fitted at a width reduced by the width
  // of that button.
  const apps = chrome.querySelector(".chrome__apps");
  const lead = parseFloat(getComputedStyle(chrome.closest(".card")?.dataset.fullscreen === "true" && apps
    ? apps : chrome.querySelector(".chrome__ham")).width) + gap;
  const inner = chrome.clientWidth
    - parseFloat(head.paddingLeft) - parseFloat(head.paddingRight) - lead;
  // ⋯ is not drawn in the bar stage, so the declared width is read and not the rect.
  const more = parseFloat(getComputedStyle(chrome.querySelector(".chrome__more")).width);
  const tools = acts.getBoundingClientRect().width;

  const tabs = [...strip.querySelectorAll(".tab")];
  const active = strip.querySelector(".tab[data-active=true]");
  const activeW = active ? active.getBoundingClientRect().width : 0;
  // The gap between tabs is a value that the tab list holds.
  // default: the computed value normal of columnGap is not a number and is 0 in flex.
  const between = parseFloat(getComputedStyle(strip).columnGap) || 0;
  const whole = tabs.reduce((n, t) => n + t.getBoundingClientRect().width, 0)
    + Math.max(0, tabs.length - 1) * between;
  // The head folds in this order: the other tabs, the tools (into a menu) down to the minimum width of the title, then the title. The first stage whose preceding stage fits is used.
  const withTools = inner - tools - gap;
  const withMenu = inner - more - gap;
  const [fit, folded] =
    withTools >= Math.min(whole, activeW + PEEK) ? ["strip", "bar"]
    : withTools >= activeW ? ["one", "bar"]
    : withMenu >= Math.min(activeW, MIN_TAB) ? ["one", "menu"]
    : ["ham", "menu"];
  chrome.dataset.fit = fit;
  chrome.dataset.tools = folded;
}

/* It measures after the render completes. Measuring before the width is updated computes a wrong position.
   It does not scroll during a tab drag. The coordinates of the dragged tab would be misaligned. */
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
 * The focus mark is placed in the body area of the focused card, outside it by the stroke width.
 *
 * If it fit the body, the mark would overlap the native surface and hide the surface content. When it is outside by the
 * stroke width, the stroke lies outside the surface boundary and does not cover the body. The stylesheet decides that
 * thickness, so it is obtained by measuring.
 *
 * It is placed in the same layer as the surface and not inside the card. A surface does not take part in the CSS stack, so a
 * mark drawn inside the card is hidden under the surface in the application.
 */
function markFocus() {
  const mark = document.getElementById("focusMark");
  const on = value("focusInd") === "corner";
  // A slot is per tab and focus is per card. The active tab of the focused card is the slot of that card.
  const card = on ? grid.card(focusedId) : null;
  const shown = card ? activeTab(card) : null;
  const slot = shown
    ? plane.querySelector(`[data-native-surface-id="${shown.id}"][data-native-surface]`)
    : null;
  if (!slot) { mark.hidden = true; return; }
  const host = plane.getBoundingClientRect();
  const r = slot.getBoundingClientRect();
  // The mark stands outside by the stroke width. The stylesheet decides that thickness, so it is obtained by measuring.
  const out = parseFloat(getComputedStyle(mark).getPropertyValue("--t"));
  mark.style.left = `${r.left - host.left - out}px`;
  mark.style.top = `${r.top - host.top - out}px`;
  mark.style.width = `${r.width + out * 2}px`;
  mark.style.height = `${r.height + out * 2}px`;
  mark.hidden = false;
}

/* The rail outline drawn last. The verifier reads it. */
let railShape = { shape: { path: "", loops: [], corners: 0, sharp: 0 }, rects: [], groups: [] };

/** The rail outline drawn last and its target rectangle. */
export const railOutline = () => railShape;

function drawRail() {
  const sidebars = railSidebars(windowSidebarCards(pluginUnits(), value("links"), focusedPlugin()), id => grid.card(id));
  // The merge is decided by the pad of half a gap, and the merged outline is reduced by half of the line width so the line is drawn on whole pixels inside the half gap.
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


/* The render-completion receiver. Verification and reporting connect to it. */
let listener = null;

/** Registers the function to call each time the plane is redrawn. */
export function onRender(fn) {
  listener = fn;
}

/* The receiver for when the layout is decided to change. It is called before drawing. */
let layouter = null;
/* The per-card slots and the sidebar display state that the layout transaction being drawn predicted. It is null outside drawing. */
let transactionSeats = null;

/**
 * Registers the function to call before the layout is rendered.
 *
 * Above the plane there are OS views to which CSS does not apply, and they are placed through a separate path. That path is
 * slower, so it is handled first. If draw is called after the OS view is moved to the received rectangle, both are reflected
 * in the same frame. When nothing is registered, the plane renders immediately.
 */
export function onLayout(fn) {
  layouter = fn;
}

/**
 * The surfaces this plane will seat: for each card id, the id of the tab that card will show and whether it is dimmed.
 *
 * The identity of a surface is the tab, so when the tab shown by a card changes, a different surface is seated in the same
 * position. The DOM before drawing still holds the previous tab, and reading only that would tell the host to seat the old
 * surface in the new layout. Dimming is passed here for the same reason. Focus already moved before drawing, so reading it
 * from the DOM would publish the dimming of the previous focus.
 */
function seats(rects) {
  const out = new Map();
  for (const card of grid.cards) {
    if (isPlace(card.id)) continue;
    const el = cardElement(card.id);
    const slot = el?.querySelector(":scope > .slot[data-native-surface]");
    let inset = null;
    // The width of the bands on all four sides used for the prediction. Verification V7c compares it with the drawn bands to find the cause of a mismatch (F33).
    let bands = null;
    // The sidebar display state used for the prediction. The drawing of this transaction draws the same state.
    // default: a card with no element yet is not predicted, so it has no display state (null).
    const presentation = el && card.data ? cardSidebars(card, rects.get(card.id)) : null;
    if (slot) {
      const folded = parseFloat(getComputedStyle(el).getPropertyValue("--divider"));
      if (!Number.isFinite(folded) || folded < 0) throw new Error("invalid sidebar divider width");
      // default: a card with no sidebar record has no sidebar.
      const effective = presentation ?? {};
      bands = Object.fromEntries(SIDEBAR_SIDES.map(side => {
        const state = effective[side];
        return [side, state ? (state.collapsed ? folded : deviceGridSize(state.shownSize, devicePixelRatio)) : 0];
      }));
      inset = targetCardInsets(el, slot, bands);
    }
    out.set(card.id, { id: activeTab(card).id, dim: dimmed(card.id), inset, bands, presentation });
  }
  return out;
}

function restoreWindowState(kept) {
  checkStoredLayout(kept);
  return restoreWindowSidebars(Object.hasOwn(kept, "windowSidebars") ? kept.windowSidebars : {});
}

/** Each refused view tab is logged; its text is also shown on the tab (docs/spec/projects.md#tab-origin). */
function logRefusals(refused) {
  for (const { text } of refused) report(text);
}

/** Rebuilds the plane from the start. */
function build(kept) {
  const restored = restoreWindowState(kept);
  logRefusals(recordStoredOrigins(kept));
  view?.destroy();
  named = kept.named;
  // The tab and the folded sections chosen for each sidebar. A layout without sidebars has no stored selection (docs/spec/projects.md#persistence).
  // default: a stored layout without sidebars has no stored selection (docs/spec/projects.md#persistence).
  restoreSidebarChoices(Object.hasOwn(kept, "sidebars") ? kept.sidebars : {});
  windowSidebars = restored;
  const half = halfGap();
  grid = new Soksak(kept.state, { gap: half * 2 });
  focusedId = kept.focusedId;
  view = new SoksakView(plane, grid, {
    createCard, updateCard,
    // The plane is inset inside the stage by this value. Only the host knows the value, so it must be passed to the view so
    // that lines touching the plane edge continue to the stage boundary.
    bleed: stagePad(),
    // Drawing writes the frame scale of the current settings into the document. Preparation includes the first-row height at
    // that scale, so the host decides the window title bar in the same transaction (docs/spec/native-surfaces.md#title-bar-height).
    commit: (made, draw) => {
      const factor = value("textSize");
      if (!layouter) {
        applyFrameText(factor);
        return draw();
      }
      const seated = seats(made);
      return layouter(made, () => {
        applyFrameText(factor);
        transactionSeats = seated;
        try {
          draw();
        } finally {
          transactionSeats = null;
        }
      }, seated, chromeRow(factor));
    },
    // The render of the plane consists of what the view draws and what this document draws. onChange fires right after the
    // view draws, so the rest is drawn here and the receiver is called afterward.
    onChange: (reason) => {
      // The view creates the grab area of a boundary line. The name is attached here.
      for (const divider of plane.querySelectorAll(".sp-divider:not([data-expose])")) {
        divider.dataset.expose = "core.divider";
      }
      markFocus();
      // A placeholder error that this draw does not show again is withdrawn: its surface left, or its plugin state was read again (F217).
      for (const where of shownPlaceholderErrors) if (!placeholderErrorPlaces.has(where)) hideError(null, where);
      shownPlaceholderErrors = placeholderErrorPlaces;
      placeholderErrorPlaces = new Set();
      // Clears the notification of a tab that became visible.
      clearVisibleNotices();
      centreTabs();
      railShape = drawRail();
      // When a tab moves to another card or the card scale changes, the actual scale of the surface changes.
      notifyTextSize();
      // default: a drawing before onRender registers the receiver has nowhere to report to.
      listener?.(reason);
    },
  });
  settle();
}

/** Puts a dot and a tooltip on the tab with a notification and on the tab list button of a card that has such a tab. */
function drawNotices(chrome, tabs) {
  for (const b of chrome.querySelectorAll(".chrome__tabs .tab[data-tab-id]")) {
    const notice = tabNotice(b.dataset.tabId);
    if (notice) {
      b.dataset.notice = "true";
      b.title = systemNotifications.tooltip(notice);
    } else if (b.dataset.notice) {
      // Without a notice the tooltip shows the whole name of the tab again.
      delete b.dataset.notice;
      b.title = b.querySelector(".tab__name").textContent;
    }
  }
  const ham = chrome.querySelector(".chrome__ham");
  if (!ham) return;
  const notices = tabs.map((t) => tabNotice(t.id)).filter(Boolean);
  if (notices.length) ham.dataset.notice = "true";
  else delete ham.dataset.notice;
  ham.title = notices.length ? systemNotifications.tooltip(notices.join("\n")) : "탭 목록";
}

// A visible tab means the active tab of the focused card. No notification is kept for that tab.
setVisibleTab((id) => {
  const card = grid?.card(focusedId);
  return Boolean(card?.data) && activeTab(card)?.id === id;
});

// When a surface announces a tab title or a notification, only the tab name and the dot are rewritten. The layout does not change, so nothing is redrawn or stored.
// When the system notification permission changes, the notification tooltip is rewritten too.
const redrawTabReports = () => {
  for (const el of document.querySelectorAll(".card[data-card-id]")) {
    const card = grid?.card(el.dataset.cardId);
    const chrome = el.querySelector(".chrome");
    if (!card?.data || !chrome) continue;
    for (const name of chrome.querySelectorAll(".tab[data-tab-id] .tab__name")) {
      const t = tabsOf(card).find((item) => item.id === name.parentElement.dataset.tabId);
      if (!t) continue;
      // The name and the memory saver state (docs/spec/exposure.md#tab-memory); an unloaded tab keeps its label.
      const data = tabButtonData(t);
      name.textContent = data.name;
      name.parentElement.dataset.tabState = data.tabState;
    }
    drawNotices(chrome, tabsOf(card));
    const statusText = el.querySelector(":scope > .status .status__text");
    // default: a card not drawn yet has no folded-side text.
    if (statusText && !isPlace(card.id)) setText(statusText, cardStatusText(card, tabsOf(card), cardFolds.get(card.id) ?? null));
    if (statusText && !isPlace(card.id) && tabsOf(card).length) showTabError(statusText.parentElement, activeTab(card).id);
  }
};
onTabReports(redrawTabReports);
systemNotifications.onChange(redrawTabReports);

// The title of a system notification is the tab name, and a pressed notification selects that tab through a declared command.
configureSystemNotifications({
  tabName: (id) => {
    const card = grid?.card(cardOfTab(id)?.id);
    const t = card ? tabsOf(card).find((item) => item.id === id) : null;
    return t ? tabName(t) : id;
  },
  select: (id) => run("core.tab.select", { tab: id }),
});

/** Applies the gap value to the plane and the view. */
export function setGap(half) {
  if (!grid) return;
  grid.gap = half * 2;
  view.bleed = stagePad();
  // The gap is also the inner margin of the stage, so the plane size changes when the gap changes. If the code waited for the
  // observer, a render in the meantime would draw with the previous size and pass that value to the surface too.
  // The frame scale is written into the document by the next drawing, so the plane size is measured at that scale (frame-text.js).
  const [width, height] = measureAt(value("textSize"), () => [plane.clientWidth, plane.clientHeight]);
  grid.resize(width, height);
}

/**
 * Returns the current plane state as one set. The space stores this value.
 *
 * The layout, the focus, and the widths of the fixed window sidebars are values of the space.
 * The plane draws one space at a time.
 */
export const capture = (path = null) => {
  keepWindowSidebarWidths(grid.cards, windowSidebars);
  const displayed = grid.toJSON();
  // A write names its writing path, and each view tab that it stores without an origin member is recorded (docs/spec/projects.md#tab-origin).
  for (const text of missingOriginRecords(displayed, path)) report(text);
  return {
    // Each content-card tab stores its origin with the layout (docs/spec/projects.md#tab-origin).
    state: storedLayoutState(displayed), focusedId,
    windowSidebars: structuredClone(windowSidebars),
    named, sidebars: sidebarChoices(),
  };
};

/** Applies one stored set of state to the plane. */
export function adopt(kept) {
  if (!grid) return build(kept);
  const restored = restoreWindowState(kept);
  logRefusals(recordStoredOrigins(kept));
  grid.replace(kept.state);
  focusedId = kept.focusedId;
  windowSidebars = restored;
  named = kept.named;
  // default: a stored layout without sidebars has no stored selection (docs/spec/projects.md#persistence).
  restoreSidebarChoices(Object.hasOwn(kept, "sidebars") ? kept.sidebars : {});
  settle();
}

/** Returns an empty space state. A new space starts with this value. */
export const fresh = () => ({
  state: initial(),
  focusedId: environment().workspace.focus,
  windowSidebars: Object.fromEntries(environment().workspace.grid.cards
    .filter(card => card.id === "left" || card.id === "right")
    // default: a fixed sidebar whose width the environment declaration omits starts with the width of the sidebarWidth setting.
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

/* ── Operations that commands call ────────────────────────────────────────────────────
   A UI element runs a command, and the command calls the operations below. An invalid target is reported by an exception. */

/** An ordinary card of the plane. It throws an exception if there is none or it is a place card. */
function paneCard(id) {
  const card = grid?.card(id);
  if (!card || isPlace(id)) throw new Error(`no card ${id}`);
  return card;
}

/** A card with tabs. It throws an exception if there is none. */
function cardOfTab(tabId) {
  const card = grid?.cards.find((c) => tabsOf(c).some((t) => t.id === tabId));
  if (!card) throw new Error(`no tab ${tabId}`);
  return card;
}

function knownPlugin(id) {
  if (!plugins().some((p) => p.id === id)) throw new Error(`unknown plugin ${id}`);
}

/** The element of a card. The tool buttons and the tab list button are inside it. */
const cardElement = (id) => plane.querySelector(`.card[data-card-id="${CSS.escape(id)}"]`);

// default: it is null when there is no fullscreen card.
export const fullscreenCard = () => plane.querySelector('.card[data-fullscreen="true"]')?.dataset.cardId ?? null;
export const presentedCardRect = (id) => view?.painted(id);

/**
 * Refuses a change of the layout from the card tools while a card is fullscreen (docs/spec/example-model.md#card-fullscreen):
 * adding a tab, splitting and closing wait until the arrangement is restored.
 */
function layoutChangeable(id) {
  const shown = fullscreenCard();
  if (shown !== null) throw new Error(`card ${id}: the layout does not change while card ${shown} is fullscreen; restore the arrangement first`);
}

function restoreFullscreen() {
  if (view?.fullscreenCard !== null && view?.fullscreenCard !== undefined) view.fullscreen(null);
}

export function toggleCardFullscreen(id) {
  paneCard(id);
  focusedId = id;
  closePicker("fullscreen");
  view.fullscreen(view.fullscreenCard === id ? null : id);
}

export function focusCard(id) {
  paneCard(id);
  if (view.fullscreenCard !== id) restoreFullscreen();
  focusedId = id;
  settle();
}

/** Opens the add and split menu of a card. If the same menu is open, it closes it. */
export function openCardMenu(id, menu) {
  paneCard(id);
  layoutChangeable(id);
  const what = DO_OF[menu];
  if (!what) throw new Error(`unknown menu ${menu}`);
  const anchor = cardElement(id)?.querySelector(`.chrome__act[data-do="${what}"]`);
  if (!anchor) throw new Error(`card ${id} has no ${menu} button`);
  if (anchor.disabled) throw new Error(`card ${id} cannot ${menu}`);
  if (picker?.anchor === anchor) { closePicker("toggle"); return; }
  focusedId = id;
  settle();
  openPicker(anchor, what, id);
}

/**
 * Opens the tool menu of a card. If it is open, it closes it. The menu lists the sidebar buttons that will be visible in
 * the head and the active tools in the same order, and the chosen item runs the same command as that button. Adding a tab
 * and splitting ask for the plugin of the new tab under the same button.
 */
export function openCardTools(id) {
  paneCard(id);
  const anchor = cardElement(id)?.querySelector(".chrome__more");
  if (!anchor) throw new Error(`card ${id} has no tool menu button`);
  if (picker?.anchor === anchor) { closePicker("toggle"); return; }
  const acts = cardElement(id).querySelector(".chrome__acts");
  const items = [...acts.querySelectorAll(".chrome__act")].filter((b) => !b.disabled).map((b) => ({
    // A sidebar button has no data-do and points to a side with data-side.
    key: b.classList.contains("chrome__side") ? `side-${b.dataset.side}` : b.dataset.do,
    name: b.title.split(" — ")[0],
    mark: "",
    svg: b.querySelector("svg").innerHTML,
    viewBox: b.querySelector("svg").getAttribute("viewBox"),
    active: b.getAttribute("aria-pressed") === "true",
  }));
  focusedId = id;
  settle();
  openLayer(anchor, "카드 도구", items, (key) => {
    if (key.startsWith("side-")) return run("core.card.sidebar.toggle", { card: id, side: key.slice(5) });
    if (key === "fullscreen") return run("core.card.fullscreen", { card: id });
    if (key === "close") return run("core.card.close", { card: id });
    return openPicker(anchor, key, id);
  });
}

/**
 * Opens the space app list of a fullscreen card. If it is open, it closes it. The list groups all tabs of the space by
 * content card, the groups are in the order of reading the slicing tree of the layout from the start of the plane, and the
 * title shows the plane map, `card N` and the tree depth (docs/spec/example-model.md#card-fullscreen). The chosen tab moves
 * fullscreen to its card.
 */
/**
 * Opens the context menu that the plugin of a surface declares (docs/spec/plugins.md#pluginjson) in the selection layer at x
 * and y of the window; the chosen item runs its command on that surface.
 */
export function openSurfaceMenu(surfaceId, x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`the menu of surface ${surfaceId} needs x and y as numbers`);
  const tab = tabsOf(cardOfTab(surfaceId)).find((t) => t.id === surfaceId);
  const owner = plugin(tab.plugin);
  if (owner.menu === null) throw new Error(`the plugin ${owner.id} of surface ${surfaceId} declares no menu`);
  // The layer is placed below and to the right of the point, as from an anchor of no size there.
  const anchor = { getBoundingClientRect: () => ({ left: x, right: x, top: y, bottom: y }), contains: () => false };
  const items = owner.menu.map((item) => ({ key: item.command, name: item.title, mark: "", svg: "", active: false }));
  openLayer(anchor, owner.name, items, (key) => runOn(key, {}, surfaceId), "left");
}

/**
 * Opens the context menu of a tab in the selection layer at x and y of the window with the items of the tab menu
 * (tab-menu.js); the chosen item runs its declared command (docs/spec/exposure.md#tab-memory).
 */
export function openTabMenu(tabId, x, y, items) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`the menu of tab ${tabId} needs x and y as numbers`);
  const tab = tabsOf(cardOfTab(tabId)).find((t) => t.id === tabId);
  if (items.length === 0) throw new Error(`tab ${tabId} has no menu items`);
  // The layer is placed below and to the right of the point, as from an anchor of no size there.
  const anchor = { getBoundingClientRect: () => ({ left: x, right: x, top: y, bottom: y }), contains: () => false };
  openLayer(anchor, tabName(tab), items, (key) => {
    const item = items.find((entry) => entry.key === key);
    return run(item.command, item.params);
  }, "left");
}

/** A right click on a surface whose plugin declares a menu opens that menu; elsewhere the page menu opens. */
export function onSurfaceContextMenu(event) {
  // The target of a contextmenu event is the element under the pointer; a surface in a shadow root retargets it to its host.
  const host = event.target.closest(".surface-module-host[data-surface]");
  if (!host) return;
  const card = grid?.cards.find((c) => tabsOf(c).some((t) => t.id === host.dataset.surface));
  const tab = card && tabsOf(card).find((t) => t.id === host.dataset.surface);
  if (!tab || !hasPlugin(tab.plugin) || plugin(tab.plugin).menu === null) return;
  event.preventDefault();
  return run("core.surface.menu", { surface: host.dataset.surface, x: event.clientX, y: event.clientY });
}

export function openSpaceApps(id) {
  paneCard(id);
  if (view.fullscreenCard !== id) throw new Error(`card ${id} is not fullscreen`);
  const anchor = cardElement(id)?.querySelector(".chrome__apps");
  if (!anchor) throw new Error(`card ${id} has no space apps button`);
  if (picker?.anchor === anchor) { closePicker("toggle"); return; }
  const cards = grid.cards.filter((card) => card.data);
  const tree = sliceTree(cards);
  if (!tree) throw new Error("the cards of the space are not a slicing arrangement");
  const rects = grid.rects();
  const map = (own) => cards.map((card) => {
    const r = rects.get(card.id);
    const sx = 16 / grid.width;
    const sy = 10 / grid.height;
    return `<rect x="${(r.x * sx).toFixed(2)}" y="${(r.y * sy).toFixed(2)}" width="${(r.w * sx).toFixed(2)}" ` +
      `height="${(r.h * sy).toFixed(2)}" rx=".6" data-own="${card.id === own}"/>`;
  }).join("");
  const groups = [];
  // A card stands at the depth of the number of cuts above it minus one. Cards under the same cut have the same depth.
  const walk = (slice, cuts) => {
    if ("card" in slice) {
      const card = slice.card;
      groups.push({
        heading: { id: card.id, name: `카드 ${groups.length + 1}`, depth: Math.max(0, cuts - 1), map: map(card.id) },
        items: tabsOf(card).map((t) => ({
          key: `${card.id}/${t.id}`, name: tabName(t),
          mark: hasPlugin(t.plugin) ? plugin(t.plugin).mark : "?", svg: hasPlugin(t.plugin) ? plugin(t.plugin).svg : "",
          notice: tabNotice(t.id),
          active: card.id === id && t.id === card.data.activeId,
        })),
      });
      return;
    }
    for (const side of slice.sides) walk(side, cuts + 1);
  };
  walk(tree, 0);
  const total = groups.reduce((n, group) => n + group.items.length, 0);
  openLayer(anchor, `스페이스 앱 ${total}개`, [], (key) => {
    const [cardId, tabId] = key.split("/");
    showFullscreen(cardId, tabId);
  }, "left", groups);
}

/** Moves fullscreen to the card cardId and shows its tab tabId. Fullscreen is kept. */
function showFullscreen(cardId, tabId) {
  const card = grid.card(cardId);
  if (!card?.data || !tabsOf(card).some((t) => t.id === tabId)) throw new Error(`no tab ${tabId} in card ${cardId}`);
  card.data.activeId = tabId;
  focusedId = cardId;
  if (view.fullscreenCard !== cardId) view.fullscreen(cardId);
  settle();
}

/** Opens the tab list of a card. If it is open, it closes it. */
export function openCardTabs(id) {
  paneCard(id);
  const anchor = cardElement(id)?.querySelector(".chrome__ham");
  if (!anchor) throw new Error(`card ${id} has no tab list button`);
  if (picker?.anchor === anchor) { closePicker("toggle"); return; }
  openTabList(anchor, id);
}

export function addTabTo(id, kind, params) {
  paneCard(id);
  layoutChangeable(id);
  knownPlugin(kind);
  return addTab(id, kind, checkTabParams(kind, plugin(kind).params, params));
}

export function splitCard(id, side, kind) {
  paneCard(id);
  layoutChangeable(id);
  knownPlugin(kind);
  if (!SPLIT_SIDES.includes(side)) throw new Error(`unknown side ${side}; use left, right, top or bottom`);
  const made = splitWith(id, side, kind);
  if (!made) throw new Error(`card ${id} cannot split toward ${side}`);
  return made;
}

export function closeCard(id) {
  paneCard(id);
  layoutChangeable(id);
  if (!grid.canClose(id)) throw new Error(`card ${id} cannot close`);
  const unsaved = tabsOf(grid.card(id)).find((t) => tabModified(t.id));
  if (unsaved) {
    // Asks about the modified tab first; once it is closed, closing the card asks about the next one or closes it.
    askBeforeClose(id, unsaved, () => closeCard(id));
    return { closed: false };
  }
  restoreFullscreen();
  grid.close(id);
  // default: when only place cards remain, there is no card to focus (null).
  if (!grid.card(focusedId)) focusedId = grid.cards.find((c) => !isPlace(c.id))?.id ?? null;
  settle();
  return { closed: true };
}

/**
 * Asks whether to save, discard or keep the modified tab t of the card cardId (docs/spec/plugins.md#tab-reports).
 * then runs after the tab has closed.
 */
function askBeforeClose(cardId, t, then) {
  const save = plugin(t.plugin).save;
  const items = [
    ...(save ? [{ key: "save", name: "저장하고 닫기" }] : []),
    { key: "discard", name: "저장하지 않고 닫기" },
    { key: "keep", name: "닫지 않기" },
  ];
  // default: a header too narrow for its tabs shows no button for the tab, so the question opens at the card.
  const anchor = cardElement(cardId)?.querySelector(`[data-tab-id="${t.id}"]`) ?? cardElement(cardId);
  openLayer(anchor, `${tabName(t)} 탭에 저장하지 않은 변경이 있습니다`, items, async (key) => {
    if (key === "keep") return;
    if (key === "save") {
      try {
        await registry.run(save, {}, t.id);
      } catch (error) {
        reportError(t.id, `저장하지 못했습니다 · ${save}: ${error.message}`);
        settle();
        return;
      }
      if (tabModified(t.id)) {
        reportError(t.id, `저장하지 못했습니다 · ${save} left the tab modified`);
        settle();
        return;
      }
    }
    await closeTab(cardId, t.id);
    then();
  });
}

/** The answers of the question about a modified tab when a plugin change applies and when the window closes. */
const APPLY = { save: "저장하고 적용", discard: "저장하지 않고 적용", keep: "적용하지 않기" };
const CLOSE = { save: "저장하고 닫기", discard: "저장하지 않고 닫기", keep: "닫지 않기" };

/**
 * Asks for each modified tab of the window whether to save it, discard its changes or keep the page, before the page
 * reloads to apply a plugin change (docs/spec/installation.md#applying-a-change). Resolves true when no tab was kept.
 */
export const settleModifiedTabs = () => settleTabs(APPLY);

/**
 * Asks in the same way before the window closes or the application quits (docs/spec/plugins.md#tab-reports).
 * Resolves true when no tab was kept.
 */
export const settleModifiedTabsToClose = () => settleTabs(CLOSE);

async function settleTabs(words) {
  // The library screen shows no space, so the window has no tab to ask about.
  if (!grid) return true;
  for (const card of grid.cards) {
    for (const t of tabsOf(card)) {
      if (tabModified(t.id) && !(await askModified(card.id, t, words))) return false;
    }
  }
  return true;
}

/** Asks about the modified tab t of the card cardId and resolves true when its changes were saved or discarded. */
function askModified(cardId, t, words) {
  const save = plugin(t.plugin).save;
  const items = [
    ...(save ? [{ key: "save", name: words.save }] : []),
    { key: "discard", name: words.discard },
    { key: "keep", name: words.keep },
  ];
  // default: a header too narrow for its tabs shows no button for the tab, so the question opens at the card.
  const anchor = cardElement(cardId)?.querySelector(`[data-tab-id="${t.id}"]`) ?? cardElement(cardId);
  return new Promise((resolve) => {
    openLayer(anchor, `${tabName(t)} 탭에 저장하지 않은 변경이 있습니다`, items, async (key) => {
      if (key === "keep") return resolve(false);
      if (key === "save") {
        try {
          await registry.run(save, {}, t.id);
        } catch (error) {
          reportError(t.id, `저장하지 못했습니다 · ${save}: ${error.message}`);
          settle();
          return resolve(false);
        }
        if (tabModified(t.id)) {
          reportError(t.id, `저장하지 못했습니다 · ${save} left the tab modified`);
          settle();
          return resolve(false);
        }
      }
      resolve(true);
    });
    // Closing the layer keeps the tab, as the keep answer does.
    picker.dismiss = () => resolve(false);
  });
}

/**
 * Opens the file path, relative to the project root, in the plugin that declares its extension
 * (docs/spec/plugins.md#pluginjson): activates the tab of that plugin with the same path, or adds one to cardId, or to the
 * focused card when cardId is undefined. Returns {card, tab}.
 */
export function openFile(path, cardId) {
  const opener = chooseOpener(plugins().map((entry) => ({ id: entry.id, opens: entry.opens })), path);
  for (const card of grid.cards) {
    const open = tabsOf(card).find((t) => t.plugin === opener && t.params?.path === path);
    if (open) {
      selectTab(open.id);
      return { card: card.id, tab: open.id };
    }
  }
  const target = cardId === undefined ? focusedId : cardId;
  return { card: target, tab: addTabTo(target, opener, { path }) };
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
  const t = tabsOf(card).find((entry) => entry.id === tabId);
  if (tabModified(tabId)) {
    askBeforeClose(card.id, t, () => {});
    return { closed: false };
  }
  restoreFullscreen();
  await closeTab(card.id, tabId);
  return { closed: true };
}

const ZONES = ["centre", "left", "right", "top", "bottom"];

/** Moves a tab to the center or an edge of a card. It is the same as the result of releasing a drag. */
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

/** Chooses one item of the open picker layer. */
export function pickItem(index) {
  if (!picker) throw new Error("no menu is open");
  const key = picker.keys[index];
  if (key === undefined) throw new Error(`the menu has no item ${index}`);
  const { pick } = picker;
  picker.dismiss = null;
  closePicker("pick");
  pick(key);
}

export { closePicker };

/**
 * The sidebar buttons in a card head. One button per side that the card shows is placed before the tools in the order top,
 * bottom, left, right. A button folds or unfolds that side, and is pressed while the side is unfolded. A folded side also remains in the head, so it can be unfolded again (docs/spec/example-model.md).
 */
function drawSideToggles(acts, el, cardId) {
  const shownButtons = [];
  for (const side of SIDEBAR_SIDES) {
    const shown = el.dataset[`sidebar${side[0].toUpperCase()}${side.slice(1)}`];
    let button = acts.querySelector(`.chrome__side[data-side="${side}"]`);
    if (shown === undefined) {
      button?.remove();
      continue;
    }
    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      button.className = "chrome__act chrome__side";
      button.dataset.side = side;
      button.dataset.expose = "core.card.sidebar.fold";
      button.innerHTML = icon(`panel-${side}`);
      bind(button, "core.card.sidebar.toggle", { card: cardId, side });
    }
    button.setAttribute("aria-pressed", String(shown === "open"));
    button.title = `${sideName(side)} 사이드바 ${shown === "open" ? "접기" : "펼치기"}`;
    button.setAttribute("aria-label", button.title);
    shownButtons.push(button);
  }
  // Only a button in the wrong position is moved. insertBefore first removes the button to move from the document, and WebKit
  // does not send the click of a press when the node that received the press is removed (F65). From the back, it checks whether the next sibling of each button is the next button (the tools for the last).
  let next = acts.querySelector(".chrome__act[data-do]");
  for (const button of shownButtons.reverse()) {
    if (button.nextElementSibling !== next) acts.insertBefore(button, next);
    next = button;
  }
}

/** The state of a card tool button: disabled, hidden, and the folding stage of the head. */
export function cardActs(id) {
  const chrome = cardElement(id)?.querySelector(".chrome");
  const acts = chrome?.querySelector(".chrome__acts");
  if (!acts) return null;
  const buttons = Object.fromEntries([...acts.querySelectorAll(".chrome__act[data-do]")].map((b) => [
    ["close", "fullscreen"].includes(b.dataset.do) ? b.dataset.do : MENU_OF[b.dataset.do],
    // A head that folded the tools into a menu does not draw the tool row.
    { enabled: !b.disabled, hidden: b.hidden || chrome.dataset.tools === "menu", title: b.title },
  ]));
  // default: the head of a card whose tab row is not yet fitted is an unfolded strip.
  // default: a card whose head is not yet fitted shows the tools in one row.
  return { ...buttons, fit: chrome.dataset.fit ?? "strip", tools: chrome.dataset.tools ?? "bar" };
}

/** The rail outline and the focus mark. */
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
/** The text size scale of a card. It is 1 when there is no value. */
// default: as the comment above says, a card with no text size scale is 1.
const cardTextSize = (card) => card?.data?.textSize ?? 1;

/** The current scope of the text size (docs/spec/text-size.md#scope). */
export function currentTextScope() {
  return effectiveTextScope(textScope(), focusedId);
}

/** The actual text scale of a surface (tab). It is the frame scale multiplied by the scale of the card that holds the tab. A tab not in the plane is null. */
function surfaceTextSize(surfaceId) {
  const card = grid?.cards.find((item) => tabsOf(item).some((t) => t.id === surfaceId));
  return card ? value("textSize") * cardTextSize(card) : null;
}

setSurfaceTextSize(surfaceTextSize);

/** The text size scale of all cards. */
export function cardTextSizes() {
  // default: before the plane is created there are no cards.
  return Object.fromEntries((grid?.cards ?? []).map((card) => [card.id, cardTextSize(card)]));
}

/**
 * Moves the text size of the current scope in direction. 1 is larger, -1 is smaller, and 0 is the default.
 * The frame scale is a common setting, and the card scale is stored in the layout data of the card.
 */
export async function changeTextSize(direction, actor) {
  const scope = currentTextScope();
  if (scope.kind === "frame") {
    await setSetting({ textSize: nextTextSize(value("textSize"), direction) }, "common", actor);
    return;
  }
  const card = grid?.card(scope.card);
  if (!card) throw new Error(`text size card ${scope.card} is not in the layout`);
  // default: a place card has null data, so it holds only the text size.
  grid.setData(card.id, { ...(card.data ?? {}), textSize: nextTextSize(cardTextSize(card), direction) });
  settle();
}

/** The id of the focused card. */
export const focused = () => focusedId;
