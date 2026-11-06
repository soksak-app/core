// Compares the places of the workbench elements of every host in the same states of one window of 1200 by 760: the workspace, the
// menus of the selection layer, the renames, the settings, the library with its forms and pages, the debug view and the card sidebar.
// The workbench of each host draws the chrome metrics of packages/workbench/workbench.json, so each element stands at one place on
// every host (docs/spec/projects.md).
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, open, requiresAll } from "@soksak/window-check/app.mjs";
import { designDifferences } from "@soksak/window-check/design-rects.mjs";
import { fresh, terminalCardSidebar } from "./fixture.mjs";

const SIZE = { width: 1200, height: 760 };

/** The most elements of one name that a state shows; a name with more is a fault of the reading, not of the design. */
const MOST = 200;

/** The requests in flight at once while a state is read. */
const AT_ONCE = 12;

const UNSHOWN = /has no element|is not registered/;

/**
 * The window rectangles of the shown elements of name, in element order. An element without an area is not shown: the page keeps a
 * hidden element in its document with an empty rectangle, and the native workbench has no element for it.
 */
async function shownRects(s, name) {
  const rects = [];
  for (let index = 0; index < MOST; index += 1) {
    let rect;
    try {
      rect = await s.rect(name, index);
    } catch (error) {
      if (UNSHOWN.test(error.message)) return rects;
      throw error;
    }
    const origin = rect.document ?? { x: 0, y: 0 };
    if (rect.width > 0 || rect.height > 0) {
      rects.push({ x: rect.x + origin.x, y: rect.y + origin.y, width: rect.width, height: rect.height });
    }
  }
  throw new Error(`${name} has more than ${MOST} elements`);
}

/** The shown elements of every workbench element name in the current state. */
async function reading(s, names) {
  await s.presented();
  const found = {};
  for (let start = 0; start < names.length; start += AT_ONCE) {
    await Promise.all(names.slice(start, start + AT_ONCE).map(async (name) => {
      const rects = await shownRects(s, name);
      if (rects.length) found[name] = rects;
    }));
  }
  return found;
}

/** Walks the states of one host and reads each of them into states; a state that the host does not reach ends the walk with its error. */
async function walk(t, s, states) {
  await fresh(s);
  await s.run("host.window.resize", SIZE);
  await s.until("host.window", (w) => w.content.width === SIZE.width && w.content.height === SIZE.height, "the window did not resize");
  // An inactive application shows its window behind the frontmost window, where its image regions do not draw and no frame is
  // presented (docs/spec/native-surfaces.md#image-regions).
  await s.request("diagnostics.window.draw-covered", { draw: true });
  s.cleanup(() => s.request("diagnostics.window.draw-covered", { draw: false }));
  const shown = async (when) => t.diagnostic(`${s.app.name} occluded ${when}: ${(await s.get("host.window")).occluded}`);
  await shown("at the start");
  const names = (await s.request("exposure.list")).element.map((entry) => entry.name).filter((name) => name.startsWith("core."));
  const read = async (state) => { states[state] = await reading(s, names); };

  await read("workspace");

  const grid = await s.get("core.grid");
  for (const card of grid.cards.filter((c) => c.pane !== null)) {
    for (const kind of ["add", "split-x", "split-y"]) {
      if (!card.acts[kind].enabled || card.acts[kind].hidden) continue;
      await s.run("core.card.menu", { card: card.id, menu: kind });
      await s.until("core.picker", (picker) => picker.open && picker.items.length > 0, `the ${kind} menu of ${card.id} did not open`);
      await read(`${card.id} ${kind} menu`);
      await s.run("core.picker.close");
      await s.until("core.picker", (picker) => !picker.open, `the ${kind} menu of ${card.id} did not close`);
    }
    await s.run("core.card.tab-list", { card: card.id });
    await s.until("core.picker", (picker) => picker.open && picker.items.length > 0, `the tab list of ${card.id} did not open`);
    await read(`${card.id} tab list`);
    await s.run("core.picker.close");
    await s.until("core.picker", (picker) => !picker.open, `the tab list of ${card.id} did not close`);
  }

  const project = await s.get("core.project");
  for (const [kind, id] of [["space", project.activeSpaceId], ["project", project.id]]) {
    await s.run("core.rename.begin", { kind, id });
    await s.until("core.rename", (rename) => rename?.id === id, `the ${kind} rename did not start`);
    await read(`${kind} rename`);
    await s.run("core.rename.cancel");
    await s.until("core.rename", (rename) => rename === null, `the ${kind} rename did not stop`);
  }

  await s.run("core.settings.open");
  await s.until("core.settings-modal", (modal) => modal.open, "the settings did not open");
  for (const scope of ["common", "project"]) {
    await s.run("core.settings-modal.scope", { scope });
    for (const section of ["general", "plugins", "sidebars"]) {
      await s.run("core.settings-modal.nav", { section });
      await s.until("core.settings-modal", (modal) => modal.section === section && modal.scope === scope,
        `the settings did not show ${scope} ${section}`);
      await read(`settings ${scope} ${section}`);
    }
  }
  await s.run("core.settings.close");
  await s.until("core.settings-modal", (modal) => !modal.open, "the settings did not close");

  await s.run("core.projects.browse");
  await s.until("core.library", (library) => library.shown.length > 0, "the library did not list projects");
  await read("library");
  for (const mode of ["create", "open"]) {
    await s.run("core.library.form.open", { mode });
    await s.until("core.library", (library) => library.formState?.mode === mode, `the ${mode} form did not open`);
    await read(`library ${mode} form`);
    await s.run("core.library.form.cancel");
    await s.until("core.library", (library) => !library.form, `the ${mode} form did not close`);
  }
  await s.run("core.library.search", { query: "no such project" });
  await s.until("core.library", (library) => library.noResults, "the search did not empty the library");
  await read("library without results");
  await s.run("core.library.search", { query: "" });
  await s.run("core.library.page", { page: "plugins" });
  await s.until("core.library", (library) => library.page === "plugins" && library.plugins.shown.length > 0,
    "the plugin page did not list plugins");
  await read("library plugin page");
  await s.run("core.library.page", { page: "projects" });
  await s.run("core.library.return");
  await s.until("core.screen", (screen) => screen.screen === "workspace", "the library did not return to the workspace");

  await s.run("core.debug.open");
  await s.until("core.debug", (debug) => debug.open && debug.entries.length > 0, "the debug view did not list the logs folder");
  await read("debug view");
  await s.run("core.debug.close");
  await s.until("core.debug", (debug) => !debug.open, "the debug view did not close");

  await terminalCardSidebar(s);
  await read("card sidebar");
  await shown("at the end");
}

if (requiresAll(process.env)) test("every host places each workbench element of each state at the same place", { timeout: 900000 }, async (t) => {
  const readings = {};
  const stops = [];
  // A host that stops in one state keeps the states it read, so the differences of the other states are still reported.
  for (const app of Object.values(APPS)) {
    readings[app.name] = {};
    try {
      await walk(t, await open(t, app), readings[app.name]);
    } catch (error) {
      stops.push(`${app.name} stopped after ${Object.keys(readings[app.name]).length} states: ${error.message}`);
    }
  }
  const differences = designDifferences(readings);
  for (const line of [...stops, ...differences]) t.diagnostic(line);
  assert.deepEqual({ stops, differences }, { stops: [], differences: [] });
});
