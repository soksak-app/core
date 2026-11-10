// Draws the sections of the set that a sidebar shows (docs/spec/plugins.md#sections).
//
// Each section is a section surface: a view of its plugin whose slot is the body of the section, with the surface id
// <space id>/<sidebar id>/<section id>. The sidebar draws only the frame (headers, tabs, heights); the plugin draws the body.
// This module holds the tab selection and the section collapse for each sidebar.
import { bind, mark, run } from "./commands.js";
import { clearSlotSurface, setSlotSurface } from "./compositor.js";
import { icon } from "./icons.js";
import { hasSection, section } from "./registry.js";
import { hideSectionSurface, showSectionSurface, sectionSurfaceId } from "./section-surfaces.js";
import { mountSurface } from "./surface-modules.js";

/* Selected tab, collapsed sections and dragged section heights for each sidebar id. */
const choices = new Map();
/* For each drawn set element, its sidebar, set and section items. */
const drawn = new Map();
const listeners = new Set();

const notify = () => { for (const fn of listeners) fn(); };

/** Calls fn when the mount state of a section changes. */
export function onSectionsChange(fn) {
  listeners.add(fn);
}

function choiceOf(sidebar) {
  if (!choices.has(sidebar)) choices.set(sidebar, { tab: null, folded: new Set(), sizes: new Map() });
  return choices.get(sidebar);
}

export { sectionSurfaceId };

/** The section surfaces that the memory saver unloaded: each has no seat while hidden and no mount until the saver restores it. */
const unloaded = new Set();

/** Gives a section its seat in the plane, without a view: the first commit that holds a hidden section mounts it, or the memory saver unloads it. */
function seat(entry) {
  setSlotSurface(entry.body, entry.surface);
  showSectionSurface(entry.surface.surfaceId);
}

/** Mounts the view of a section once; a hidden section keeps its surface, which the compositor places invisible. */
function mount(entry) {
  if (entry.mount || unloaded.has(entry.surface.surfaceId)) return;
  const surface = entry.surface;
  // The attempt exists before mountSurface runs, because the mount reports its first state before it returns.
  const attempt = entry.mount = {};
  attempt.done = mountSurface(entry.body, surface, {
    onState: (state) => {
      if (entry.mount !== attempt) return;
      entry.phase = state.phase;
      // default: an error that is not an Error is shown as its text.
      entry.error = state.phase === "error" ? state.error?.message ?? String(state.error) : null;
      notify();
    },
  });
  attempt.done.then(() => {
    if (entry.mount !== attempt) return;
    entry.mounted = true;
    notify();
  }, (error) => {
    if (entry.mount !== attempt) return;
    entry.error = error.message;
    // A mount failure is shown through the page error display (docs/spec/plugins.md#sections).
    dispatchEvent(new ErrorEvent("error", { message: `section ${surface.surfaceId}: ${error.message}` }));
    notify();
  });
}

/**
 * Clears the slot of a section whose element the sidebar removes: its section left the set, its sidebar is removed, its card
 * closed or the shown space changed. The next commit no longer holds the surface and releases it, as it releases the surface of a
 * closed tab; a sidebar that draws the section again mounts the surface in its new slot (docs/spec/plugins.md#sections).
 */
function release(entry) {
  entry.mount = null;
  entry.mounted = false;
  entry.error = null;
  clearSlotSurface(entry.body);
  // A section that another drawn set holds keeps its surface: a window sidebar that its switch hides or shows moves its sections
  // between its card and the kept sets, and the commit keeps their views (docs/spec/plugins.md#sections).
  if (drawnEntry(entry.surface.surfaceId)) return;
  // A sidebar that draws the section again holds a new surface, which the memory saver has not unloaded.
  unloaded.delete(entry.surface.surfaceId);
  hideSectionSurface(entry.surface.surfaceId);
}

/** The drawn entry of the section surface, or null for another surface. */
function drawnEntry(surfaceId) {
  for (const record of drawn.values()) {
    const entry = record.entries.find((candidate) => candidate.surface.surfaceId === surfaceId);
    if (entry) return entry;
  }
  return null;
}

