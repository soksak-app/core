// Draws the sections of the set that a sidebar shows (docs/spec/plugins.md#sections).
//
// Each section is a section surface: a view of its plugin whose slot is the body of the section, with the surface id
// <sidebar id>/<section id>. The sidebar draws only the frame (headers, tabs, heights); the plugin draws the body.
// This module holds the tab selection and the section collapse for each sidebar.
import { bind } from "./commands.js";
import { clearSlotSurface, setSlotSurface } from "./compositor.js";
import { icon } from "./icons.js";
import { hasSection, section } from "./registry.js";
import { hideSectionSurface, showSectionSurface } from "./section-surfaces.js";
import { mountSurface } from "./surface-modules.js";

/* Selected tab and collapsed sections for each sidebar id. */
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
  if (!choices.has(sidebar)) choices.set(sidebar, { tab: null, folded: new Set() });
  return choices.get(sidebar);
}

/** The surface id of a section in a sidebar (docs/spec/plugins.md#sections). */
export const sectionSurfaceId = (sidebar, sectionId) => `${sidebar}/${sectionId}`;

/** Mounts the view of a section once; a hidden section keeps its surface, which the compositor places invisible. */
function mount(entry) {
  if (entry.mount) return;
  const surface = entry.surface;
  setSlotSurface(entry.body, surface);
  showSectionSurface(surface.surfaceId);
  // The attempt exists before mountSurface runs, because the mount reports its first state before it returns.
  const attempt = entry.mount = {};
  attempt.done = mountSurface(entry.body, surface, {
    onState: (state) => {
      if (entry.mount !== attempt) return;
      entry.phase = state.phase;
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
  if (!entry.mount) return;
  entry.mount = null;
  entry.mounted = false;
  entry.error = null;
  clearSlotSurface(entry.body);
  hideSectionSurface(entry.surface.surfaceId);
}

/** Releases all sections of one set element and clears its record. */
export function clearSet(container) {
  const record = drawn.get(container);
  if (!record) return;
  for (const entry of record.entries) release(entry);
  drawn.delete(container);
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
    mount(entry);
  }
}

/**
 * Draws the set set of sidebar sidebar in container. context is {card, surface, orientation, window, plugin, side} of the sidebar.
 * If the set, layout, section list and context are the same, the elements and mounts are kept.
 */
export function drawSet(container, sidebar, set, context) {
  if (context.orientation !== "horizontal" && context.orientation !== "vertical") throw new Error("section orientation must be horizontal or vertical");
  sweep();
  if (set.layout !== "list" && set.layout !== "tabs") throw new Error(`set ${set.id} layout must be list or tabs`);
  // The sections of a plugin that is not loaded remain in the set but are not drawn (docs/spec/plugins.md).
  const sections = set.sections.filter(hasSection).map(section);
  const choice = choiceOf(sidebar);
  // default: a set without sections has no tab to select (null).
  if (set.layout === "tabs" && !sections.some((s) => s.id === choice.tab)) choice.tab = sections[0]?.id ?? null;
  // Neither the orientation nor the followed surface is part of the key: a change of either keeps the section surfaces, and the
  // section views read the change from core.sidebars (docs/spec/plugins.md#sections).
  const key = JSON.stringify([sidebar, set.id, set.title, set.layout, sections.map((s) => s.id), context.card, context.window === true]);
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
      // An integer height is the height of the open section; fill sections share the height left after the other sections
      // (docs/spec/plugins.md#sections).
      element.dataset.height = String(section.height);
      if (section.height !== "fill") element.style.setProperty("--section-height", `${section.height}px`);
      const surfaceId = sectionSurfaceId(sidebar, section.id);
      // default: a window sidebar has no card (docs/spec/native-surfaces.md#view-surfaces).
      const start = { id: section.id, sidebar, card: context.card ?? null };
      const entry = { section, element, header: null, tab: null, body: document.createElement("div"),
        surface: section.surface(surfaceId, start), mount: null, mounted: false, phase: null, error: null };
      entry.body.className = "set__body slot";
      entry.body.dataset.nativeSurface = "view";
      entry.body.dataset.nativeSurfaceId = surfaceId;
      entry.body.dataset.nativeLayer = "10";
      entry.body.dataset.nativePlugin = section.plugin;
      entry.body.dataset.nativeTitle = section.name;
      entry.body.dataset.nativeDim = "false";
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
}

function recordsOf(sidebar, section) {
  sweep();
  const records = [...drawn.values()].filter((record) => record.sidebar === sidebar);
  if (records.length === 0) throw new Error(`no sidebar ${sidebar} is drawn`);
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

/* Function to call when the user selects a tab or collapses a section. The document connects the space save to it. */
let choiceListener = () => {};

/** Calls fn when the user selects a tab or collapses a section. */
export function onChoicesChange(fn) {
  choiceListener = fn;
}

/** Selected tab and collapsed sections of each sidebar. The space stores them (docs/spec/projects.md#persistence). */
export const sidebarChoices = () => Object.fromEntries([...choices].map(([sidebar, choice]) =>
  [sidebar, { tab: choice.tab, folded: [...choice.folded] }]));

/** Replaces them with the stored selection and applies it to the drawn sidebars. Called when a space is opened. */
export function restoreSidebarChoices(saved) {
  choices.clear();
  for (const [sidebar, { tab, folded }] of Object.entries(saved)) choices.set(sidebar, { tab, folded: new Set(folded) });
  for (const record of drawn.values()) apply(record);
  notify();
}

/** Drawn sidebars in document order. The value of core.sidebars. */
export function sidebarsState() {
  return [...document.querySelectorAll(".set[data-sidebar]")].map((container) => drawn.get(container)).filter(Boolean)
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
          mounted: entry.mounted,
          phase: entry.phase,
          error: entry.error,
          // Whether the tab text fits in the tab width. It is true if wrapping or shrinking cuts it off.
          clipped: entry.tab ? entry.tab.scrollWidth > entry.tab.clientWidth || entry.tab.scrollHeight > entry.tab.clientHeight : false,
        })),
      };
    });
}
