// One plane. It handles cards, tabs, dragging, the rail, the picker layer, and rendering.
//
// It records the position of a surface in the slot element inside a card and asks the surface to hide when DOM is drawn
// over it. It does not know how a surface is measured and reported.
//
// It does not know that verification exists. It only announces that rendering finished, and the document decides what follows.
import { Soksak, SoksakView, outline } from "soksak";
import { appliedPatch, borderWidth, cardRadius, halfGap, linkedSet, pluginSettings, seam, set as setSetting, stagePad, value } from "./settings.js";
import { effectiveTextScope, keepCardScope, nextTextSize, notifyTextSize, setSurfaceTextSize, setTextScope, textScope } from "./text-size.js";
import { applyFrameText, chromeRow, measureAt } from "./frame-text.js";
import { alignPlane, gridScale } from "./device-grid.js";
import { CHROME, gripMetrics, placeFocusMark } from "./chrome-metrics.js";
import { activeTab, appendTab, cardTextSize, removeTab, settleActiveTab, tabDescription, tabsOf } from "./card-data.js";
import { fitHead } from "./head-fit.js";
import { hasPlugin, isPlace, plugin, plugins } from "./registry.js";
import { sectionSurfaceShown } from "./section-surfaces.js";
import { clearSet, drawSet, restoreSidebarChoices, sidebarChoices } from "./sidebar-sections.js";
import { bindSidebarGrip } from "./sidebar-grip.js";
import { targetCardInsets } from "./card-insets.js";
import { CARD_TOOL_MENUS, createCardTools, updateCardTools } from "./card-tools.js";
import { SIDEBAR_SIDES, deviceGridSize, presentSidebars, effectiveSidebar, resolveSidebarSet, setSidebar, sideName, sizeSidebar, spaceFoldText, toggleSidebar } from "./card-sidebars.js";
import { arrangeWindowSidebars, SIDE_NAMES, FOLD_ICONS, keepWindowSidebarWidths, railSidebars, restoreWindowSidebars, sizeKey, standingLink, windowOrientation, windowSidebar, windowSidebarCards } from "./window-sidebars.js";
import { environment, pluginUnits } from "./environment.js";
import { checkStoredLayout, recordStoredOrigins } from "./stored-layout.js";
import { cardNumber, memberId, readGroupTree, targetIds } from "./group-tree.js";
import { drawGroupCards } from "./group-cards.js";
import { checkTabParams, storedParamsProblem } from "./tab-params.js";
import { checkOpenPath, chooseOpener } from "./file-open.js";
import { layoutTree, sameJson, stateCards } from "./layout-tree.js";
import { buildTree, planArrangement, readingOrder, treeCards, treeGroups } from "./layout-plan.js";
import { recordClosedTabs, tabClosed } from "./closed-tabs.js";
import { clearSlotSurface, setSlotSurface, standIn } from "./compositor.js";
import { followRing, keyboardOwed } from "./keyboard.js";
import { native, onSurfaceInput, overlay, report, shapes, windowSidecar } from "./host.js";
import { declaredIcons, icon } from "./icons.js";
import { issueId } from "./ids.js";
import { drawActivity } from "./activity.js";
import { bind, delegate, mark, run, runOn } from "./commands.js";
import { fillPicker, pickerAnswer, pickerColumns, pickerGroups, pickerItems } from "./picker-layer.js";
import { emptySlot, mountSurface, mountedSurface, placePluginPlaceholder, surfaceForTab } from "./surface-modules.js";
import { onDialogChange } from "./dialogs.js";
import { drawDialogSeat } from "./dialog-seat.js";
import { emitEvent } from "./page-log.js";
import { trace } from "./performance.js";
import { onPluginOperations, pluginOperations } from "./installed-plugins.js";
import { setSurfaceStatus, setTabError, surfaceErrorText } from "./surface-status.js";
import { imageDetachHold } from "./image-detach-waits.js";
import { clearVisibleNotices, missingOriginRecords, onTabReports, recordOrigin, reportError, setVisibleTab, storedLayoutState, tabButtonData, tabError, tabFooter,
  tabLabel, tabModified, tabNotice, tabOrigin } from "./tab-reports.js";
import { errorToasts, hideError, showError } from "./shown-errors.js";
import { registry } from "./exposure.js";
import { configureSystemNotifications, systemNotifications } from "./system-notifications.js";
import { active as activeProject, all as allProjects, initialProjectContextFailed, initialProjectContextReady, local as localProjects, storedTabTaken, waitForInitialProjectContext } from "./projects.js";

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

/* The height of the head and the foot of a card: the chrome metrics head-h and foot-h. This value is the boundary of the drop zones and
   also the row height of the stylesheet, so both read the one declaration; the zones would drift at the end of the head if one changed alone. */
const HEADER = parseFloat(CHROME["head-h"]), FOOTER = parseFloat(CHROME["foot-h"]);


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
  // default: a press whose surface has no slot reaches no card (null); the record names it.
  const card = slot?.closest(".card")?.dataset.cardId ?? null;
  const decision = !slot ? "no-slot" : card === focusedId ? "focused" : "focus";
  emitEvent("debug", "workbench.surface.press", { surface: tabId, card, focused: focusedId, decision });
  slot?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
};

/* The divider that holds a drag passed by the host. It is set on press and cleared on release. */
let heldDivider = null;

/* One step of the left button. The host converts the coordinates into those of this document and sends them.
   phase is 0 for press, 1 for move, and 2 for release.

   diagnostics.drag drives a divider through these steps (observe.js), and the host passes each press on a surface. The grab area of
   a divider is a window overlay, in which this document takes the pointer before the native views
   (docs/spec/native-surfaces.md#surface-host-container), so a press that the host passes from a surface lies outside every grab area
   and grabs no divider. The view can also move a divider through mouse events, so the event is dispatched on that element and not on
   the plane. */
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
/* The group tree of the shown space over grid (group-tree.js): the groups, the leader of each level and lastCard, from which every new
   card takes its identifier (docs/spec/groups.md#model). */
let tree = null;

/** The options of the group tree: the gap and the smallest edge of the grid and the head height of a group header. */
// At the seam a frame and a header of a group card take no gap (docs/spec/groups.md#drawn-rectangles).
const treeOptions = () => ({ gap: grid.gap, minSize: grid.minSize, head: HEADER, seam: seam() === "line" });


// The name of the window of this page, which its start document carries and the errors of the layout operations name
// (docs/spec/native-host.md#page-start). It is null until the start names it.
let windowName = null;

/** Takes the name of the window of this page from its start document. A name that is not a nonempty string is refused. */
export function nameWindow(name) {
  if (typeof name !== "string" || name === "") throw new TypeError(`start document window must be the name of the window, not ${JSON.stringify(name)}`);
  windowName = name;
}

/* The one move of the focus ring: the keyboard follows it (keyboard.js). */
function focusOn(id) {
  // A group card takes no focus ring: the first content card inside it takes it (docs/spec/groups.md#focus).
  if (id !== null && tree?.isGroup(id)) id = tree.focusable(id);
  focusedId = id;
  keyboardOwed();
}
// default: without a grid, a card or a tab, or with a tab of a plugin that is not loaded, the ring has no surface.
followRing(() => {
  const tab = activeTab(grid?.card(focusedId));
  return tab && hasPlugin(tab.plugin) ? tab.id : null;
});
// The space of the layout that the plane holds, which qualifies the section surface ids of its sidebars (docs/spec/plugins.md#sections);
// null while the plane holds no layout. The project state can change before the plane changes, so the ids follow the plane.
let heldSpace = null;
// The number in a tab title. It is a display name and not an identifier, so a counter produces it.
let named = 0;

/* ── Tab rules ──────────────────────────────────────────────────────────────
   T1 A card has a tab list and one active tab.
   T2 + and split ask for the kind first and then create a new tab. + puts it in the same card, split puts it in a new card.
      T3 and T4 handle moving an existing tab.
   T3 Drop in the center = the tab joins the target card. The layout stays as it is.
   T4 Drop on an edge = a new slot is needed on that side.
   T5 When the last tab leaves, the card disappears, unless the layout cannot close it, which keeps it as an empty card. */
// A tab stores params only when it was opened with them (docs/spec/plugins.md#pluginjson).
// A new tab id is held by no tab that this page issued, no tab of a stored layout, no tab that this window closed and no surface that
// waits for its image detach; the tabs of the plane are issued or stored tabs.
const issuedTabIds = new Set();
const tabTaken = (id) => issuedTabIds.has(id) || storedTabTaken(id) || tabClosed(id) || imageDetachHold(id) !== null;
function tab(plugin, title, params, random) {
  const id = issueId("tab", tabTaken, random);
  issuedTabIds.add(id);
  return params === null ? { id, plugin, title } : { id, plugin, title, params };
}
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
  t.title = `탭 ${++named}`;
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

/* The kept sets of the window sidebars that their switches hide, by side: hidden elements of the plane that hold their sections, so
   the commit keeps their section surfaces hidden and a show places them again without a new view (docs/spec/plugins.md#sections). */
const keptSets = new Map();

/** Keeps the sections of each window sidebar of a side with a set that the plane does not hold, and releases the kept set of a side
 * that the plane holds again or that lost its set. It runs after the cards of a draw, so a sidebar that comes back holds its sections first. */
function keepHiddenSidebars() {
  const descriptors = windowSidebarCards(pluginUnits(), value("links"), focusedPlugin());
  for (const side of [...keptSets.keys()]) if (!descriptors.some((item) => item.id === side)) releaseKept(side);
  for (const { id: side, plugin: kind } of descriptors) {
    const set = !grid || grid.card(side) || heldSpace === null ? null : standingSet(side);
    if (!set) {
      if (keptSets.has(side)) releaseKept(side);
      continue;
    }
    let holder = keptSets.get(side);
    if (!holder) {
      holder = document.createElement("div");
      holder.className = "kept-sidebar";
      // The side names the card that a show draws the sections into again (publishAhead of compositor.js).
      holder.dataset.sideOf = side;
      holder.hidden = true;
      holder.innerHTML = '<div class="set"></div>';
      plane.appendChild(holder);
      keptSets.set(side, holder);
    }
    // default: a focused card without a tab has no surface to follow (null).
    const owner = kind === null ? { card: null, surface: null } : { card: focusedId, surface: activeTab(grid.card(focusedId))?.id ?? null };
    drawSet(holder.querySelector(".set"), side, set, { ...owner, space: heldSpace, orientation: windowOrientation(side), window: true, plugin: kind, side, hidden: true });
  }
}

function releaseKept(side) {
  const holder = keptSets.get(side);
  keptSets.delete(side);
  clearSet(holder.querySelector(".set"));
  holder.remove();
}