/** Mounts the hidden sections among ids, which a drawn placement holds (docs/spec/plugins.md#memory-saver). The other ids are tabs. */
export function mountPlacedSections(ids) {
  for (const id of ids) {
    const entry = drawnEntry(id);
    if (entry) mount(entry);
  }
}

/** The unloaded section surfaces as candidates of a commit: they have no seat, and the memory saver keeps their state. */
export function unloadedSections() {
  return [...unloaded].map((id) => ({ id, plugin: drawnEntry(id).surface.pluginId, surface: drawnEntry(id).surface }));
}

/**
 * Ends the mounts of the section surfaces among ids, which the placement of the memory saver leaves out, and takes them out of the seats:
 * a seat of a section without a view has nothing to place (docs/spec/plugins.md#memory-saver). The other ids are tabs.
 */
export function unloadSections(ids) {
  for (const id of ids) {
    const entry = drawnEntry(id);
    if (!entry) continue;
    unloaded.add(id);
    delete entry.body.dataset.nativeSurface;
    entry.mount = null;
    entry.mounted = false;
    entry.phase = null;
    entry.error = null;
    notify();
  }
}

/** Mounts a section surface again that the memory saver restores. Another id is a tab. */
export function restoreSection(id) {
  const entry = drawnEntry(id);
  if (!entry) return;
  unloaded.delete(id);
  mount(entry);
}

/** Releases all sections of one set element and clears its record. */
export function clearSet(container) {
  const record = drawn.get(container);
  if (!record) return;
  drawn.delete(container);
  for (const entry of record.entries) release(entry);
  container.replaceChildren();
  delete container.dataset.sidebar;
  delete container.dataset.orientation;
  delete container.dataset.layout;
  delete container.dataset.expose;
  notify();
}

/** Releases the sections of a set element that left the document. */
function sweep() {
  for (const container of [...drawn.keys()]) if (!container.isConnected) clearSet(container);
}

/**
 * Applies the selected tab and the collapse to the elements. Every section of the set keeps its surface mounted; a folded section
 * and the section of an unselected tab are hidden, as an inactive tab is hidden (docs/spec/plugins.md#sections).
 */
function apply(record) {
  const choice = choiceOf(record.sidebar);
  for (const entry of record.entries) {
    const id = entry.section.id;
    if (record.layout === "tabs") {
      const selected = choice.tab === id;
      entry.tab.setAttribute("aria-selected", String(selected));
      entry.element.hidden = !selected;
    } else {
      const folded = choice.folded.has(id);
      entry.element.dataset.folded = String(folded);
      entry.header.setAttribute("aria-expanded", String(!folded));
      entry.body.hidden = folded;
    }
    // An integer height is the height of the open section; fill sections share the height left after the other sections. A dragged
    // height replaces the declared one (docs/spec/plugins.md#sections).
    // default: a section that was not dragged has its declared height.
    const height = choice.sizes.get(id) ?? entry.section.height;
    entry.element.dataset.height = String(height);
    if (height === "fill") entry.element.style.removeProperty("--section-height");
    else entry.element.style.setProperty("--section-height", `${height}px`);
    seat(entry);
    // The kept set of a hidden window sidebar shows no section: a placement that holds them mounts them (mountPlacedSections).
    const shown = !record.context.hidden && (record.layout === "tabs" ? choice.tab === id : !choice.folded.has(id));
    if (!shown) continue;
    // A shown unloaded section takes its seat again, which gives the memory saver its show.
    if (unloaded.has(entry.surface.surfaceId)) entry.body.dataset.nativeSurface = "view";
    mount(entry);
  }
  // A divider lies between two adjacent open sections of a vertical list.
  record.entries.forEach((entry, index) => {
    if (!entry.divider) return;
    const above = record.entries[index - 1];
    entry.divider.hidden = record.context.orientation !== "vertical" || choice.folded.has(above.section.id) || choice.folded.has(entry.section.id);
    mark(entry.divider, "core.sidebar.section.size", { sidebar: record.sidebar, section: dividedSection(choice, above, entry).section.id });
  });
}

/** The section that the divider between above and below sizes: below when it has an integer height, otherwise above. */
function dividedSection(choice, above, below) {
  // default: a section that was not dragged has its declared height.
  return Number.isInteger(choice.sizes.get(below.section.id) ?? below.section.height) ? below : above;
}

