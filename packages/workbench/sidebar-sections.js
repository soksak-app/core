// Draws the sections of the set that a sidebar shows (docs/spec/plugins.md#sections).
//
// Keeps the section selection and collapse for each sidebar id.
// list lays out all sections according to the direction, and tabs mounts only the one selected section.
// This module holds the tab selection and the section collapse for each sidebar.
import { bind } from "./commands.js";
import { chooseSource, createDeclaredSection } from "./declared-section.js";
import { createDeclaredSource } from "./declared-source.js";
import { trace } from "./performance.js";
import { hasIcon, icon } from "./icons.js";
import { registry } from "./exposure.js";
import { sourceOrigin } from "./source-origins.js";
import { hasSection, section } from "./registry.js";

/* Selected tab and collapsed sections for each sidebar id. */
const choices = new Map();
/* For each drawn set element, its sidebar, set and section items. */
const drawn = new Map();
const listeners = new Set();

registry.onRegistrationChange(() => {
  for (const record of drawn.values()) {
    for (const entry of record.entries) entry.declared?.reconcile();
  }
});

const notify = () => { for (const fn of listeners) fn(); };

/** Calls fn when the mount state of a section changes. */
export function onSectionsChange(fn) {
  listeners.add(fn);
}

function choiceOf(sidebar) {
  if (!choices.has(sidebar)) choices.set(sidebar, { tab: null, folded: new Set() });
  return choices.get(sidebar);
}

/** Releases the module of an item. If the mount has not finished, it releases after the mount finishes. */
function unmount(entry) {
  if (!entry.mount) return;
  const pending = entry.mount;
  entry.mount = null;
  entry.mounted = false;
  entry.error = null;
  // A mount failure and a release failure during the release are reported as page errors (docs/spec/plugins.md). The item has already been released,
  // so it does not appear as the error of core.sidebars. A declared section closes in the release, before the next value of the new section is drawn.
  pending.then((result) => result.dispose()).catch((error) => {
    dispatchEvent(new ErrorEvent("error", { message: `section ${entry.section.id}: ${error.message}` }));
  });
  for (const stop of entry.observing.splice(0)) stop();
}

/**
 * The bind function of a declared section: it connects a control to a command of the section's plugin or of the core
 * (docs/spec/declared-ui.md). A section uses only the names of its own plugin and of the core.
 */
function sectionBind(entry) {
  const owner = entry.section.id.slice(0, entry.section.id.indexOf("."));
  const own = (name) => {
    if (!name.startsWith(`${owner}.`) && !name.startsWith("core.")) {
      throw new Error(`section ${entry.section.id} cannot use ${name}`);
    }
  };
  return (el, name, params, options) => {
    own(name);
    el.dataset.expose = "core.sidebar.section.control";
    return bind(el, name, params, options);
  };
}

function mount(entry, record) {
  if (entry.mount) return;
  const mountOnce = entry.mount = mountDeclared(entry, record);
  mountOnce.then(() => {
    if (entry.mount !== mountOnce) return;
    entry.mounted = true;
    notify();
  }, (error) => {
    if (entry.mount !== mountOnce) return;
    entry.error = error.message;
    notify();
  });
}

/**
 * Draws a declared section from its status (docs/spec/declared-ui.md, sidebar section form and status mapping). The body draws
 * the accepted value through declared-ui.js, and a rejection shows in the body through the display path. The source is chosen
 * among the surfaces that the registry holds for the status. The snapshot
 * channel and the pull come from the view transport of the main page (createDeclaredSource of declared-source.js).
 */