/** It builds the layout of a new space from the tree of workspace.grid of environment.json. Tab ids are issued anew. */
function initial(random) {
  const { grid: declared } = environment().workspace;
  const made = (node) => {
    if (node.cut) return { cut: node.cut, kids: node.kids.map((kid) => ({ share: kid.share, node: made(kid.node) })) };
    const { tabs, ...card } = node;
    // A window sidebar declares no tabs and has no data; a content card that declares no tab starts empty.
    if (!tabs) return { ...card };
    // A tab of a new space has no source tab, so it records null (docs/spec/projects.md#tab-origin).
    const opened = tabs.map((t) => {
      const one = tab(t.plugin, t.title, null, random);
      recordOrigin(one.id, null, "new space");
      return one;
    });
    // default: an empty card has no active tab (null).
    return { ...card, data: { tabs: opened, activeId: opened[0]?.id ?? null } };
  };
  return { root: made(declared.root) };
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
const setData = (el, name, value) => { if (el.dataset[name] !== value) el.dataset[name] = value; };

function updateCard(el, card, rect) {
  // A previous layout that waited for native preparation can contain a card closed in the meantime. A closed card has no tabs
  // and its surface is already released, so its content is not fixed and its surface is not mounted again. The next layout removes that card.
  if (!grid.card(card.id)) return;
  const place = isPlace(card.id) ? card.id : null;
  // The actual text scale of the card content (frame scale × card scale). When the scale is 1, no zoom is declared. Even a zoom
  // declaration with the value 1 raised the cost for WebKit to redraw the surface content and reduced the display during a drag.
  const textZoom = value("textSize") * cardTextSize(card);
  if (textZoom === 1) {
    if (el.dataset.textZoom !== undefined) delete el.dataset.textZoom;
    if (el.style.getPropertyValue("--text-zoom") !== "") el.style.removeProperty("--text-zoom");
  } else {
    if (el.dataset.textZoom !== "") el.dataset.textZoom = "";
    const zoom = String(textZoom);
    if (el.style.getPropertyValue("--text-zoom") !== zoom) el.style.setProperty("--text-zoom", zoom);
  }
  setData(el, "role", card.fixed ? "fixed" : "pane");
  setData(el, "focused", String(card.id === focusedId));
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
        // default: an empty focused card has no active surface (null).
        : { card: focusedId, surface: activeTab(grid.card(focusedId))?.id ?? null };
      // The content of an ordinary sidebar has no card-surface link and no rail.
      drawSet(holder, card.id, set, { ...owner, space: heldSpace, orientation: windowOrientation(side), window: true, plugin: kind, side });
    } else {
      // The place shows no set; it draws its status line, and core.sidebars reports it with a null set.
      drawSet(holder, card.id, null, { card: null, surface: null, space: heldSpace, orientation: windowOrientation(side), window: true, plugin: kind, side });
    }
    setText(statusText, `${SIDE_NAMES[side]} 창 사이드바${kind ? ` · ${kind}` : ""}`);
    // The fold button at the end of the status line turns this sidebar off. The button that turns it on again is in the window head (docs/spec/plugins.md#sections).
    let fold = status.querySelector(".sidebar-status__fold");
    if (!fold || fold.dataset.side !== side) {
      fold?.remove();
      fold = document.createElement("button");
      fold.type = "button";
      fold.className = "sidebar-status__fold";
      fold.dataset.side = side;
      fold.dataset.expose = "core.sidebar.fold";
      fold.title = `${SIDE_NAMES[side]} 창 사이드바 접기`;
      fold.setAttribute("aria-label", fold.title);
      fold.innerHTML = icon(FOLD_ICONS[side]);
      // The fold writes the scope that the applied value of the side comes from (docs/spec/settings.md#scope-of-a-control).
      bind(fold, "core.settings.set", () => appliedPatch(side, false));
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
    ham.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true">${declaredIcons["card-tabs"]}</svg>`;
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
    apps.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true">${declaredIcons["card-tabs"]}</svg>`;
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
      // A press leaves the DOM focus where it is, so the keyboard does not stay on the tab, and the Tab key still stops here.
      b.addEventListener("mousedown", (e) => e.preventDefault());
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
    more.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true">${declaredIcons["card-more"]}</svg>`;
    bind(more, "core.card.tools", () => ({ card: el.dataset.cardId }));
    chrome.appendChild(more);
  }
  updateCardTools(acts, {
    // The group tree checks the drawn minimum below the headers and the group rectangles, which the layout library does not see.
    canClose: tree.canClose(card.id),
    canSplitX: tree.canSplit(card.id, "right"),
    canSplitY: tree.canSplit(card.id, "bottom"),
    canGroupX: tree.canGroup(card.id, "right"),
    canGroupY: tree.canGroup(card.id, "bottom"),
    leads: tree.leadCount(tree.parentOf(card.id)) >= 2,
    leader: tree.leaderOf(tree.parentOf(card.id)) === card.id,
    fullscreen: el.dataset.fullscreen === "true",
  });
  drawSideToggles(acts, el, card.id);

  // The slot of a surface. The compositor does not know the structure of the plane, so the needed values are recorded here.
  //
  // The identity of a surface is the tab. If it were the card, the tabs of one card would share one surface, and since a card
  // id has the same value in every space, the same surface would be used even in a different space.
  const slot = el.querySelector(".slot");
  const shown = activeTab(card);
  if (!shown) {
    // An empty card shows no surface and no placeholder: its body stays empty below the head with the add-tab control.
    clearSlotSurface(slot);
    for (const key of ["nativeSurface", "nativeSurfaceId", "nativeLayer", "nativePlugin", "nativeTitle", "nativeDim"]) delete slot.dataset[key];
    emptySlot(slot);
    slot.dataset.surfaceStatus = "empty";
    cardFolds.set(card.id, folded);
    setText(statusText, cardStatusText(card, tabs, folded));
    return;
  }
  const paramsProblem = hasPlugin(shown.plugin) ? storedParamsProblem(shown.plugin,
    pluginUnits().find((unit) => unit.id === shown.plugin).version, plugin(shown.plugin).params, shown.params) : null;
  // A tab whose image detach is pending is not placed, so the host creates no view for it, and it shows its starting state;
  // a tab whose detach failed shows that error until it is opened again (docs/spec/sidecars.md).
  const held = imageDetachHold(shown.id);
  if (held !== null) {
    clearSlotSurface(slot);
    for (const key of ["nativeSurface", "nativeSurfaceId", "nativeLayer", "nativePlugin", "nativeTitle", "nativeDim"]) delete slot.dataset[key];
    const state = held === "waiting" ? { phase: "loading", error: null } : { phase: "error", error: held.error };
    slot.dataset.surfaceStatus = state.phase;
    setSurfaceStatus(status, shown.id, state);
    surfaceStates.set(shown.id, state);
    surfaceStateChanged();
    cardFolds.set(card.id, folded);
    setText(statusText, cardStatusText(card, tabs, folded));
    return;
  }
  if (!hasPlugin(shown.plugin) || paramsProblem) {
    // The tab of a plugin that is not loaded is a placeholder and not a surface. The surface mark is cleared so the compositor does not treat it as a surface.
    clearSlotSurface(slot);
    for (const key of ["nativeSurface", "nativeSurfaceId", "nativeLayer", "nativePlugin", "nativeTitle", "nativeDim"]) delete slot.dataset[key];
    placePluginPlaceholder(slot, shown.id, pluginPlaceholder(shown, paramsProblem));
    slot.dataset.surfaceStatus = "ready";
    setSurfaceStatus(status, shown.id, { phase: "ready" });
    surfaceStates.set(shown.id, { phase: "ready", error: null });
    surfaceStateChanged();
    cardFolds.set(card.id, folded);
    setText(statusText, cardStatusText(card, tabs, folded));
    return;
  }
  setData(slot, "nativeSurface", "view");
  setData(slot, "nativeSurfaceId", shown.id);
  setData(slot, "nativeLayer", "10");
  setData(slot, "nativePlugin", shown.plugin);
  setData(slot, "nativeTitle", shown.title);
  setData(slot, "nativeDim", String(dimmed(card.id)));
  // default: a tab opened without parameters mounts with params null.
  const surface = surfaceForTab(shown);
  setSlotSurface(slot, surface);
  mountSurface(slot, surface, {
    onState: (state) => {
      slot.dataset.surfaceStatus = state.phase;
      setSurfaceStatus(status, shown.id, state);
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
  // The operation error of the active tab shows in the error toast (docs/spec/plugins.md#tab-reports).
  setTabError(shown.id, tabError(shown.id));
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
  refused: (id) => `${id} 플러그인의 설치된 버전을 불러오지 못했습니다.`,
  host: (id) => `${id} 플러그인은 네이티브 호스트가 있어야 설치됩니다.`,
  unread: (id) => `${id} 플러그인의 설치 상태를 읽지 못했습니다.`,
};

/** The reason of a tab of a plugin that is not loaded. The workbench reads the plugin states before it opens the first space. */
function placeholderReason(id) {
  if (!pluginOperations.hosted) return "host";
  if (pluginOperations.failure()?.kind === "state") return "unread";
  const row = pluginOperations.status().plugins.find((entry) => entry.id === id);
  if (!row?.installed) return "missing";
  if (row.state === "refused") return "refused";
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
  el.style.cssText = `position:absolute;inset:0;display:grid;place-content:center;justify-items:center;gap:${CHROME["placeholder-gap"]};color:var(--muted)`;
  const line = document.createElement("p");
  const text = reason === "params" ? paramsProblem : PLACEHOLDER_LINES[reason](tab.plugin);
  // The reasons unread and params state a failure (the install state could not be read, or the stored params do not match the declaration),
  // so their text shows in the error toast (F217, F1033-3.2) and the card keeps a state label. The other reasons are the designed states of a
  // saved layout and stay plain text.
  if (reason === "unread" || reason === "params") {
    const where = `surface ${tab.id} placeholder`;
    line.textContent = "열 수 없음";
    showError(document, where, text);
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

// A dialog that opens or ends changes what the plane draws: the draw holds the seat of the open dialog (docs/spec/plugins.md#dialogs).
onDialogChange(() => { if (grid) settle(); });

// An error toast that opens or closes changes the window overlays: the next placement cuts each open toast out of the container of the
// surface hosts, so the toast is drawn above the native surfaces (docs/spec/native-surfaces.md#surface-host-container).
errorToasts(document).watch(() => { if (grid) settle(); });

/* ── T5 — closing the card when the last tab moves ─────────────────────────── */

async function closeTab(cardId, tabId) {
  const card = grid.card(cardId);
  if (!card) return;
  if (!tabsOf(card).some((t) => t.id === tabId)) return;
  // The surface is released by the commit of this change after its place succeeds, because the place closes the regions of
  // the surface in the host (docs/spec/native-surfaces.md#region-lifetime); the settled barrier of the command waits for that commit.
  removeTab(card, tabId);
  recordClosedTabs([tabId]);
  // A card that cannot be closed stays as an empty card (docs/spec/cli.md#acting-on-a-layout).
  if (card.data.tabs.length === 0 && tree.canClose(cardId)) tree.close(cardId);
  settleActiveTab(card);
  // A focused card that left the plane clears the ring: the workbench chooses no other card for it
  // (docs/spec/exposure.md#the-keyboard-follows-the-focus-ring).
  if (focusedId !== null && !grid.card(focusedId)) focusOn(null);
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

/**
 * The drag in progress, of a tab or of a group card by its header, whose tab is "": the dragged tab, the origin card, the drop position,
 * and the preview rectangle.
 */
export const dragState = () => (tabDrag ? {
  tab: tabDrag.tabId, card: tabDrag.cardId, moved: tabDrag.moved,
  target: tabDrag.hit ? { ...tabDrag.hit } : null,
  preview: dropPreview,
} : null);

/* The thickness of the card border. The head is a row inside the border, and the target search measures with the rect of the card,
   which includes the border, so the border is added for the tab strip to end where the drawn head ends. At the seam the border is 0, so
   the value is not written but measured from the drawn card. */
const cardBorder = () => {
  const el = plane.querySelector(".card");
  return el ? parseFloat(getComputedStyle(el).borderTopWidth) : 0;
};

/**
 * The measures of the target search (docs/spec/groups.md#target-search): the height of the tab strip of a content card with its border,
 * the edge share of the body of a card, and the width of a band and the margin before the centre of a card, the chrome values drop-band
 * and drop-band-margin; and the height of the foot of a card with its border, which the verification compares with the drawn foot.
 *
 * The plane passes these values to `targetAt`, and verification compares the tab strip and the foot with the drawn head and foot. If each
 * computed it alone, a fix in only one place would leave the targets misaligned while verification still passed.
 */
export const dropBands = () => {
  const edge = cardBorder();
  return { headerPx: HEADER + edge, footerPx: FOOTER + edge, edge: DROP_EDGE,
    band: parseFloat(CHROME["drop-band"]), bandMargin: parseFloat(CHROME["drop-band-margin"]) };
};

/** The edge share of the body of a content card whose outer quarter is a side of the target search (docs/spec/groups.md#target-search). */
const DROP_EDGE = 0.25;

function beginTabDrag(e, cardId, tabId) {
  e.preventDefault();
  // The border does not change during one drag, so it is measured once at the start.
  const band = dropBands();
  tabDrag = { cardId, tabId, from: { x: e.clientX, y: e.clientY }, moved: false, hit: null, anchor: null };
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
    ({ hit: tabDrag.hit, anchor: tabDrag.anchor } = dragHit(tabDrag.anchor, ev.clientX - host.left, ev.clientY - host.top, band, tabDrag.tabId));
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
    if (drag.moved && drag.hit) return run("core.tab.move", { tab: drag.tabId, ...drag.hit });
    settle();
  };
  el.addEventListener("pointermove", onMove);
  el.addEventListener("pointerup", onUp);
  el.addEventListener("pointercancel", onUp);
}

/**
 * Binds the plane once, when it first holds a layout, after the core declarations: a left press on the plane that lands on no card, no
 * group card and no control, such as on a gap, a seam or a divider, clears the focus (docs/spec/groups.md#focus); a group card clears it
 * by its own binding, and a press on a card, a window sidebar included, keeps it.
 */
function bindPlane() {
  if (plane.dataset.expose) return;
  plane.dataset.expose = "core.plane";
  bind(plane, "core.card.focus", { card: null },
    // default: a press target that is no element, such as the document, has no closest and is in no card.
    { event: "pointerdown", when: (e) => e.button === 0 && !e.target.closest?.(".card, .group, button, input") });
}

// A press on the header of a group card outside its buttons, its tool menu and its rename field drags the group card
// (docs/spec/groups.md#moving-and-dropping).
plane.addEventListener("pointerdown", (e) => {
  // default: a press target that is no element, such as the document, has no closest and is on no header.
  const head = e.target.closest?.(".group > .group__head");
  if (!head || !tree || e.target.closest("button, .chrome__acts, .chrome__more, input") || e.button !== 0 || e.detail > 1) return;
  beginGroupDrag(e, head.parentElement.dataset.groupCard, head);
});

/**
 * The drop target of a point of the plane in the drag of the group card id, as {hit, anchor} of dragHit: the target search with the
 * option group, which takes the tab strip as part of the body of its card, so the target is an add or the centre of a content card,
 * whose card the group card exchanges with (docs/spec/groups.md#target-search). band is the measures that dropBands gave.
 */
export function groupDragHit(anchor, id, x, y, band) {
  const found = tree.dragAt(anchor, x, y, { ...band, group: true });
  const { hit } = found;
  if (!hit) return { hit: null, anchor: found.anchor };
  return { hit: hit.kind === "add" ? { card: hit.target, zone: hit.side } : { card: hit.card, zone: "centre" }, anchor: found.anchor };
}

/**
 * The rectangle of the group card id after core.card.move toward hit, probed on the group tree, or undefined when the move is refused or
 * hit names a window sidebar.
 */
function groupDropRect(id, hit) {
  if (targetIds(hit.card).some(isPlace) || tree.checkMove(id, hit.card, hit.zone) !== null) return undefined;
  return tree.probe(() => {
    try {
      tree.move(id, hit.card, hit.zone);
      return tree.rect(id);
    } catch {
      // A refused move is a drop with no slot, which the caller reads as undefined; the release then changes nothing.
      return undefined;
    }
  });
}

/** Starts the drag of the group card id from the press e on its header head; the release runs core.card.move toward the drop. */
function beginGroupDrag(e, id, head) {
  e.preventDefault();
  const band = dropBands();
  tabDrag = { cardId: id, tabId: "", from: { x: e.clientX, y: e.clientY }, moved: false, hit: null, anchor: null };
  head.setPointerCapture(e.pointerId);
  dragChanged();
  const onMove = (ev) => {
    if (!tabDrag) return;
    if (Math.hypot(ev.clientX - tabDrag.from.x, ev.clientY - tabDrag.from.y) > 4) tabDrag.moved = true;
    if (!tabDrag.moved) return;
    if (!tabDrag.stood) { tabDrag.stood = true; restoreFullscreen(); standIn(true); }
    const host = plane.getBoundingClientRect();
    ({ hit: tabDrag.hit, anchor: tabDrag.anchor } = groupDragHit(tabDrag.anchor, id, ev.clientX - host.left, ev.clientY - host.top, band));
    // A drop that the layout refuses has no slot, and that position is not taken.
    if (!drawDrop(tabDrag.hit ? groupDropRect(id, tabDrag.hit) : undefined)) tabDrag.hit = null;
    dragChanged();
  };
  const onUp = (ev) => {
    if (!tabDrag) return;
    if (head.hasPointerCapture(ev.pointerId)) head.releasePointerCapture(ev.pointerId);
    const drag = tabDrag;
    tabDrag = null;
    hideDrop();
    if (drag.stood) standIn(false);
    head.removeEventListener("pointermove", onMove);
    head.removeEventListener("pointerup", onUp);
    head.removeEventListener("pointercancel", onUp);
    dragChanged();
    if (drag.moved && drag.hit) return run("core.card.move", { card: id, target: drag.hit.card, side: drag.hit.zone });
    settle();
  };
  head.addEventListener("pointermove", onMove);
  head.addEventListener("pointerup", onUp);
  head.addEventListener("pointercancel", onUp);
}

// The press takes the pointer capture of the header for a drag, so WebKit targets the double-click at the header, the common target of
// the press and the release; the name under the point of the double-click decides the rename.
plane.addEventListener("dblclick", (e) => {
  // default: a press target that is no element, such as the document, has no closest and is on no header.
  const name = e.target.closest?.(".group__head")?.querySelector(":scope > .group__name");
  if (!name) return;
  const box = name.getBoundingClientRect();
  if (e.clientX < box.left || e.clientX >= box.right || e.clientY < box.top || e.clientY >= box.bottom) return;
  run("core.rename.begin", { kind: "group", id: name.closest(".group").dataset.groupCard });
});

/* The rename of the bars, whose field the header of a renamed group card shows (useGroupRename). */
let groupRename = { state: () => null, field: () => null };

/** Connects the rename of the bars, renames of bar-tabs.js, so the header of a renamed group card shows its field. */
export function useGroupRename(renames) {
  groupRename = renames;
}

/** The group cards of the shown space for the rename of the kind group of bar-tabs.js (docs/spec/groups.md#headers). */
export const groupRenames = {
  name(id) {
    if (!tree?.isGroup(id)) throw new Error(`no group ${id}`);
    return tree.groupRecord(id).name;
  },
  rename: (id, name) => renameGroup(id, name),
  redraw: () => settle(),
};

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
  gx: "새 위치에 무엇을 띄울까",
  gy: "새 위치에 무엇을 띄울까",
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
    // Each press of a group item sends a new request, so it groups the card again where its group stands (docs/spec/groups.md#idempotency).
    (k) => (what === "gx" || what === "gy" ? createGroup(cardId, TOOL_SPLIT_SIDE[what], k, null, newGroupRequest())
      : tree.isGroup(cardId) ? splitCard(cardId, TOOL_SPLIT_SIDE[what], k)
      : what === "add" ? addTab(cardId, k, null) : splitWith(cardId, TOOL_SPLIT_SIDE[what], k, null)));
}

/** Asks which tab to activate. It shows the tab list when the header is folded. */
function openTabList(anchor, cardId) {
  const card = grid.card(cardId);
  if (!card?.data) return;
  openLayer(anchor, `탭 ${tabsOf(card).length}개`, tabsOf(card).map((t) => ({
    // The name is the text of the tab strip, which holds the mark, so the item draws the icon of the plugin and no second mark
    // (docs/spec/example-model.md#card-tabs); the tab of a plugin that is not loaded keeps an empty icon slot.
    key: t.id, name: tabName(t), mark: "", svg: hasPlugin(t.plugin) ? plugin(t.plugin).svg : "",
    notice: tabNotice(t.id),
    active: t.id === card.data.activeId,
  })), (id) => {
    const c = grid.card(cardId);
    if (!c?.data || !tabsOf(c).some((t) => t.id === id)) return;
    c.data.activeId = id;
    focusOn(cardId);
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
    y: fit(a.bottom - host.top + parseFloat(CHROME["picker-anchor-gap"]), p.height, host.height),
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
    overlay.show(pickerEl, rect, pickerAnswer(keys, run), () => closePicker("refused"));
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
  appendTab(card, t);
  focusOn(cardId);
  settle();
  return t.id;
}

/** Follow-up of the split button. It creates a new card and adds a tab of the selected kind to that card. */
/** The side where the new card is placed: the vertical-line split of the card tools puts it on the right, the horizontal-line split below. */
const SPLIT_SIDES = ["left", "right", "top", "bottom"];
const TOOL_SPLIT_SIDE = { x: "right", y: "bottom", gx: "right", gy: "bottom" };

function splitWith(cardId, side, plugin, params) {
  restoreFullscreen();
  const card = grid.card(cardId);
  if (!card?.data) return;
  // A split without space is refused before the tab of the new card is made, so a refused split issues no tab id, records no
  // origin and leaves the tab-name counter.
  const refusal = tree.splitRefusal(cardId, side);
  if (refusal !== null) {
    settle();
    throw new Error(refusal);
  }
  // default: a card without an active tab has no tab to inherit.
  const t = newTab(plugin, params, activeTab(card)?.id ?? null, "split");
  const born = tree.split(cardId, side, { tabs: [t], activeId: t.id });
  focusOn(born);
  settle();
  return { card: born, tab: t.id };
}

/* Whether the preview is in a view of the host. The view is kept during one drag and only its position is updated.
   Recreating it every frame makes it flicker. */
let dropShown = false;

/**
 * The rectangle of the card that this drop produces. It returns undefined when the layout rejects the operation.
 *
 * The operation runs on the group tree and the tree puts the grid back (probe), so the live plane does not change. Computing half of
 * the target card differs from the drawn position: the two cut pieces share the gap between them, so each is not half of the rect, and
 * a move closes first and cuts afterward, so the size of the target differs from before the cut. A target may be a group card or the
 * kids of a cut (docs/spec/groups.md#moving-and-dropping). hit is {card, zone}, card one id or a list of ids.
 */
function dropRect(fromId, hit) {
  const ids = targetIds(hit.card);
  // A join puts the tab into the target, and the card that it leaves without tabs closes, so the preview is the target after the same
  // close of the release (docs/spec/groups.md#invariants, I3).
  if (hit.zone === "strip" || (hit.zone === "centre" && !tree.isGroup(ids[0]))) {
    return tree.probe(() => {
      leaveJoined(fromId, ids[0], tabsOf(grid.card(fromId)).length - 1);
      return tree.rect(ids[0]);
    });
  }
  const only = tabsOf(grid.card(fromId)).length === 1;
  return tree.probe(() => {
    try {
      // T5 — a card with only one tab moves as a whole card.
      if (only) {
        tree.move(fromId, hit.card, hit.zone);
        return tree.rect(fromId);
      }
      const born = hit.zone === "centre" ? tree.addCard(ids[0], undefined) : tree.splitBeside(hit.card, hit.zone, undefined);
      return tree.rect(born);
    } catch {
      // A refused operation is a drop with no slot, which the caller reads as undefined; the release then changes nothing.
      return undefined;
    }
  });
}

/**
 * The drop target of a point of the plane in a tab drag, {card, zone, index?} or null: the target search of the group tree resolves it by
 * the bands of the nodes that end on the line of the point, from the outermost in (docs/spec/groups.md#target-search). card is one id or
 * the ids of the kids of a cut, and zone the side of an add, the centre of a content card, or strip, the tab strip of a content card at
 * index, the number of its tabs whose middle lies before the point. band is the measures that dropBands gave.
 */
export function dropHit(x, y, band) {
  return dragHit(null, x, y, band, null).hit;
}

/**
 * The drop target of a point of a drag whose anchor is anchor, null before the drag enters a line, as {hit, anchor}: hit the {card, zone}
 * of dropHit, which names the run between the anchor and the current band while the drag stays on the band of its line, and anchor the
 * anchor of the next point (docs/spec/groups.md#target-search). The drag keeps the anchor, so the preview and the release name the same
 * run.
 */
export function dragHit(anchor, x, y, band, tabId) {
  const found = tree.dragAt(anchor, x, y, band);
  const { hit } = found;
  if (!hit) return { hit: null, anchor: found.anchor };
  if (hit.kind === "add") return { hit: { card: hit.target, zone: hit.side }, anchor: found.anchor };
  if (hit.kind === "strip") return { hit: { card: hit.card, zone: "strip", index: stripIndex(hit.card, x, tabId) }, anchor: found.anchor };
  return { hit: { card: hit.card, zone: "centre" }, anchor: found.anchor };
}

/**
 * The index of a point x of the plane on the tab strip of the content card cardId: the number of the drawn tabs of the card whose middle
 * lies before x, the tab tabId of the drag left out (docs/spec/groups.md#target-search).
 */
function stripIndex(cardId, x, tabId) {
  const host = plane.getBoundingClientRect();
  const tabs = [...cardElement(cardId).querySelectorAll(".chrome__tabs .tab[data-tab-id]")].filter((b) => b.dataset.tabId !== tabId);
  return tabs.filter((b) => {
    const r = b.getBoundingClientRect();
    return r.left - host.left + r.width / 2 < x;
  }).length;
}

/**
 * Draws the drop preview and returns the drawn rectangle. It returns null when there is nothing to draw.
 *
 * A drop that the layout rejects has no slot to create, so nothing is drawn. If it were drawn, it would mark as a slot a
 * position where releasing does nothing.
 */
function showDrop(fromId, hit) {
  return drawDrop(hit && !targetIds(hit.card).some(isPlace) ? dropRect(fromId, hit) : undefined);
}

/** Draws the drop preview at the rectangle half, or clears it without one, and returns the drawn rectangle or null. */
function drawDrop(half) {
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
 * The layout step of a join of a tab of the card fromId into the card targetId, which left tabs remain in fromId after: a card left
 * without tabs closes when it can. The release and the preview of a join both run it, so the preview is the result. Returns whether the
 * card closed.
 */
function leaveJoined(fromId, targetId, left) {
  if (targetId === fromId || left > 0 || !tree.canClose(fromId)) return false;
  tree.close(fromId);
  return true;
}

/**
 * T4 and T5 decide the layout operation.
 * The origin card has 1 tab    → move the card. No empty card remains.            move()
 * It has 2 or more tabs        → keep the card and move only the tab.             splitToward()
 * Because of the first case, move must be one operation and not a combination of close + split.
 */
function dropTab(fromId, tabId, hit) {
  const from = grid.card(fromId);
  const ids = targetIds(hit.card);
  const group = ids.length === 1 && tree.isGroup(ids[0]);
  const target = ids.length === 1 && !group ? grid.card(ids[0]) : null;
  if (!from || (ids.length === 1 && !group && !target) || ids.some(isPlace)) return settle();
  const moving = tabsOf(from).find((t) => t.id === tabId);
  if (!moving) return settle();

  if (hit.zone === "strip") {                                    // the tab joins at the index of the strip
    removeTab(from, tabId);
    target.data.tabs.splice(hit.index, 0, moving);
    target.data.activeId = moving.id;
    focusOn(target.id);
    if (!leaveJoined(fromId, target.id, tabsOf(from).length)) settleActiveTab(from);
    return settle();
  }

  if (hit.zone === "centre" && !group) {                        // T3
    if (target.id === fromId) { from.data.activeId = tabId; return settle(); }
    removeTab(from, tabId);
    appendTab(target, moving);
    focusOn(target.id);
    if (!leaveJoined(fromId, target.id, tabsOf(from).length)) settleActiveTab(from);
    return settle();
  }

  if (tabsOf(from).length === 1) {                               // T5 — nothing is left to keep
    if (ids.length === 1 && fromId === ids[0]) return settle();
    if (tree.canMove(fromId, hit.card, hit.zone)) tree.move(fromId, hit.card, hit.zone);
    focusOn(fromId);
    return settle();
  }

  // T4 — the slot stays and only the tab moves; the centre of a group card is a new card inside it at the right edge of its rectangle.
  const slot = dropRect(fromId, hit) !== undefined;
  removeTab(from, tabId);
  settleActiveTab(from);
  const data = { tabs: [moving], activeId: moving.id };
  const born = !slot ? null : hit.zone === "centre" ? tree.addCard(ids[0], data) : tree.splitBeside(hit.card, hit.zone, data);
  if (born === null) {                                           // If there is no slot, revert
    appendTab(from, moving);
  } else {
    focusOn(born);
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
    el.style.setProperty(`--p${side[0]}`, state.collapsed ? "var(--divider)" : `${deviceGridSize(state.shownSize, gridScale())}px`);
    // default: a sidebar section of a card with no tabs has no surface context (null) — it is the same context as the left window sidebar.
    const surface = activeTab(card) === null || activeTab(card) === undefined ? null : activeTab(card).id;
    drawSet(body.querySelector(".set"), `${card.id}:${side}`, set, { card: card.id, surface, space: heldSpace, orientation: side === "top" || side === "bottom" ? "horizontal" : "vertical" });
  }
  return spaceFoldText(presentation);
}

/**
 * Arranges the window sidebars of the four sides in the order of sidebarOrder (arrangeWindowSidebars of window-sidebars.js).
 *
 * It uses `insertAt` and not `splitToward`. A split inherits the row range of the split card and occupies only one row,
 * but a sidebar must reach along its side as far as the order lets it.
 */
function settle() {
  if (!grid) return;
  // A change of the layout ends the preview of a drag: the release runs its command from the layout that it finds then.
  previewed = null;
  closePicker("settled");
  // The sides that have a choice hold a sidebar while their switch is on, arranged in the order (docs/spec/external-sidebars.md).
  arrangeWindowSidebars(grid, value("sidebarOrder"), windowSidebarCards(pluginUnits(), value("links"), focusedPlugin()).map(item => item.id),
    windowSidebars, value("sidebarWidth"), side => value(side));
  // The window sidebars change the tree through the layout library, so the heads follow its boxes again.
  tree.reframe();
  // A focused card that left the plane clears the ring: the workbench chooses no other card for it
  // (docs/spec/exposure.md#the-keyboard-follows-the-focus-ring).
  if (focusedId !== null && !grid.card(focusedId)) focusOn(null);
  keepCardScope((id) => grid.card(id));
  view.render();
  syncBackgroundSessions();
}

/* The scrollend wait in progress. The next request cancels the previous wait. */
const landing = new WeakMap();

// A persistent surface actor is owned by the window sidecar and not by a native image surface.
// So a hidden tab keeps its session without creating a WebView or an image region.
const backgroundSessions = new Map();
let backgroundContextWait = null;

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
  emitEvent("info", "workbench.background.session", { tab: tab.id, plugin: tab.plugin, sidecar: descriptor.sidecar, action, surface });
}

function syncBackgroundSessions() {
  if (!native || !grid) return;
  if (initialProjectContextFailed()) return;
  if (!initialProjectContextReady()) {
    if (!backgroundContextWait) {
      backgroundContextWait = waitForInitialProjectContext().then(() => {
        backgroundContextWait = null;
        syncBackgroundSessions();
      }, () => {
        backgroundContextWait = null;
        // The page initialization owner reports this failure. This subscriber only stops background work and must not report it again.
      });
    }
    return;
  }
  const tabs = new Map();
  for (const card of grid.cards) for (const tab of tabsOf(card)) tabs.set(tab.id, tab);
  for (const tab of tabs.values()) {
    // The tab of a plugin that is not loaded has no background session.
    const descriptor = hasPlugin(tab.plugin) ? plugin(tab.plugin).background : null;
    if (!descriptor || tabs.get(tab.id) !== tab) continue;
    // A tab whose image detach is pending or failed opens no session until its supplier released the previous owner.
    if (imageDetachHold(tab.id) !== null) continue;
    const owner = grid.cards.find((card) => tabsOf(card).some((item) => item.id === tab.id));
    const active = owner?.data?.activeId === tab.id;
    const surface = mountedSurface(tab.id) ? "mounted" : "absent";
    // A tab whose params name an owned session shows that session: its surface attaches to it, and the sidecar keeps it without a
    // surface. A background open would start a second session on the surface of the tab, which then refuses the attach.
    if (tab.params?.session !== undefined) {
      const session = backgroundSessions.get(tab.id);
      if (session) {
        stopBackground(session);
        backgroundSessions.delete(tab.id);
      }
      recordBackground(tab, descriptor, "owned", surface);
      continue;
    }
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
      // The request starts the session as the surface of the tab would: in the start directory of the tab, the directory of its origin
      // or else the root of the project, and with the mapped parameters that the tab holds (docs/spec/plugins.md#background-sessions).
      if (descriptor.directory !== undefined) {
        // default: a window without a project has no root, and then the field is not sent.
        const directory = tabOrigin(tab.id).directory ?? activeProject()?.root ?? null;
        if (directory !== null) fields[descriptor.directory] = directory;
      }
      // default: params is an optional member of the declaration, and a tab without params holds no parameter.
      for (const [field, param] of Object.entries(descriptor.params ?? {})) {
        if (tab.params != null && Object.hasOwn(tab.params, param)) fields[field] = tab.params[param];
      }
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
      if (state.stopped) {
        stop();
        return;
      }
      state.stop = stop;
      // The host delivers the reply of the open only to a registered listener, so the open follows the subscription
      // (docs/spec/sidecars.md#page-interface).
      open().catch((error) => {
        if (backgroundSessions.get(tab.id) === state) backgroundSessions.delete(tab.id);
        report(`background session ${tab.id} open failed: ${error.message}`);
      });
    }, (error) => {
      if (backgroundSessions.get(tab.id) === state) backgroundSessions.delete(tab.id);
      report(`background session ${tab.id} listener failed: ${error.message}`);
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
 * than the tools. fitHead decides the stage from the measured widths.
 */
// PEEK    the spare width beside the widest tab that is needed to keep the strip stage: the chrome metric tab-peek-w
// MIN_TAB the room of an active tab beside the kept tools under which the kept tools fold into the menu: the chrome metric tab-min-w
// GRAB    the part of the active tab that a press grabs to drag it, under which the tab drops to the ham stage: the chrome metric
//         tab-grab-w (docs/spec/example-model.md#card-tabs)
const PEEK = parseFloat(CHROME["tab-peek-w"]), MIN_TAB = parseFloat(CHROME["tab-min-w"]), GRAB = parseFloat(CHROME["tab-grab-w"]);

function fitChrome(chrome, strip) {
  if (!chrome.querySelector(".chrome__acts")) return;
  // To measure at every stage, it starts with all tabs and the tool row shown.
  chrome.dataset.fit = "strip";
  chrome.dataset.tools = "bar";
  // The head starts with ≡, or with the space app button in a fullscreen card, so it is fitted at a width reduced by the width
  // of that button.
  const apps = chrome.querySelector(".chrome__apps");
  const lead = parseFloat(getComputedStyle(chrome.closest(".card")?.dataset.fullscreen === "true" && apps
    ? apps : chrome.querySelector(".chrome__ham")).width);
  foldHead(chrome, {
    lead,
    tabWidths: [...strip.querySelectorAll(".tab")].map((tab) => tab.getBoundingClientRect().width),
    // The gap between tabs is a value that the tab list holds.
    // default: the computed value normal of columnGap is not a number and is 0 in flex.
    tabGap: parseFloat(getComputedStyle(strip).columnGap) || 0,
  });
}

/**
 * Folds the header of a group card by the fit of a card head: its name stands in the place of the one tab and nothing leads it
 * (docs/spec/groups.md#headers).
 */
function fitGroupHead(head) {
  head.dataset.fit = "strip";
  head.dataset.tools = "bar";
  // The name grows over the room of the header, so it is measured at the width of its text while data-measure holds its growth, as a
  // tab is measured; no render happens between the two writes.
  head.dataset.measure = "";
  const name = head.querySelector(".group__name").getBoundingClientRect().width;
  delete head.dataset.measure;
  // The icon of an activity stands before the name, so the name takes its width and the gap of the header with it.
  const icon = head.querySelector(":scope > .activity");
  // default: a column gap of normal parses as NaN, and normal is no gap in the flex row of a header.
  const lead = icon ? icon.getBoundingClientRect().width + (parseFloat(getComputedStyle(head).columnGap) || 0) : 0;
  foldHead(head, { lead: 0, tabWidths: [lead + name], tabGap: 0 });
}

/**
 * Writes the stage of fitHead to the head row whose leading button is lead wide and whose tabs are tabWidths wide, tabGap apart. The side
 * margins of the head, the gap between the elements inside it and the width of ⋯ are decided by the stylesheet, so they are measured: if
 * they were written here, they would diverge from the stylesheet, and the width at which the header folds would shift by that difference.
 */
function foldHead(row, { lead, tabWidths, tabGap }) {
  const acts = row.querySelector(".chrome__acts");
  const head = getComputedStyle(row);
  // default: the computed value normal of columnGap is not a number and is 0 in flex.
  const gap = parseFloat(head.columnGap) || 0;
  // The head keeps the leader mark and the fullscreen toggle beside ⋯ in the menu stage, so the menu stage needs the room of each; the
  // stage all folds them into the menu too (docs/spec/groups.md#headers, docs/spec/example-model.md#card-tabs).
  const mark = leaderMark(acts);
  const kept = keptTools(acts);
  const { fit, tools } = fitHead({
    width: row.clientWidth, paddingLeft: parseFloat(head.paddingLeft), paddingRight: parseFloat(head.paddingRight), lead, gap,
    toolsWidth: acts.getBoundingClientRect().width,
    // ⋯ is not drawn in the bar stage, so the declared width is read and not the rect.
    moreWidth: parseFloat(getComputedStyle(row.querySelector(".chrome__more")).width),
    keptWidth: kept.reduce((sum, b) => sum + b.getBoundingClientRect().width + gap, 0),
    tabWidths, tabGap, peek: PEEK, minTab: MIN_TAB, grab: GRAB,
  });
  row.dataset.fit = fit;
  row.dataset.tools = tools;
  if (mark && tools === "menu") row.dataset.mark = "leader";
  else delete row.dataset.mark;
}

/** The pressed leader button of the tool row acts, the leader mark, or null on a card that does not lead. */
const leaderMark = (acts) => acts.querySelector(".chrome__act[data-do=leader][aria-pressed=true]:not([hidden])");

/** The buttons of the tool row acts that the head keeps beside ⋯ in the menu stage: the leader mark and the fullscreen toggle. */
const keptTools = (acts) => [...acts.querySelectorAll(".chrome__act[data-do=leader][aria-pressed=true], .chrome__act[data-do=fullscreen]")]
  .filter((b) => !b.hidden);

/** The kept tools that the head row shows beside ⋯: those of keptTools in the menu stage, none in the stage all, where ⋯ holds them. */
const shownKept = (row, acts) => (row.dataset.tools === "menu" ? keptTools(acts) : []);

/* The reader of the activities of the shown space: {tabs, groups} by tab and group card identifier (docs/spec/activity.md#drawing). */
let readActivities = () => ({ tabs: {}, groups: {} });

/** Sets the reader of the activities of the shown space, which the drawing of the plane reads. */
export function setActivityReader(read) {
  readActivities = read;
}

/** Draws the activity icons of the tabs of the cards and of the group headers of the plane. */
function drawActivities() {
  const { tabs, groups } = readActivities();
  for (const b of plane.querySelectorAll(".chrome__tabs .tab[data-tab-id]")) {
    drawActivity(b, b.querySelector(".tab__name"), Object.hasOwn(tabs, b.dataset.tabId) ? tabs[b.dataset.tabId] : null, "core.activity.tab");
  }
  for (const head of plane.querySelectorAll(".group[data-group-card] > .group__head")) {
    const id = head.parentElement.dataset.groupCard;
    drawActivity(head, head.querySelector(".group__name"), Object.hasOwn(groups, id) ? groups[id] : null, "core.activity.group");
  }
}

/** Draws the activity icons again after the activities changed and fits the heads to their new widths. */
export function redrawActivities() {
  if (!grid) return;
  drawActivities();
  centreTabs();
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
  for (const head of plane.querySelectorAll(".group:not([hidden]) > .group__head")) fitGroupHead(head);
}

/**
 * The focus mark is placed in the body area of the focused card, outside it by the stroke width.
 *
 * If it fit the body, the mark would overlap the native surface and hide the surface content. When it is outside by the
 * stroke width, the stroke lies outside the surface boundary and does not cover the body. The chrome metric focus-mark-t is
 * that width.
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
  placeFocusMark(mark, plane, slot);
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

// The receivers of each redraw of the plane that read the card frames, such as the owned sessions (docs/spec/plugins.md#owned-sessions).
const frameListeners = new Set();

/** Registers fn to run after each redraw of the plane, which is where the frames of the cards change. Returns the function that removes it. */
export function onCardFrames(fn) {
  frameListeners.add(fn);
  return () => frameListeners.delete(fn);
}

/** The size of the card that shows tab in points and at the scale of the window, or null when the card is hidden or the tab is not in the layout. */
export function cardSizeOf(tab) {
  if (!grid || !view) return null;
  const card = grid.cards.find((c) => tabsOf(c).some((t) => t.id === tab));
  if (!card) return null;
  const rect = drawnCardRects().get(card.id);
  if (!rect || rect.w <= 0 || rect.h <= 0) return null;
  return { width: rect.w, height: rect.h, scale: gridScale() };
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
 * in the same frame. When nothing is registered, the plane renders immediately. fn receives (made, draw, seated, titlebar, held, grabs),
 * where held() tells whether the seats of this layout still name what the cards show (seatsHeld) and grabs are the dividers of the
 * layout with the grab areas that the draw writes, which the host gives to this document over its native views
 * (docs/spec/native-surfaces.md#surface-host-container).
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
  // The grid of this layout: the view writes its cards on the device pixels of the ratio it read in the same turn, and verify V7c
  // judges the prediction on that grid, because the display can change scale before the check.
  const pixels = gridScale();
  for (const card of grid.cards) {
    // An empty card shows no surface, so it has no seat (docs/spec/projects.md#persistence).
    if (isPlace(card.id) || !activeTab(card)) continue;
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
        return [side, state ? (state.collapsed ? folded : deviceGridSize(state.shownSize, pixels)) : 0];
      }));
      inset = targetCardInsets(el, slot, bands);
    }
    out.set(card.id, { id: activeTab(card).id, dim: dimmed(card.id), inset, bands, presentation, grid: pixels });
  }
  return out;
}

/**
 * Whether the seats that a layout prepared (seats) still name, for every card of the plane, the tab that the card shows and its
 * dimming. The draw of a layout paints the current model, so a layout whose seats moved would draw other surfaces than the ones it
 * placed; the change that moved them renders again and queues the next layout (drawPrepared of layout-queue.js).
 */
function seatsHeld(seated) {
  if (!grid) return false;
  const cards = grid.cards.filter((card) => !isPlace(card.id) && activeTab(card));
  return cards.length === seated.size && cards.every((card) => {
    const seat = seated.get(card.id);
    return seat !== undefined && seat.id === activeTab(card).id && seat.dim === dimmed(card.id);
  });
}

function restoreWindowState(kept) {
  checkStoredLayout(kept);
  return restoreWindowSidebars(Object.hasOwn(kept, "windowSidebars") ? kept.windowSidebars : {});
}

/** Each refused view tab is logged; its text is also shown on the tab (docs/spec/projects.md#tab-origin). */
function logRefusals(refused) {
  for (const { text } of refused) report(text);
}

// The divider drag whose steps the plane previews: the axis and the line of its first step and the layout before it, or null.
let previewed = null;

/** A step of a divider drag: the line of the group tree moves toward px without the merge of the lines that meet. */
function previewBoundary(axis, line, px) {
  // default: the first step of a divider drag keeps the tree that the drag started from.
  previewed ??= { axis, line, kept: tree.snapshot() };
  return tree.placeBoundary(axis, line, px, true);
}

/**
 * The end of a divider drag that moved the line: the layout returns to the one before the drag and the command core.boundary.move
 * moves the line of the first step to the position where the drag left it, so the result is that of the command, which records it.
 * The command runs its handler before the first wait of the registry, so the plane draws its result in this change.
 */
function endBoundary(axis, line) {
  const drag = previewed;
  previewed = null;
  // default: a release whose drag made no step leaves the layout as it is.
  if (!drag) return false;
  const position = grid.boundaryPos(axis, line);
  tree.restore(drag.kept);
  run("core.boundary.move", { axis: drag.axis, line: drag.line, position }).catch((error) => {
    report(`boundary ${drag.axis} ${drag.line} move failed: ${error.message}`);
  });
  return false;
}

/**
 * An arrow key or a centring of a divider: the command name with params, the operation that the group tree previews, runs from the
 * layout before the gesture, which it changes as the preview does, so the position where the preview leaves the boundary is the answer
 * for the view.
 */
function boundaryCommand(preview, name, params) {
  const kept = tree.snapshot();
  const at = preview();
  tree.restore(kept);
  run(name, params).catch((error) => {
    report(`boundary ${params.axis} ${params.line} ${name} failed: ${error.message}`);
  });
  return at;
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
  tree = readGroupTree(kept, treeOptions(), grid);
  focusOn(kept.focusedId);
  view = new SoksakView(plane, grid, {
    createCard, updateCard,
    // The plane is inset inside the stage by this value. Only the host knows the value, so it must be passed to the view so
    // that lines touching the plane edge continue to the stage boundary.
    bleed: stagePad(),
    // The cards stand at the drawn rectangles of the group tree, below the headers of their group cards, and the rules and dividers are
    // cut at the headers and the frames (docs/spec/groups.md#drawing).
    drawn: {
      has: (id) => grid.card(id) !== undefined || tree.isGroup(id),
      rects: drawnRects,
      rules: () => tree.drawnRules(grid.rules()),
      dividers: () => tree.drawnDividers(grid.dividers(), gripMetrics().gripLength),
    },
    // The document holds the cards in workbench order, so the lists of the elements and the Tab key follow it; drawGroupCards puts
    // each group card before the cards inside it (docs/spec/groups.md#model).
    order: () => tree.order().filter(({ node }) => !node).map(({ id }) => id),
    // A stretch of a divider too short for its grip draws none, which the stylesheet reads from data-grip (docs/spec/groups.md#drawing).
    updateDivider: (el, divider) => {
      const grip = String(divider.grip);
      if (el.dataset.grip !== grip) el.dataset.grip = grip;
    },
    // A divider drag previews its steps on the line of the group tree, which draws the cards below the headers, and its result is
    // the command core.boundary.move from the layout before the drag to the position where the drag left the line
    // (docs/spec/groups.md#minimum-size).
    boundary: {
      move: previewBoundary,
      step: (axis, line, px) => boundaryCommand(() => tree.moveBoundary(axis, line, px, false), "core.boundary.move", { axis, line, position: px }),
      center: (axis, line) => boundaryCommand(() => tree.centerBoundary(axis, line), "core.boundary.center", { axis, line }),
      end: endBoundary,
    },
    // Drawing writes the frame scale of the current settings into the document. Preparation includes the first-row height at
    // that scale, so the host decides the window title bar in the same transaction (docs/spec/native-surfaces.md#title-bar-height).
    commit: (made, draw, dividers) => {
      const factor = value("textSize");
      if (!layouter) {
        applyFrameText(factor);
        alignPlane(plane);
        return draw();
      }
      const seated = seats(made);
      return layouter(made, () => {
        applyFrameText(factor);
        alignPlane(plane);
        transactionSeats = seated;
        try {
          draw();
        } finally {
          transactionSeats = null;
        }
      }, seated, chromeRow(factor), () => seatsHeld(seated), dividers);
    },
    // The render of the plane consists of what the view draws and what this document draws. onChange fires right after the
    // view draws, so the rest is drawn here and the receiver is called afterward.
    onChange: (reason) => {
      // The view creates the grab area of a boundary line. The name is attached here.
      for (const divider of plane.querySelectorAll(".sp-divider:not([data-expose])")) {
        divider.dataset.expose = "core.divider";
      }
      keepHiddenSidebars();
      // The seat of the dialog covers the content of the window below the title bar, the first row of the window.
      drawDialogSeat(plane, document.querySelector(".chrome-bar").getBoundingClientRect().bottom);
      const fullscreen = view.fullscreenCard;
      drawGroupCards(plane, tree, drawnRects(fullscreen), { head: HEADER, fullscreen, focused: focusedId,
        renaming: groupRename.state(), renameField: () => groupRename.field() });
      drawActivities();
      markFocus();
      // A placeholder error that this draw does not show again is withdrawn: its surface left, or its plugin state was read again (F217).
      for (const where of shownPlaceholderErrors) if (!placeholderErrorPlaces.has(where)) hideError(document, where);
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
      for (const fn of [...frameListeners]) fn();
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
    if (statusText && !isPlace(card.id) && tabsOf(card).length) setTabError(activeTab(card).id, tabError(activeTab(card).id));
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
  tree.setOptions(treeOptions());
  view.bleed = stagePad();
  // The gap is also the inner margin of the stage, so the plane size changes when the gap changes. If the code waited for the
  // observer, a render in the meantime would draw with the previous size and pass that value to the surface too.
  // The frame scale is written into the document by the next drawing, so the plane size is measured at that scale (frame-text.js).
  // The scale changes the rows above the plane, so the plane is aligned to the device pixel grid at that scale before it is read,
  // and again at the drawn scale after the measurement restores it.
  const [width, height] = measureAt(value("textSize"), () => {
    alignPlane(plane);
    return [plane.clientWidth, plane.clientHeight];
  });
  alignPlane(plane);
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
  const { leader, lastCard } = tree.stored();
  return {
    // Each content-card tab stores its origin with the layout (docs/spec/projects.md#tab-origin).
    state: storedLayoutState(displayed), leader, lastCard, focusedId,
    windowSidebars: structuredClone(windowSidebars),
    named, sidebars: sidebarChoices(),
  };
};

/**
 * The stored tree of the drawn layout, whose cards hold their tabs and whose boxes are the group cards, and null before the plane is
 * built: the layout of the shown space whose activities core.activity reports (docs/spec/activity.md).
 */
export const activityLayout = () => (grid ? { state: grid.toJSON() } : null);

/** Applies one stored set of state to the plane. */
export function adopt(kept, space) {
  if (typeof space !== "string" || !space) throw new TypeError(`adopt requires the id of the space of the layout, not ${space}`);
  // Another space has cards of the same ids, which were not pressed (docs/spec/text-size.md#scope).
  if (space !== heldSpace) keepCardScope(() => false);
  heldSpace = space;
  bindPlane();
  if (!grid) return build(kept);
  const restored = restoreWindowState(kept);
  logRefusals(recordStoredOrigins(kept));
  tree = readGroupTree(kept, treeOptions(), grid);
  focusOn(kept.focusedId);
  windowSidebars = restored;
  named = kept.named;
  // default: a stored layout without sidebars has no stored selection (docs/spec/projects.md#persistence).
  restoreSidebarChoices(Object.hasOwn(kept, "sidebars") ? kept.sidebars : {});
  settle();
}

/**
 * Returns an empty space state. A new space starts with this value. `random` is the random source of its tab ids (ids.js), the platform
 * source by default. The state is the stored form, with the origin member of each tab, because a new project is stored by this page and
 * shown by the page of another window, which reads each origin from the stored layout (docs/spec/projects.md#tab-origin).
 */
export function fresh(random) {
  const state = initial(random);
  // A new space has no groups; its leader is the first card of the root level in reading order that is not a window sidebar, and
  // lastCard is the largest card number of its cards or 1 (docs/spec/groups.md#leader).
  const cards = new Soksak(state).cards;
  const first = [...cards].sort((a, b) => (a.r0 - b.r0) || (a.c0 - b.c0)).find((card) => !isPlace(card.id));
  return {
    state: storedLayoutState(state), leader: first ? first.id : null,
    // default: an id that carries no card number, such as a window sidebar, issued no number.
    lastCard: Math.max(1, ...cards.map((card) => cardNumber(card.id) ?? 0)),
    focusedId: environment().workspace.focus,
    windowSidebars: Object.fromEntries(cards
      .filter(card => windowSidebar(card.id))
      // default: a fixed sidebar whose size the environment declaration omits starts with the sidebarWidth setting on its axis:
      // the width of a left or right sidebar, the height of a top or bottom sidebar (docs/spec/external-sidebars.md).
      .map(card => [card.id, { [sizeKey(card.id)]: card[sizeKey(card.id)] ?? value("sidebarWidth") }])),
    named: 0,
    sidebars: {},
  };
}

export function clear() {
  keepCardScope(() => false);
  // A space that is not shown holds no section surface (docs/spec/plugins.md#sections).
  for (const side of [...keptSets.keys()]) releaseKept(side);
  heldSpace = null;
  view?.destroy();
  view = null;
  grid = null;
  tree = null;
  keyboardOwed();
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
export const fullscreenCard = () => view?.fullscreenCard ?? null;

/** Whether the card id is drawn while a card is fullscreen: the fullscreen card and the cards inside it, or every card without one. */
function shownFullscreen(id) {
  const shown = fullscreenCard();
  return shown === null || id === shown || tree.path(id).some((group) => group.card === shown);
}

/**
 * The drawn rectangle of each card of the space by id (docs/spec/groups.md#drawn-rectangles): with a fullscreen card only the cards it
 * shows, a fullscreen group card laid out as the whole area with the cards inside it, and the window sidebars at the rectangles of the
 * grid.
 */
function drawnRects(fullscreen) {
  const area = { x: 0, y: 0, w: grid.width, h: grid.height };
  if (fullscreen !== null) return tree.isGroup(fullscreen) ? tree.fullscreen(fullscreen, area) : new Map([[fullscreen, area]]);
  return new Map(tree.order().map(({ id }) => [id, isPlace(id) ? grid.rect(id) : tree.rect(id)]));
}
export const presentedCardRect = (id) => view?.painted(id);
/** The drawn rectangle of each card and group card of the space by id as the plane draws it now, an empty rectangle for a hidden one. */
export function drawnCardRects() {
  const rects = drawnRects(view.fullscreenCard);
  // default: a card that the fullscreen card hides is drawn as an empty rectangle.
  return new Map(tree.order().map(({ id }) => [id, rects.get(id) ?? { x: 0, y: 0, w: 0, h: 0 }]));
}

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
  if (!tree.isGroup(id)) paneCard(id);
  focusOn(id);
  closePicker("fullscreen");
  view.fullscreen(view.fullscreenCard === id ? null : id);
}

export function focusCard(id) {
  // null clears the focus: no card holds the ring and the keyboard stays with the workbench (docs/spec/groups.md#focus).
  if (id === null) {
    focusOn(null);
    settle();
    return;
  }
  if (tree?.isGroup(id)) id = tree.focusable(id);
  paneCard(id);
  // A focus of a card inside a fullscreen group card keeps it fullscreen (docs/spec/groups.md#card-commands-on-a-group-card).
  if (!shownFullscreen(id)) restoreFullscreen();
  focusOn(id);
  settle();
}

/** Opens the add and split menu of a card. If the same menu is open, it closes it. */
export function openCardMenu(id, menu) {
  const group = tree?.isGroup(id);
  if (!group) paneCard(id);
  layoutChangeable(id);
  const what = DO_OF[menu];
  if (!what) throw new Error(`unknown menu ${menu}`);
  // A group header holds no add button: a group card holds no tab (docs/spec/groups.md#headers).
  if (group && what === "add") throw new Error(`card ${id} is a group; a group header has no add menu`);
  // The menus of a group card open under the buttons of its header (docs/spec/groups.md#card-commands-on-a-group-card).
  const holder = group ? plane.querySelector(`.group[data-group-card="${CSS.escape(id)}"] .group__head`) : cardElement(id);
  const anchor = holder?.querySelector(`.chrome__act[data-do="${what}"]:not([hidden])`);
  if (!anchor) throw new Error(`card ${id} has no ${menu} button`);
  if (anchor.disabled) throw new Error(`card ${id} cannot ${menu}`);
  if (picker?.anchor === anchor) { closePicker("toggle"); return; }
  focusOn(group ? tree.focusable(id) : id);
  settle();
  openPicker(anchor, what, id);
}

/**
 * Opens the tool menu of a card. If it is open, it closes it. The menu lists the sidebar buttons that will be visible in
 * the head and the active tools in the same order, and the chosen item runs the same command as that button. Adding a tab
 * and splitting ask for the plugin of the new tab under the same button.
 */
export function openCardTools(id) {
  // A group header folds its buttons into the same tool menu (docs/spec/groups.md#headers).
  const group = tree?.isGroup(id);
  if (!group) paneCard(id);
  const holder = group ? plane.querySelector(`.group[data-group-card="${CSS.escape(id)}"] > .group__head`) : cardElement(id);
  const anchor = holder?.querySelector(".chrome__more");
  if (!anchor) throw new Error(`card ${id} has no tool menu button`);
  if (picker?.anchor === anchor) { closePicker("toggle"); return; }
  const acts = holder.querySelector(".chrome__acts");
  // The head keeps the leader mark and the fullscreen toggle in the menu stage, so the menu does not hold them then; in the stage all it
  // holds them (docs/spec/groups.md#headers, docs/spec/example-model.md#card-tabs).
  const kept = shownKept(holder.querySelector(".chrome__more").parentElement, acts);
  const items = [...acts.querySelectorAll(".chrome__act")].filter((b) => !b.disabled && !b.hidden && !kept.includes(b)).map((b) => ({
    // A sidebar button has no data-do and points to a side with data-side.
    key: b.classList.contains("chrome__side") ? `side-${b.dataset.side}` : b.dataset.do,
    name: b.title,
    mark: "",
    svg: b.querySelector("svg").innerHTML,
    viewBox: b.querySelector("svg").getAttribute("viewBox"),
    active: b.getAttribute("aria-pressed") === "true",
  }));
  focusOn(group ? tree.focusable(id) : id);
  settle();
  openLayer(anchor, "카드 도구", items, (key) => {
    if (key.startsWith("side-")) return run("core.card.sidebar.toggle", { card: id, side: key.slice(5) });
    if (key === "fullscreen") return run("core.card.fullscreen", { card: id });
    if (key === "close") return run("core.card.close", { card: id });
    if (key === "leader") return run("core.group.leader", { card: id });
    if (key === "group-menu") return openGroupMenu(id, anchor);
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
  const rects = grid.rects();
  const map = (own) => cards.map((card) => {
    const r = rects.get(card.id);
    const sx = 16 / grid.width;
    const sy = 10 / grid.height;
    return `<rect x="${(r.x * sx).toFixed(2)}" y="${(r.y * sy).toFixed(2)}" width="${(r.w * sx).toFixed(2)}" ` +
      `height="${(r.h * sy).toFixed(2)}" rx=".6" data-own="${card.id === own}"/>`;
  }).join("");
  const groups = [];
  // A card stands at the depth of the number of cuts above it minus one, in the order of the stored tree. Cards under the same cut have
  // the same depth, a box adds no cut, and a window sidebar has no data and is not listed.
  const walk = (node, cuts) => {
    if (node.box !== undefined) {
      walk(node.inner, cuts);
      return;
    }
    if (node.cut === undefined) {
      const card = grid.card(node.card);
      if (!card.data) return;
      groups.push({
        heading: { id: card.id, name: `카드 ${groups.length + 1}`, depth: Math.max(0, cuts - 1), map: map(card.id) },
        items: tabsOf(card).map((t) => ({
          // The name holds the mark, as in the tab list.
          key: `${card.id}/${t.id}`, name: tabName(t), mark: "", svg: hasPlugin(t.plugin) ? plugin(t.plugin).svg : "",
          notice: tabNotice(t.id),
          active: card.id === id && t.id === card.data.activeId,
        })),
      });
      return;
    }
    for (const kid of node.kids) walk(kid.node, cuts + 1);
  };
  walk(grid.toJSON().root, 0);
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
  focusOn(cardId);
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
  if (!tree?.isGroup(id)) paneCard(id);
  layoutChangeable(id);
  knownPlugin(kind);
  const wanted = checkTabParams(kind, plugin(kind).params, params);
  return tree.isGroup(id) ? addToGroup(id, kind, wanted) : addTab(id, kind, wanted);
}

/**
 * Adds a content card with a tab of kind with the checked params inside the group card id at the right edge of its rectangle and returns
 * the tab (docs/spec/groups.md#card-commands-on-a-group-card).
 */
function addToGroup(id, kind, wanted) {
  tree.probe(() => tree.addCard(id, undefined));
  restoreFullscreen();
  const t = newTab(kind, wanted, sourceTabOf(id), "new tab");
  focusOn(tree.addCard(id, { tabs: [t], activeId: t.id }));
  settle();
  return t.id;
}

/** The tab that a new tab beside the card id inherits: the active tab of the card, or of the content card that a focus of a group card gives. */
// default: a card without an active tab has no tab to inherit.
const sourceTabOf = (id) => activeTab(grid.card(tree.focusable(id)))?.id ?? null;

export function splitCard(id, side, kind) {
  if (tree?.isGroup(id)) {
    layoutChangeable(id);
    knownPlugin(kind);
    if (!SPLIT_SIDES.includes(side)) throw new Error(`unknown side ${side}; use left, right, top or bottom`);
    return splitGroup(id, side, kind, null);
  }
  paneCard(id);
  layoutChangeable(id);
  knownPlugin(kind);
  if (!SPLIT_SIDES.includes(side)) throw new Error(`unknown side ${side}; use left, right, top or bottom`);
  const made = splitWith(id, side, kind, null);
  if (!made) throw new Error(`card ${id} cannot split toward ${side}`);
  return made;
}

/** Puts a new content card with a tab of kind with params beside the rectangle of the group card id into the level that holds it. */
function splitGroup(id, side, kind, params) {
  tree.probe(() => tree.split(id, side, undefined));
  restoreFullscreen();
  const t = newTab(kind, params, sourceTabOf(id), "split");
  const born = tree.split(id, side, { tabs: [t], activeId: t.id });
  focusOn(born);
  settle();
  return { card: born, tab: t.id };
}

export function closeCard(id) {
  if (tree?.isGroup(id)) return closeGroup(id);
  paneCard(id);
  layoutChangeable(id);
  if (!tree.canClose(id)) throw new Error(`card ${id} cannot close`);
  const unsaved = tabsOf(grid.card(id)).find((t) => tabModified(t.id));
  if (unsaved) {
    // Asks about the modified tab first; once it is closed, closing the card asks about the next one or closes it.
    askBeforeClose(id, unsaved, () => closeCard(id));
    return { closed: false };
  }
  restoreFullscreen();
  recordClosedTabs(tabsOf(grid.card(id)).map((t) => t.id));
  tree.close(id);
  // A focused card that left the plane clears the ring: the workbench chooses no other card for it
  // (docs/spec/exposure.md#the-keyboard-follows-the-focus-ring).
  if (focusedId !== null && !grid.card(focusedId)) focusOn(null);
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
    // The close of the last tab closes its card, and a fullscreen presentation of a card that left the layout fails the next draw,
    // so both answers restore the arrangement first, as a close without the question does.
    restoreFullscreen();
    await closeTab(cardId, t.id);
    then();
  });
  // The question names its tab, so a close of the tab while the question is open opens no other question (docs/spec/cli.md#acting-on-a-layout).
  picker.closing = t.id;
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
  if (!shownFullscreen(card.id)) restoreFullscreen();
  card.data.activeId = tabId;
  focusOn(card.id);
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

/* ── Layout operations ─────────────────────────────────────────────────────
   core.layout.open, core.layout.select and core.layout.close (docs/spec/cli.md#acting-on-a-layout). Each decides and changes the layout
   in the turn that runs it, so two applications sent at once run one after the other and the second finds what the first made. */

/** The name of the window of this page for the errors of the layout operations. */
function nameOfWindow() {
  if (windowName === null) throw new Error("the window of this page has no name; the start document did not name it");
  return windowName;
}

/** The content cards of the plane: the cards that are not place cards of window sidebars. */
const contentCards = () => grid.cards.filter((card) => !isPlace(card.id));

/** The space other than the shown one of the project of this window whose stored layout holds what found(cards) finds, or null. */
function inactiveSpaceOf(found) {
  const project = allProjects().find((entry) => entry.spaces.some((space) => space.id === heldSpace));
  // default: a window that shows no space has no other space, and a project without such a space has none.
  return project?.spaces.find((entry) => entry.id !== heldSpace && found(stateCards(entry.layout.state), entry.layout))?.id ?? null;
}

/**
 * The space of this window whose layout holds the tab surface, which surface.window answers (docs/spec/exposure.md#methods): the shown
 * space when a content card of the plane holds the tab, else the space whose stored layout holds it among the other spaces of the project
 * of the shown space and of the projects that this window opened, or null. The mygo workbench answers alike (surfaceSpace of
 * packages/workbench-mygo/src/shell_exposure.go).
 */
export function surfaceSpace(surface) {
  const holds = (cards) => cards.some((card) => tabsOf(card).some((tab) => tab.id === surface));
  if (grid && heldSpace !== null && holds(contentCards())) return heldSpace;
  // default: a window that shows no space has no project of a shown space.
  const shown = allProjects().find((entry) => entry.spaces.some((space) => space.id === heldSpace));
  for (const project of new Set([...(shown ? [shown] : []), ...localProjects()])) {
    const space = project.spaces.find((entry) => entry.id !== heldSpace && holds(stateCards(entry.layout.state)));
    if (space) return space.id;
  }
  return null;
}

/** The content card named by id, or by current the focused card, of the shown space; another space or no space is an error. */
function layoutCard(id) {
  if (id === "current") {
    const focused = grid?.card(focusedId);
    if (!focused || isPlace(focused.id)) throw new Error(`card current names no card: window ${nameOfWindow()} has no focused card`);
    return focused;
  }
  const card = grid?.card(id);
  if (card && !isPlace(id)) return card;
  const space = inactiveSpaceOf((cards) => cards.some((entry) => entry.id === id && !isPlace(entry.id)));
  if (space !== null) throw new Error(`card ${id} is in space ${space}, which is not active`);
  throw new Error(`card ${id} is not in the layout of window ${nameOfWindow()}`);
}

/** The tab named by id, or by current the active tab of the focused card, with its card; null for a tab that this window closed. */
function layoutTab(id) {
  if (id === "current") {
    const card = layoutCard("current");
    const tab = activeTab(card);
    if (!tab) throw new Error(`tab current names no tab: card ${card.id} of window ${nameOfWindow()} has no active tab`);
    return { card, tab };
  }
  const card = grid?.cards.find((entry) => tabsOf(entry).some((t) => t.id === id));
  if (card) return { card, tab: tabsOf(card).find((t) => t.id === id) };
  if (tabClosed(id)) return null;
  // default: a stored card without data has no tabs.
  const space = inactiveSpaceOf((cards) => cards.some((entry) => (entry.data?.tabs ?? []).some((t) => t.id === id)));
  if (space !== null) throw new Error(`tab ${id} is in space ${space}, which is not active`);
  throw new Error(`tab ${id} is not in the layout of window ${nameOfWindow()}`);
}

/**
 * core.layout.open: selects the first tab of the plugin whose params equal the given ones in the target card, card or its neighbour toward
 * side, or adds the tab to card or splits card toward side into a new card with the tab. path stands for the plugin that opens its
 * extension with params {path} in the normal form of the path. A group card as card selects among the content cards inside it in
 * workbench order, adds a content card inside it and splits its rectangle (docs/spec/groups.md#card-commands-on-a-group-card); the
 * neighbour toward side is a content card of the level of card. Returns {card, tab}, the card that holds the tab; a refusal changes nothing.
 */
export function openInLayout({ card: cardId, plugin: kind, params, path, side }) {
  if (kind !== undefined && path !== undefined) throw new Error("core.layout.open takes plugin or path, not both");
  if (kind === undefined && path === undefined) throw new Error("core.layout.open needs plugin or path");
  if (path !== undefined && params !== undefined) throw new Error("core.layout.open takes params only with plugin");
  if (side !== undefined && !SPLIT_SIDES.includes(side)) throw new Error(`unknown side ${side}; use left, right, top or bottom`);
  const id = treeCard(cardId);
  if (isPlace(id)) throw new Error(`card ${id} is not in the layout of window ${nameOfWindow()}`);
  layoutChangeable(id);
  let opener, wanted;
  if (path !== undefined) {
    const normal = checkOpenPath(path);
    opener = chooseOpener(plugins().map((entry) => ({ id: entry.id, opens: entry.opens })), normal);
    wanted = { path: normal };
  } else {
    knownPlugin(kind);
    opener = kind;
    wanted = checkTabParams(kind, plugin(kind).params, params);
  }
  let targets = [id];
  if (side !== undefined) targets = [tree.neighbour(id, side)];
  else if (tree.isGroup(id)) {
    const inside = new Set(tree.contents(tree.node(id)));
    targets = tree.order().map((entry) => entry.id).filter((entry) => inside.has(entry));
  }
  for (const target of targets) {
    if (!target || isPlace(target) || tree.isGroup(target)) continue;
    // default: a tab stored without params has the params null.
    const found = tabsOf(grid.card(target)).find((t) => t.plugin === opener && sameJson(t.params ?? null, wanted));
    if (found) {
      selectTab(found.id);
      return { card: target, tab: found.id };
    }
  }
  if (side === undefined && tree.isGroup(id)) {
    const tab = addToGroup(id, opener, wanted);
    return { card: focusedId, tab };
  }
  if (side === undefined) return { card: id, tab: addTab(id, opener, wanted) };
  if (tree.isGroup(id)) return splitGroup(id, side, opener, wanted);
  const made = splitWith(id, side, opener, wanted);
  if (!made) throw new Error(`card ${id} cannot split toward ${side}`);
  return made;
}

/**
 * core.layout.move: moves an existing tab with its surface into the target card, card or its neighbour toward side. A target that already
 * holds the tab selects it; otherwise the tab joins card as a drop on its centre does, or card splits toward side into a new card with
 * the tab as a drop on that edge does, and the only tab of a card moves its card. The tab never closes. Returns {card, tab}, the card
 * that holds the tab; a refusal changes nothing.
 */
export function moveInLayout({ tab: tabId, card: cardId, side }) {
  if (side !== undefined && !SPLIT_SIDES.includes(side)) throw new Error(`unknown side ${side}; use left, right, top or bottom`);
  const named = layoutTab(tabId);
  if (named === null) throw new Error(`tab ${tabId} is not in the layout of window ${nameOfWindow()}`);
  const id = treeCard(cardId);
  if (isPlace(id)) throw new Error(`card ${id} is not in the layout of window ${nameOfWindow()}`);
  layoutChangeable(id);
  const target = side === undefined ? id : tree.neighbour(id, side);
  const holds = (card) => card && !isPlace(card) && (tree.isGroup(card)
    ? tree.contents(tree.node(card)).includes(named.card.id) : card === named.card.id);
  if (holds(target)) {
    selectTab(named.tab.id);
    return { card: named.card.id, tab: named.tab.id };
  }
  // default: a move without side joins the card, as a drop on its centre does.
  moveTab(named.tab.id, id, side ?? "centre");
  return { card: cardOfTab(named.tab.id).id, tab: named.tab.id };
}

/** core.layout.select: makes the tab active and its card focused; a tab that is already so is left as it is. Returns {card, tab}. */
export function selectInLayout({ tab: tabId }) {
  const named = layoutTab(tabId);
  if (named === null) throw new Error(`tab ${tabId} is not in the layout of window ${nameOfWindow()}`);
  const { card, tab } = named;
  const shown = view.fullscreenCard;
  const unchanged = card.data.activeId === tab.id && focusedId === card.id && (shown === null || shown === card.id);
  if (!unchanged) selectTab(tab.id);
  return { card: card.id, tab: tab.id };
}

/**
 * core.layout.close: closes the tab as its close control does. A modified tab opens the question of the control, once while it is open,
 * and answers closed false at once; a tab that this window closed answers closed true.
 */
export async function closeInLayout({ tab: tabId }) {
  const named = layoutTab(tabId);
  if (named === null) return { closed: true };
  const { card, tab } = named;
  if (tabModified(tab.id)) {
    if (picker?.closing !== tab.id) askBeforeClose(card.id, tab, () => {});
    return { closed: false };
  }
  restoreFullscreen();
  await closeTab(card.id, tab.id);
  return { closed: true };
}

/* ── Planning an arrangement (docs/spec/cli.md#planning-an-arrangement) ───────────────────────────── */

/** The operations of the size rule of the layout library (packages/soksak/docs/layout.md#add-and-remove) on the content cards of the plane. */
function windowFrame(rect) {
  const origin = plane.getBoundingClientRect();
  return { x: origin.left + rect.x, y: origin.top + rect.y, width: rect.w, height: rect.h };
}
/** The content cards and group cards directly inside the group card box, or directly in the root level for null, of the stored tree. */
function directMembers(box) {
  const members = (node) => {
    if (node.box !== undefined) return [node.box];
    if (node.cut) return node.kids.flatMap((kid) => members(kid.node));
    return isPlace(node.card) ? [] : [node.card];
  };
  const holder = (node) => {
    if (node.box === box) return node;
    if (node.box !== undefined) return holder(node.inner);
    if (node.cut) {
      for (const kid of node.kids) {
        const found = holder(kid.node);
        if (found) return found;
      }
    }
    return null;
  };
  const root = grid.toJSON().root;
  if (box === null) return members(root);
  return members(holder(root).inner);
}

const planOperations = {
  cards: () => contentCards().map((card) => card.id),
  boxes: () => tree.nodes().map((node) => node.card),
  members: (box) => directMembers(box),
  unwrap: (id) => grid.unwrap(id),
  withdraw: (id) => grid.withdraw(id),
  insert: (target, side, node) => grid.insert(target, side, node),
  group: (target, side, node, init) => grid.group(target, side, node, init),
  setData: (id, data) => grid.setData(id, data),
  head: () => tree.headStep(),
  even: () => grid.even(),
  frame: (id) => windowFrame(grid.rect(id)),
};

/** The active space as planArrangement reads it (packages/workbench/layout-plan.js). */
function planSpace() {
  if (!grid) return { refusal: `window ${nameOfWindow()} shows no space`, plane: null, minimum: null };
  const minimum = { width: grid.minSize, height: grid.minSize };
  const content = contentCards();
  const rects = content.map((card) => ({ card, rect: grid.rect(card.id) }));
  const x0 = Math.min(...rects.map(({ rect }) => rect.x)), y0 = Math.min(...rects.map(({ rect }) => rect.y));
  const size = {
    width: Math.max(...rects.map(({ rect }) => rect.x + rect.w)) - x0,
    height: Math.max(...rects.map(({ rect }) => rect.y + rect.h)) - y0,
  };
  const shown = fullscreenCard();
  const refusal = shown !== null ? `the layout does not change while card ${shown} is fullscreen; restore the arrangement first` : null;
  // default: two tabs on the same row sort by their column.
  const tabs = rects.sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x)
    // default: a tab stored without params has the params null.
    .flatMap(({ card }) => tabsOf(card).map((t) => ({ tab: t.id, card: card.id, plugin: t.plugin, params: t.params ?? null })));
  return {
    refusal, tabs, plane: size, minimum,
    entry: (kind, params) => {
      knownPlugin(kind);
      return checkTabParams(kind, plugin(kind).params, params);
    },
    unsaved: (tabId) => tabModified(tabId),
    groupNames: tree.nodes().map((node) => node.name),
    groupName: (id) => tree.node(id).name,
    // default: a card with no parent group has no group, which the description reports as null.
    groupOf: (card) => tree.parentOf(card)?.card ?? null,
    // The plan builds on a copy of the plane without the minimum, so it reads the size of every card and judges it by the minimum.
    measure: (shape) => tree.probe(() => {
      const kept = grid.minSize;
      grid.minSize = 0;
      try {
        const ids = treeCards(shape).map((_, index) => (index === 0 ? content[0].id : tree.issue()));
        const groupIds = treeGroups(shape).map(() => tree.issue());
        return buildTree(planOperations, shape, ids, groupIds).frames;
      } finally {
        grid.minSize = kept;
      }
    }),
  };
}

/** core.layout.plan: whether the arrangement can be built in the plane of the active space and what it would be. */
export function planInLayout(params) {
  const { ids, groupIds, ...answer } = planArrangement(params, planSpace());
  return answer;
}

/**
 * core.layout.apply: builds the plan of its tree with the operations of the size rule on the plane, moves the existing tabs into their
 * cards, opens the new tabs, closes the tabs of closed and focuses the first card of the tree. A plan that is not feasible changes
 * nothing and fails with its reason. check runs on each new tab entry before the layout changes and refuses by throwing, and opened runs
 * on the identifier and the entry of each new tab after the layout settled.
 */
export function applyInLayout(params, check = () => {}, opened = () => {}) {
  const planned = planArrangement(params, planSpace());
  if (!planned.feasible) throw new Error(planned.reason);
  const entries = (node) => (node.group ? entries(node.tree) : node.direction ? node.children.flatMap(entries) : node.tabs);
  for (const entry of entries(planned.tree)) if (entry.tab === undefined) check(entry);
  const held = new Map(contentCards().flatMap((card) => tabsOf(card).map((t) => [t.id, t])));
  const kept = tree.snapshot();
  // default: an entry that names no kept card takes a new identifier of the plane.
  const ids = planned.ids.map((id) => id ?? tree.issue());
  // default: an entry that names no kept group takes a new identifier of the plane.
  const groupIds = planned.groupIds.map((id) => id ?? tree.issue());
  let leader;
  try {
    ({ leader } = buildTree(planOperations, planned.tree, ids, groupIds));
  } catch (error) {
    tree.restore(kept);
    throw error;
  }
  let k = 0;
  const created = [];
  // The tree of the result names each tab by its identifier, the new tabs included, and each group card by its name.
  const place = (node) => {
    if (node.group) return { group: { name: node.group.name }, tree: place(node.tree) };
    if (node.direction) return { direction: node.direction, children: node.children.map(place) };
    const tabs = node.tabs.map((entry) => (entry.tab !== undefined ? held.get(entry.tab) : newTab(entry.plugin, entry.params, null, "layout apply")));
    const fresh = node.tabs.flatMap((entry, index) => (entry.tab === undefined ? [[tabs[index].id, entry]] : []));
    // A kept card keeps the rest of its data, its text size and its sidebars; default: a new card has no data.
    const id = ids[k++];
    // default: a card that arrives new has no earlier data to keep.
    grid.setData(id, { ...(grid.card(id).data ?? {}), tabs, activeId: tabs[node.active].id });
    created.push(...fresh);
    return { tabs: tabs.map((t) => ({ tab: t.id })), active: node.active };
  };
  const named = place(planned.tree);
  recordClosedTabs(planned.closed);
  // The group cards are read again from the grid, which holds their names and leaders (docs/spec/groups.md#storage).
  tree = readGroupTree({ state: grid.toJSON(), leader, lastCard: tree.last }, treeOptions(), grid);
  focusOn(ids[readingOrder(planned.tree)[0]]);
  settle();
  for (const [tab, entry] of created) opened(tab, entry);
  const applied = planArrangement({ tree: named }, planSpace());
  return { tree: applied.tree, cards: applied.cards, kept: planned.kept, closed: planned.closed };
}

/**
 * The layout of the window description (docs/spec/exposure.md#window-snapshot): the shown space, the focused card, the tree of the
 * members of the root level, in which a group card is a node of its group with the tree of its members, each content card with its
 * frame in window points, its group card (parent, null at the root level), whether it leads its level and its tabs, and the list of every
 * group card once with its frame and the identifiers of its members (docs/spec/groups.md#status-and-queries). It is null while the
 * plane shows no space.
 */
export function layoutDescription() {
  if (!grid) return null;
  const origin = plane.getBoundingClientRect();
  // The drawn rectangles: a card below the headers of its group cards is drawn below them (docs/spec/groups.md#drawn-rectangles), and a
  // fullscreen group card shows the fullscreen layout.
  const rects = drawnCardRects();
  const frameOf = (id) => {
    const rect = rects.get(id);
    return { x: origin.left + rect.x, y: origin.top + rect.y, width: rect.w, height: rect.h };
  };
  // The tree of the members of the level of the group node parent, null for the root level, from the stored tree of the grid: the root
  // for the root level and the inner node of the box of a group card, each box a leaf by its id.
  const stored = grid.toJSON().root;
  const innerOf = (node, id) => {
    if (node.box === id) return node.inner;
    if (node.box !== undefined) return innerOf(node.inner, id);
    if (node.cut === undefined) return null;
    for (const kid of node.kids) {
      const found = innerOf(kid.node, id);
      if (found) return found;
    }
    return null;
  };
  const level = (parent) => {
    return layoutTree(parent ? innerOf(stored, parent.card) : stored, true, (id, size) => {
      const leader = tree.leaderOf(parent) === id;
      const node = tree.node(id);
      if (node) {
        const { name, level: depth, leader: lead } = tree.groupRecord(id);
        return { card: id, size, frame: frameOf(id), leader, group: { name, level: depth, leader: lead, root: level(node) } };
      }
      const card = grid.card(id);
      // A content card node carries parent only inside a group card and leader only on the leader of its level
      // (docs/spec/exposure.md#window-snapshot).
      return {
        card: card.id, size, frame: frameOf(card.id), ...(parent ? { parent: parent.card } : {}), ...(leader ? { leader } : {}),
        // The members of each tab are shared with core.grid (docs/spec/groups.md#status-and-queries).
        tabs: tabsOf(card).map((t) => tabDescription(card, t.id, tabLabel(t.id))),
      };
    });
  };
  const groups = tree.order().filter(({ node }) => node).map(({ id, node, parent }) => {
    const { name, level: depth, leader } = tree.groupRecord(id);
    return { card: id, name, level: depth, leader, leading: tree.leaderOf(parent) === id, frame: frameOf(id),
      members: tree.readingOrder(node.members).map(memberId) };
  });
  return { space: heldSpace, focused: focusedId, root: level(null), groups };
}

const ZONES = ["centre", "left", "right", "top", "bottom", "strip"];

/**
 * Moves a tab to the centre of a card, to the tab strip of a content card at index, or to an edge of a card, a box, a cut or a run named
 * by one id or a list of ids. It is the same as the result of releasing a drag.
 */
export function moveTab(tabId, cardId, zone, index) {
  const from = cardOfTab(tabId);
  const ids = targetIds(cardId);
  if (!ids.length) throw new Error(`tab ${tabId} moves to no card`);
  for (const id of ids) if (!tree?.isGroup(id)) paneCard(id);
  if (!ZONES.includes(zone)) throw new Error(`unknown zone ${zone}`);
  if (index !== undefined && zone !== "strip") throw new Error("index is given with zone strip only");
  if ((zone === "centre" || zone === "strip") && ids.length > 1) throw new Error(`tab ${tabId} moves to the ${zone} of one card, not of ${ids.join(", ")}`);
  if (zone === "strip") {
    if (tree.isGroup(ids[0])) throw new Error(`card ${ids[0]} is a group and has no tab strip`);
    if (index === undefined) throw new Error("index is required with zone strip");
    // The index is the place in the tab list of the card after the tab leaves it (docs/spec/groups.md#moving-and-dropping).
    const others = tabsOf(grid.card(ids[0])).filter((t) => t.id !== tabId).length;
    if (index < 0 || index > others) throw new Error(`index ${index} is outside the tabs of card ${ids[0]}, 0 to ${others}`);
  }
  const hit = zone === "strip" ? { card: ids[0], zone, index } : { card: cardId, zone };
  if ((zone !== "centre" || tree.isGroup(ids[0])) && dropRect(from.id, hit) === undefined) {
    throw new Error(`tab ${tabId} cannot move to the ${zone} of ${ids.join(", ")}`);
  }
  restoreFullscreen();
  dropTab(from.id, tabId, hit);
  return movedTab(tabId);
}

/**
 * The reply of core.tab.move, the target of the tab as resolved after the commit (docs/spec/groups.md#idempotency): a tab that shares its
 * card with other tabs is answered by that card with the zone strip and its index, and the only tab of a card by the vacated slot of its
 * card.
 */
function movedTab(tabId) {
  const card = cardOfTab(tabId);
  const held = tabsOf(card);
  if (held.length > 1) return { tab: tabId, card: card.id, zone: "strip", index: held.findIndex((t) => t.id === tabId) };
  const { target, side } = grid.vacatedSlot(card.id);
  return { tab: tabId, card: target, zone: side };
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
  const kept = shownKept(chrome, acts);
  // A button that the head does not draw, such as the leader button of a level of one member, is no tool of the head.
  const buttons = Object.fromEntries([...acts.querySelectorAll(".chrome__act[data-do]:not([hidden])")].map((b) => [
    ["close", "fullscreen", "leader"].includes(b.dataset.do) ? b.dataset.do : MENU_OF[b.dataset.do],
    // A head that folded the tools into a menu draws only the kept buttons of the tool row in the menu stage, the leader mark and the
    // fullscreen toggle, and none in the stage all.
    // default: a head that has not folded its tools draws them in the bar.
    { enabled: !b.disabled, hidden: (chrome.dataset.tools ?? "bar") !== "bar" && !kept.includes(b),
      title: b.title },
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

/** The group tree of the shown space, or null while the plane holds no layout. */
export const currentTree = () => tree;

/** The JSON text of the stored layout of the active space, {state, leader, lastCard}, or null while the window shows none. */
export function storedLayoutText() {
  if (!grid) return null;
  return JSON.stringify(tree.stored());
}

/**
 * Closes the group card id with every card inside it after each modified tab of those cards is saved or discarded in turn
 * (docs/spec/groups.md#card-commands-on-a-group-card).
 */
function closeGroup(id) {
  layoutChangeable(id);
  if (!tree.canClose(id)) throw new Error(`card ${id} cannot close`);
  const inside = tree.contents(tree.node(id));
  const unsaved = inside.flatMap((card) => tabsOf(grid.card(card)).filter((t) => tabModified(t.id)).map((t) => ({ card, t })))[0];
  if (unsaved) {
    askBeforeClose(unsaved.card, unsaved.t, () => closeCard(id));
    return { closed: false };
  }
  restoreFullscreen();
  recordClosedTabs(inside.flatMap((card) => tabsOf(grid.card(card)).map((t) => t.id)));
  tree.close(id);
  // A focused card that left the plane clears the ring: the workbench chooses no other card for it
  // (docs/spec/exposure.md#the-keyboard-follows-the-focus-ring).
  if (focusedId !== null && !grid.card(focusedId)) focusOn(null);
  settle();
  return { closed: true };
}

/** The identifiers of the group cards that this window dissolved since its workbench started (docs/spec/groups.md#idempotency). */
const dissolvedGroups = new Set();

/**
 * A card of any level of the shown space named by id, a content card, a group card or a window sidebar, or current for the focused card;
 * a card of another space or of no space is refused with the texts of docs/spec/cli.md#acting-on-a-layout.
 */
function treeCard(id) {
  if (id === "current") return layoutCard("current").id;
  if (typeof id === "string" && tree?.find(id)) return id;
  // A group card of a stored layout is a box of its tree.
  const holdsBox = (node) => node.box === id || (node.box !== undefined && holdsBox(node.inner)) || (node.cut !== undefined && node.kids.some((kid) => holdsBox(kid.node)));
  const space = inactiveSpaceOf((cards, layout) => cards.some((entry) => entry.id === id) || holdsBox(layout.state.root));
  if (space !== null) throw new Error(`card ${id} is in space ${space}, which is not active`);
  throw new Error(`card ${id} is not in the layout of window ${nameOfWindow()}`);
}

/**
 * The answers of the requests of core.group.create by space and request while the window is open; none is stored
 * (docs/spec/groups.md#idempotency).
 */
const groupRequests = new Map();

/** A request of core.group.create that the shown space has not answered, for one press of a group split button. */
// default: a space without an open request holds no request.
export const newGroupRequest = () => issueId("request", (id) => groupRequests.get(heldSpace)?.has(id) ?? false);

/**
 * Groups the card id, a content card or a group card, with a new content card toward side that holds a tab of kind with params and
 * returns {group, card, tab}; the focus moves to the new card (docs/spec/groups.md#commands). With request, the identifier of one request,
 * a repeat of a request that the space answered returns its first answer and changes nothing, and a new request groups also where the
 * group stands (docs/spec/groups.md#idempotency).
 */
export function createGroup(id, side, kind, params, request) {
  // A request that is no string of 1 to 128 characters is refused after the layout and the drawn minimum, in the order of the refusals
  // (docs/spec/groups.md#commands); no answer is kept under such a request, so it finds none.
  const validRequest = request === undefined || (typeof request === "string" && request.length > 0 && [...request].length <= 128);
  const answered = request === undefined || !validRequest ? undefined : groupRequests.get(heldSpace)?.get(request);
  if (answered) return answered;
  if (!SPLIT_SIDES.includes(side)) throw new Error(`unknown side ${side}; use left, right, top or bottom`);
  const card = treeCard(id);
  if (isPlace(card)) throw new Error(`card ${card} is a window sidebar; a group holds content cards and group cards`);
  layoutChangeable(card);
  const parent = tree.parentOf(card);
  // The same group of the same card with the same tab toward the same side changes nothing (docs/spec/groups.md#idempotency).
  if (request === undefined && parent && parent.members.length === 2 && hasPlugin(kind)) {
    const other = parent.members.map(memberId).find((member) => member !== card);
    const wanted = checkTabParams(kind, plugin(kind).params, params);
    const found = !tree.isGroup(other) && tree.neighbour(card, side) === other
      // default: a tab stored without params has the params null.
      ? tabsOf(grid.card(other)).find((t) => t.plugin === kind && sameJson(t.params ?? null, wanted)) : undefined;
    if (found) return { group: parent.card, card: other, tab: found.id };
  }
  tree.probe(() => tree.create(card, side, undefined));
  if (!validRequest) throw new Error("core.group.create: request must be a string of 1 to 128 characters");
  knownPlugin(kind);
  const wanted = checkTabParams(kind, plugin(kind).params, params);
  const t = newTab(kind, wanted, sourceTabOf(card), "split");
  const made = tree.create(card, side, { tabs: [t], activeId: t.id });
  focusOn(made.card);
  settle();
  const answer = { group: made.group, card: made.card, tab: t.id };
  if (request !== undefined) {
    if (!groupRequests.has(heldSpace)) groupRequests.set(heldSpace, new Map());
    groupRequests.get(heldSpace).set(request, answer);
  }
  return answer;
}

/** Replaces the group card id with its members in the level that holds it; a group that this window dissolved answers again. */
export function dissolveGroup(id) {
  if (dissolvedGroups.has(id)) return { dissolved: true };
  const card = treeCard(id);
  tree.requireGroup(card);
  layoutChangeable(card);
  tree.dissolve(card);
  dissolvedGroups.add(card);
  settle();
  return { dissolved: true };
}

/**
 * Opens the close menu of the group card id from the close button of its header, or closes it when it is open. A group whose header
 * holds no close button is refused.
 */
export function openGroupMenu(id, menuAnchor) {
  const card = treeCard(id);
  tree.requireGroup(card);
  // The close item of the tool menu of a folded header opens the menu under ⋯, menuAnchor, and its close button otherwise.
  // default: without menuAnchor, the menu opens under the close button of the group card.
  const anchor = menuAnchor ?? plane.querySelector(`[data-group-card="${CSS.escape(card)}"] [data-do="group-menu"]`);
  if (!anchor) throw new Error(`group ${card} has no close button`);
  if (picker?.anchor === anchor) { closePicker("toggle"); return null; }
  openLayer(anchor, "그룹 메뉴", [{ key: "close", name: "그룹 닫기" }, { key: "dissolve", name: "그룹 풀기" }],
    (key) => run(key === "close" ? "core.card.close" : "core.group.dissolve", key === "close" ? { card } : { group: card }));
  return null;
}

/** Renames the group card id to name with the white space at both ends removed. */
export function renameGroup(id, name) {
  const card = treeCard(id);
  if (typeof name !== "string") throw new Error(`group name must be a string, not ${JSON.stringify(name)}`);
  const named = tree.rename(card, name);
  settle();
  return { group: card, name: named };
}

/** Makes the card id, a content card or a group card, the leader of its level. */
export function leadLevel(id) {
  const card = treeCard(id);
  const group = tree.setLeader(card);
  settle();
  return { card, group };
}

/**
 * Moves the card id, a content card or a group card, beside target on side, into the group target or into the place of the content card
 * target with side centre, or joins every tab of the content card id to the content card target at index with side strip
 * (docs/spec/groups.md#commands); target is one id or the ids of the kids of a cut or a run.
 */
export function moveCard(id, target, side, index) {
  const card = treeCard(id);
  const to = targetIds(target).map(treeCard);
  layoutChangeable(card);
  if (index !== undefined && side !== "strip") throw new Error("index is given with side strip only");
  if (side === "strip") return joinStrip(card, to, index);
  const place = to.length === 1 ? to[0] : to;
  // A move to the centre of a content card is an exchange, a toggle that answers the card alone; every other move answers its target as
  // resolved after the commit, the vacated slot of the card (docs/spec/groups.md#idempotency).
  const exchange = side === "centre" && !tree.isGroup(to[0]) && !grid.vacates(card, place, side);
  // A move that changes the layout focuses the moved card, as the drop of the only tab of a card does; a move to where the card
  // stands changes nothing and keeps the focus (docs/spec/groups.md#focus).
  if (tree.move(card, place, side)) focusCard(card);
  else settle();
  if (exchange) return { card };
  const { target: slot, side: toward } = grid.vacatedSlot(card);
  return { card, target: slot, side: toward };
}

/** Joins every tab of the content card card, in its order, to the content card of the list to at index, and closes card. */
function joinStrip(card, to, index) {
  const refused = tree.checkMove(card, to.length === 1 ? to[0] : to, "strip");
  if (refused) throw refused;
  if (index === undefined) throw new Error("index is required with side strip");
  const from = grid.card(card), into = grid.card(to[0]);
  const count = tabsOf(into).length;
  if (index < 0 || index > count) throw new Error(`index ${index} is outside the tabs of card ${into.id}, 0 to ${count}`);
  if (!tree.canClose(card)) throw new Error(`card ${card} cannot move to strip of ${into.id}`);
  const tabs = [...tabsOf(from)];
  const active = from.data.activeId;
  for (const t of tabs) removeTab(from, t.id);
  into.data.tabs.splice(index, 0, ...tabs);
  // default: a card without an active tab gives the target no selected tab, and the target keeps its own.
  if (active) into.data.activeId = active;
  tree.close(card);
  focusOn(into.id);
  settle();
  // The join closes card, so the reply names the card that holds its tabs (docs/spec/groups.md#idempotency).
  return { card: into.id };
}

/**
 * The state of the card id of any level (docs/spec/groups.md#status-and-queries): a content card with its active tab, its tabs with their
 * summary statuses, read from summary, the statuses of each surface that its plugin declares with summary true, and its group path; a
 * group card with its group path, the number of levels from the focused card up to it and its node.
 */
export function cardState(id, summary) {
  const card = treeCard(id);
  if (isPlace(card)) throw new Error(`card ${card} is a window sidebar`);
  const groups = tree.path(card);
  if (tree.isGroup(card)) return { card, groups, focus: tree.focusDistance(card, focusedId), group: tree.groupRecord(card) };
  const data = grid.card(card);
  // default: a tab whose surface declares no summary status has the status {}.
  const tabs = tabsOf(data).map((t) => ({ tab: t.id, plugin: t.plugin, status: summary.get(t.id) ?? {} }));
  // default: a card without an active tab reports null.
  return { card, activeTab: activeTab(data)?.id ?? null, tabs, groups };
}
/** The text size scale of a card. It is 1 when there is no value. */
// default: as the comment above says, a card with no text size scale is 1.

/** The current scope of the text size (docs/spec/text-size.md#scope). */
export function currentTextScope() {
  return effectiveTextScope(textScope(), focusedId);
}

/** The actual text scale of a surface. A tab has the frame scale multiplied by the scale of the card that holds it, and a section that a drawn sidebar holds has the frame scale. Any other surface is not in the plane and is null. */
function surfaceTextSize(surfaceId) {
  const card = grid?.cards.find((item) => tabsOf(item).some((t) => t.id === surfaceId));
  if (card) return value("textSize") * cardTextSize(card);
  return sectionSurfaceShown(surfaceId) ? value("textSize") : null;
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