/**
 * Passes the drag of the divider between the sections above and below to core.sidebar.section.size at each move. The drag keeps the
 * other section of the divider at least the minimum height (docs/spec/plugins.md#sections).
 */
function bindSectionDivider(divider, sidebar, above, below) {
  divider.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
    divider.setPointerCapture(event.pointerId);
    const target = dividedSection(choiceOf(sidebar), above, below);
    const other = target === below ? above : below;
    const startY = event.clientY;
    const start = target.body.getBoundingClientRect().height;
    const room = start + other.body.getBoundingClientRect().height;
    if (![startY, start, room].every(Number.isFinite)) throw new Error(`invalid section drag extent in sidebar ${sidebar}`);
    const move = (e) => {
      const delta = target === below ? startY - e.clientY : e.clientY - startY;
      if (!Number.isFinite(delta)) throw new Error(`invalid section pointer displacement in sidebar ${sidebar}`);
      const height = Math.round(Math.min(SECTION_HEIGHT.max, room - SECTION_HEIGHT.min, Math.max(SECTION_HEIGHT.min, start + delta)));
      run("core.sidebar.section.size", { sidebar, section: target.section.id, height });
    };
    const end = () => {
      divider.removeEventListener("pointermove", move);
      divider.removeEventListener("pointerup", end);
      divider.removeEventListener("pointercancel", end);
    };
    divider.addEventListener("pointermove", move);
    divider.addEventListener("pointerup", end);
    divider.addEventListener("pointercancel", end);
  });
}

/**
 * Draws the set set of sidebar sidebar in container. context is {card, surface, orientation, window, plugin, side} of the sidebar.
 * If the set, layout, section list and context are the same, the elements and mounts are kept.
 */