function mountDeclared(entry, record) {
  const owner = entry.section.id.slice(0, entry.section.id.indexOf("."));
  // The manifest holds the full status name in the section (validateManifest refuses a short name). The snapshot channel
  // and the pull name the status inside the plugin (docs/spec/declared-ui.md, status mapping).
  const statusId = entry.section.status;
  const status = statusId.slice(owner.length + 1);
  const bindControl = sectionBind(entry);
  const transport = createDeclaredSource({ plugin: owner, status });
  let declared = null;
  declared = createDeclaredSection({
    statusId,
    body: entry.body,
    options: { declared: (name) => registry.declared("command", name), hasIcon, bind: bindControl },
    expanded: (source, request) => transport.expanded(source, request),
    // default: the context of a sidebar without a linked surface has no active tab (docs/spec/plugins.md#sections).
    // The plugin host that registered the status, under plugin:<plugin id>, is the source after the surfaces
    // (docs/spec/declared-ui.md#declared-status).
    choose: () => {
      const active = record.context.surface ?? null;
      const host = registry.hostRegistrant("status", statusId);
      return chooseSource({
        // default: a sidebar without a linked surface has no active tab (docs/spec/plugins.md#sections).
        active,
        activeGeneration: active === null ? null : sourceOrigin(owner, active),
        registrants: registry.registrants("status", statusId),
        host: host?.id ?? null,
        hostGeneration: host === null ? null : host.generation === sourceOrigin(owner, null) ? host.generation : null,
      });
    },
    channel: transport.channel,
    pull: transport.pull,
    changed: () => {
      const source = declared.state().source;
      if (source === null) delete entry.body.dataset.commandSource;
      else entry.body.dataset.commandSource = source.id;
      notify();
    },
    // The count of the overwritten values reaches the main page in each snapshot (docs/spec/plugin-processes.md, rule 2).
    skipped: (count) => trace("declared-ui.snapshot.skipped", { plugin: owner, status, count }),
    failed: (error) => dispatchEvent(new ErrorEvent("error", { message: `${statusId}: ${error.message}` })),
  });
  entry.declared = declared;
  declared.reconcile();
  return Promise.resolve({ dispose() {
    entry.declared = null;
    declared.close();
  } });
}

/** Releases all sections of one set element and clears its record. */
export function clearSet(container) {
  const record = drawn.get(container);
  if (!record) return;
  for (const entry of record.entries) {
    unmount(entry);
    entry.watcher?.disconnect();
  }
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
 * Applies the selected tab and the collapse to the elements and the mounts. A declared section keeps its accepted value and its
 * source across a change of orientation, because no declared value depends on orientation (docs/spec/declared-ui.md).
 */
function apply(record) {
  const choice = choiceOf(record.sidebar);
  for (const entry of record.entries) {
    const id = entry.section.id;
    if (record.layout === "tabs") {
      const selected = choice.tab === id;
      entry.tab.setAttribute("aria-selected", String(selected));
      entry.element.hidden = !selected;
      if (selected) mount(entry, record);
      else unmount(entry);
    } else {
      const folded = choice.folded.has(id);
      entry.element.dataset.folded = String(folded);
      entry.header.setAttribute("aria-expanded", String(!folded));
      mount(entry, record);
    }
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
  // The orientation is not part of the key: a change of orientation keeps the elements, and a declared section keeps its value and source.
  const key = JSON.stringify([sidebar, set.id, set.title, set.layout, sections.map((s) => s.id), context.card, context.surface, context.window === true]);
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
      // A fill section shares the remaining height in the list layout (docs/spec/plugins.md#sections).
      if (section.fill) element.dataset.fill = "true";
      const entry = { section, element, header: null, tab: null, body: document.createElement("div"),
        mount: null, mounted: false, error: null, declared: null, observing: [] };
      entry.body.className = "set__body";
      // The body of a declared section lays its root elements by the orientation of the sidebar (docs/spec/declared-ui.md).
      entry.body.dataset.declared = "";
      if (context.surface) entry.body.dataset.surface = context.surface;
      if (context.window) entry.body.dataset.windowSidebar = "";
      // The content that a section drew is exposed as text of core.sidebars, so a change of the content is notified.
      entry.watcher = typeof MutationObserver === "function" ? new MutationObserver(notify) : null;
      entry.watcher?.observe(entry.body, { subtree: true, childList: true, characterData: true });
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
        sections: record.entries.map((entry) => {
          const declared = entry.declared?.state();
          return {
          id: entry.section.id, name: entry.section.name,
          folded: record.layout === "list" && choice.folded.has(entry.section.id),
          // A declared section reports its accepted value and its rejection.
          mounted: declared ? declared.mounted : entry.mounted,
          error: declared ? declared.error : entry.error,
          text: entry.body.textContent,
          // Whether the tab text fits in the tab width. It is true if wrapping or shrinking cuts it off.
          clipped: entry.tab ? entry.tab.scrollWidth > entry.tab.clientWidth || entry.tab.scrollHeight > entry.tab.clientHeight : false,
          controls: entry.body.querySelectorAll('[data-expose="core.sidebar.section.control"]').length,
          ...(declared ? {
            source: declared.source,
            subscription: declared.subscription,
            pull: declared.pull,
            acceptedSeq: declared.acceptedSeq,
          } : {}),
          };
        }),
      };
    });
}