export function drawSet(container, sidebar, set, context) {
  if (context.orientation !== "horizontal" && context.orientation !== "vertical") throw new Error("section orientation must be horizontal or vertical");
  const { space } = context;
  if (typeof space !== "string" || !space) throw new Error(`sidebar ${sidebar} draws sections without the space of its layout`);
  if (set.layout !== "list" && set.layout !== "tabs") throw new Error(`set ${set.id} layout must be list or tabs`);
  // The sections of a plugin that is not loaded remain in the set but are not drawn (docs/spec/plugins.md).
  const sections = set.sections.filter(hasSection).map(section);
  const choice = choiceOf(sidebar);
  // default: a set without sections has no tab to select (null).
  if (set.layout === "tabs" && !sections.some((s) => s.id === choice.tab)) choice.tab = sections[0]?.id ?? null;
  // Neither the orientation nor the followed surface is part of the key: a change of either keeps the section surfaces, and the
  // section views read the change from core.sidebars (docs/spec/plugins.md#sections).
  const key = JSON.stringify([space, sidebar, set.id, set.title, set.layout, sections.map((s) => s.id), context.card, context.window === true,
    context.hidden === true]);
  let record = drawn.get(container);
  if (record?.key !== key) {
    if (record) clearSet(container);
    record = { container, sidebar, key, set: set.id, layout: set.layout, context, entries: [] };
    drawn.set(container, record);
    container.dataset.sidebar = sidebar;
    container.dataset.orientation = context.orientation;
    container.dataset.layout = set.layout;
    container.dataset.expose = "core.sidebar";
    delete container.dataset.html;
    // There is no set title line. The sections start at the top of the sidebar.
    container.replaceChildren();
    let strip = null;
    if (set.layout === "tabs") {
      strip = document.createElement("div");
      strip.className = "set__tabs";
      strip.dataset.expose = "core.sidebar.tabs";
      strip.setAttribute("role", "tablist");
      container.append(strip);
    }
    for (const section of sections) {
      const element = document.createElement("section");
      element.className = "set__section";
      element.dataset.expose = "core.sidebar.section";
      element.dataset.section = section.id;
      const surfaceId = sectionSurfaceId(space, sidebar, section.id);
      // default: a window sidebar has no card (docs/spec/native-surfaces.md#view-surfaces).
      const start = { id: section.id, sidebar, card: context.card ?? null };
      const entry = { section, element, header: null, tab: null, divider: null, body: document.createElement("div"),
        surface: section.surface(surfaceId, start), mount: null, mounted: false, phase: null, error: null };
      entry.body.className = "set__body slot";
      entry.body.dataset.nativeSurface = "view";
      entry.body.dataset.nativeSurfaceId = surfaceId;
      entry.body.dataset.nativeLayer = "10";
      entry.body.dataset.nativePlugin = section.plugin;
      entry.body.dataset.nativeTitle = section.name;
      entry.body.dataset.nativeDim = "false";
      // An unloaded section has no seat while it is hidden, also in the set that holds it next (unloadSections).
      if (unloaded.has(surfaceId)) delete entry.body.dataset.nativeSurface;
      const params = { sidebar, section: section.id };
      if (strip) {
        entry.tab = document.createElement("button");
        entry.tab.type = "button";
        entry.tab.className = "set__tab";
        entry.tab.setAttribute("role", "tab");
        entry.tab.dataset.expose = "core.sidebar.section.tab";
        entry.tab.textContent = section.name;
        bind(entry.tab, "core.sidebar.section.select", params);
        strip.append(entry.tab);
        element.append(entry.body);
      } else {
        entry.header = document.createElement("button");
        entry.header.type = "button";
        entry.header.className = "set__head";
        entry.header.dataset.expose = "core.sidebar.section.header";
        entry.header.innerHTML = `<span class="set__chevron" aria-hidden="true">${icon("chevron-down")}</span><span class="set__name" data-expose="core.sidebar.section.name"></span>`;
        entry.header.querySelector(".set__name").textContent = section.name;
        bind(entry.header, "core.sidebar.section.fold", params);
        element.append(entry.header, entry.body);
        if (record.entries.length > 0) {
          entry.divider = document.createElement("div");
          entry.divider.className = "set__divider";
          entry.divider.dataset.expose = "core.sidebar.section.divider";
          entry.divider.dataset.section = section.id;
          entry.divider.setAttribute("role", "separator");
          entry.divider.setAttribute("aria-orientation", "horizontal");
          bindSectionDivider(entry.divider, sidebar, record.entries.at(-1), entry);
          container.append(entry.divider);
        }
      }
      record.entries.push(entry);
      container.append(element);
    }
    notify();
  } else if (container.dataset.orientation !== context.orientation) {
    container.dataset.orientation = context.orientation;
  }
  record.context = context;
  apply(record);
  // The kept set of a hidden window sidebar names no element: core.sidebars and the elements report the drawn sidebars only.
  if (context.hidden === true) for (const el of [container, ...container.querySelectorAll("[data-expose]")]) delete el.dataset.expose;
  // The sets that left the document release their sections after this set holds its own, so a section that moved here keeps its surface.
  sweep();
}

function recordsOf(sidebar, section) {
  sweep();
  // The drawn set goes first; the kept set of the same sidebar follows the choice with it.
  const records = [...drawn.values()].filter((record) => record.sidebar === sidebar)
    .sort((a, b) => Number(a.context.hidden === true) - Number(b.context.hidden === true));
  if (!records.some((record) => !record.context.hidden)) throw new Error(`no sidebar ${sidebar} is drawn`);
  if (!records[0].entries.some((entry) => entry.section.id === section)) {
    throw new Error(`sidebar ${sidebar} has no section ${section}`);
  }
  return records;
}

/** Selects one section in a sidebar with the tabs layout. */
export function selectSection(sidebar, section) {
  const records = recordsOf(sidebar, section);
  if (records[0].layout !== "tabs") throw new Error(`sidebar ${sidebar} does not use the tabs layout`);
  choiceOf(sidebar).tab = section;
  for (const record of records) apply(record);
  notify();
  choiceListener();
}

/** Collapses or expands one section in a sidebar with the list layout. */
export function foldSection(sidebar, section) {
  const records = recordsOf(sidebar, section);
  if (records[0].layout !== "list") throw new Error(`sidebar ${sidebar} does not use the list layout`);
  const { folded } = choiceOf(sidebar);
  if (folded.has(section)) folded.delete(section);
  else folded.add(section);
  for (const record of records) apply(record);
  notify();
  choiceListener();
}

/** The bounds of a dragged section height in pixels (docs/spec/plugins.md#sections). */
const SECTION_HEIGHT = { min: 32, max: 4096 };

function checkSectionHeight(height) {
  if (!Number.isInteger(height) || height < SECTION_HEIGHT.min || height > SECTION_HEIGHT.max) {
    throw new Error(`section height must be an integer from ${SECTION_HEIGHT.min} to ${SECTION_HEIGHT.max}, got ${JSON.stringify(height)}`);
  }
}

/** Sets the dragged height of one section in a sidebar with the list layout. */
export function sizeSection(sidebar, section, height) {
  const records = recordsOf(sidebar, section);
  if (records[0].layout !== "list") throw new Error(`sidebar ${sidebar} does not use the list layout`);
  checkSectionHeight(height);
  choiceOf(sidebar).sizes.set(section, height);
  for (const record of records) apply(record);
  notify();
  choiceListener();
}

/* Function to call when the user selects a tab or collapses a section. The document connects the space save to it. */
let choiceListener = () => {};

/** Calls fn when the user selects a tab or collapses a section. */
export function onChoicesChange(fn) {
  choiceListener = fn;
}

/** Selected tab and collapsed sections of each sidebar. The space stores them (docs/spec/projects.md#persistence). */
// default: a sidebar without a dragged height omits sizes (docs/spec/projects.md#persistence).
export const sidebarChoices = () => Object.fromEntries([...choices].map(([sidebar, choice]) =>
  [sidebar, { tab: choice.tab, folded: [...choice.folded], ...(choice.sizes.size > 0 ? { sizes: Object.fromEntries(choice.sizes) } : {}) }]));

/** Replaces them with the stored selection and applies it to the drawn sidebars. Called when a space is opened. */
export function restoreSidebarChoices(saved) {
  const restored = new Map();
  for (const [sidebar, { tab, folded, sizes = {} }] of Object.entries(saved)) {
    for (const [section, height] of Object.entries(sizes)) {
      if (!Number.isInteger(height) || height < SECTION_HEIGHT.min || height > SECTION_HEIGHT.max) {
        throw new Error(`sidebar ${sidebar} stores an invalid size of ${section}: ${JSON.stringify(height)}`);
      }
    }
    restored.set(sidebar, { tab, folded: new Set(folded), sizes: new Map(Object.entries(sizes)) });
  }
  choices.clear();
  for (const [sidebar, choice] of restored) choices.set(sidebar, choice);
  for (const record of drawn.values()) apply(record);
  notify();
}

/** Drawn sidebars in document order. The value of core.sidebars. */
export function sidebarsState() {
  return [...document.querySelectorAll(".set[data-sidebar]")].map((container) => drawn.get(container)).filter((record) => record && !record.context.hidden)
    .map((record) => {
      const choice = choiceOf(record.sidebar);
      return {
        sidebar: record.sidebar, set: record.set, layout: record.layout, orientation: record.context.orientation,
        tab: record.layout === "tabs" ? choice.tab : null,
        card: record.context.card, surface: record.context.surface,
        placement: record.context.window ? "window" : "card",
        // default: the context of a card sidebar has no plugin and side of a window sidebar.
        plugin: record.context.plugin ?? null,
        // default: the context of a card sidebar has no plugin and side of a window sidebar.
        side: record.context.side ?? null,
        rect: (() => { const {x,y,width:w,height:h} = record.container.getBoundingClientRect(); return {x,y,w,h}; })(),
        sections: record.entries.map((entry) => ({
          id: entry.section.id, name: entry.section.name,
          folded: record.layout === "list" && choice.folded.has(entry.section.id),
          // The section surface and the surface that its view follows (docs/spec/plugins.md#sections).
          surfaceId: entry.surface.surfaceId,
          surface: record.context.surface,
          height: entry.section.height,
          // default: a section that the person did not drag has no stored size.
          size: choice.sizes.get(entry.section.id) ?? null,
          mounted: entry.mounted,
          phase: entry.phase,
          error: entry.error,
          // Whether the tab text fits in the tab width. It is true if wrapping or shrinking cuts it off.
          clipped: entry.tab ? entry.tab.scrollWidth > entry.tab.clientWidth || entry.tab.scrollHeight > entry.tab.clientHeight : false,
        })),
      };
    });
}
