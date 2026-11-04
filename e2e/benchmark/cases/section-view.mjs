// The section views of the view benchmark (docs/plans/mygo-host.md, S7): each section view of the enabled installed plugins is measured
// for (i), (ii), (iii), (iii-b), (v) and (viii) of plugin processes, through the section-view contract of
// docs/spec/plugin-processes.md#section-views. A section view whose plugin does not declare that contract fails with its plugin and section.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { effectiveCardCornerRadiusPt } from "../../view-frame-geometry.mjs";
import { collectViewReclaimMeasurements, collectViewStartAndMemory, waitForViewReadiness } from "../../view-metrics-collection.mjs";
import { activeCoreTheme, markerDragObservation, markerLayoutObservation, requireMarkerColor } from "./marker-view.mjs";

const INSTALLED_FORMAT = 3;

/**
 * The section views of the enabled installed plugins of the configuration folder `configDir`, in the order of plugin id and then of the
 * plugin's `sections`: { plugin, section, page, diagnostics }, where `page` is the page of the section's view composition and
 * `diagnostics` the content of the plugin's diagnostics.json in its recorded path, or null when the package holds none. A folder without
 * plugins/installed.json, a file of another format, or no section view at all is an error.
 */
export function installedSectionViews(configDir) {
  const path = join(configDir, "plugins", "installed.json");
  if (!existsSync(path)) throw new Error(`${path} does not exist, so no plugin with a section view is installed`);
  const installed = JSON.parse(readFileSync(path, "utf8"));
  if (installed.format !== INSTALLED_FORMAT) throw new Error(`${path}: format must be ${INSTALLED_FORMAT}, not ${installed.format}`);
  const views = [];
  for (const [plugin, record] of Object.entries(installed.plugins).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (!record.enabled) continue;
    const folder = join(configDir, record.path);
    const manifest = JSON.parse(readFileSync(join(folder, "plugin.json"), "utf8"));
    const diagnosticsPath = join(folder, "diagnostics.json");
    const diagnostics = existsSync(diagnosticsPath) ? JSON.parse(readFileSync(diagnosticsPath, "utf8")) : null;
    // default: sections is an optional field of plugin.json; a plugin without it has no section view.
    for (const section of manifest.sections ?? []) {
      views.push({ plugin, section: section.id, page: section.composition.page, diagnostics });
    }
  }
  if (views.length === 0) throw new Error("no enabled installed plugin declares a section view");
  return views;
}

/** The names of the section-view contract that a plugin `plugin` declares in its diagnostics.json, by kind of its exposes. */
function contractNames(plugin) {
  return { commands: [`${plugin}.view.frames`, `${plugin}.view.history`], status: [`${plugin}.view.ready`] };
}

/** The `const` string that the schema `schema` of a `<plugin>.view.ready` status declares for its field `field`, or null. */
function readyConst(schema, field) {
  // default: properties is optional in a JSON Schema; a schema without it declares no const field.
  const value = schema?.properties?.[field]?.const;
  return typeof value === "string" ? value : null;
}

/**
 * Returns the section view `view` (installedSectionViews) with the `content` and `language` that its view shows, when the diagnostics
 * declaration of its plugin declares the commands `<plugin>.view.frames` and `<plugin>.view.history` and the status `<plugin>.view.ready`,
 * and the schema of that status declares `content` and `language` each as a `const` string; otherwise it fails with its plugin and section,
 * and for a missing `const` with its field.
 */
export function requireSectionDeclarations(view) {
  const exposes = view.diagnostics?.exposes;
  const declares = Object.entries(contractNames(view.plugin)).every(([kind, names]) => {
    // default: each list of exposes is optional; a missing list declares no entry of its kind.
    const declared = new Set((exposes?.[kind] ?? []).map((entry) => entry.name));
    return names.every((name) => declared.has(name));
  });
  if (!declares) {
    throw new Error(`${view.plugin} section view ${view.section} does not declare ${view.plugin}.view.frames, ` +
      `${view.plugin}.view.history and ${view.plugin}.view.ready in its diagnostics declaration`);
  }
  const ready = exposes.status.find((entry) => entry.name === `${view.plugin}.view.ready`);
  const content = readyConst(ready.schema, "content");
  const language = readyConst(ready.schema, "language");
  const missing = [content === null ? "content" : null, language === null ? "language" : null].filter(Boolean);
  if (missing.length > 0) {
    throw new Error(`${view.plugin} section view ${view.section} declares ${view.plugin}.view.ready without a const ${missing.join(" and ")}`);
  }
  return { ...view, content, language };
}

/** The plugin whose cards hold the card-left sidebar that shows the measured section (terminalCardSidebar of e2e/fixture.mjs). */
const ANCHOR_PLUGIN = "terminal";

const hasAnchorTab = (card) => card?.tabs?.some((tab) => typeof tab?.id === "string" && tab.id.length > 0 && tab.plugin === ANCHOR_PLUGIN);

/** The id of the tallest card of `grid` with a terminal tab, the first in document order among equals; none is an error. */
function tallestAnchorCard(grid, plugin) {
  const cards = (grid?.cards ?? []).filter(hasAnchorTab);
  if (cards.length === 0) throw new Error(`core.grid has no card with a terminal tab to split for the section view of ${plugin}`);
  return cards.reduce((tallest, card) => (card.h > tallest.h ? card : tallest)).id;
}

/** The card sidebar of `sidebars` (core.sidebars) that holds the section surface `surface`, or undefined. */
const sidebarOfSurface = (sidebars, surface) => sidebars.find((row) => row.placement === "card"
  && row.sections?.some((item) => item.surfaceId === surface));

/**
 * The placement of a section view, the `placement` of its view descriptor ({ card, open, close } of TAB_PLACEMENT in
 * e2e/view-metrics-collection.mjs). The window shows the measured section alone in the card-left sidebar of every terminal card
 * (terminalCardSidebar of e2e/fixture.mjs):
 *   card   the preferred card when it has a terminal tab, else the first card with one; its terminal tab is the anchor
 *   open   splits the tallest card with a terminal tab at its bottom with core.card.split and a new terminal tab, and resolves with
 *          the section surface `params.section` of the card-left sidebar of the new card, as core.sidebars reports it
 *   close  closes the card whose card sidebar holds the section surface and waits until core.surfaces no longer lists it
 */
export const SECTION_PLACEMENT = Object.freeze({
  card(grid, plugin, preferred) {
    const card = grid?.cards?.find((item) => item.id === preferred && hasAnchorTab(item)) ?? grid?.cards?.find(hasAnchorTab);
    if (!card) throw new Error(`core.grid has no card with a terminal tab, whose card-left sidebar shows the section view of ${plugin}`);
    return card.id;
  },
  async open(s, { plugin, params }) {
    const section = params?.section;
    if (typeof section !== "string" || section.length === 0) {
      throw new Error(`the section placement of ${plugin} requires params.section, the id of the section, not ${JSON.stringify(section)}`);
    }
    const target = tallestAnchorCard(await s.get("core.grid"), plugin);
    const split = await s.run("core.card.split", { card: target, side: "bottom", plugin: ANCHOR_PLUGIN });
    assert.ok(typeof split?.card === "string" && split.card.length > 0, `core.card.split of ${target} answered no card`);
    s.cleanup(async () => {
      const grid = await s.get("core.grid");
      if (!grid.cards.some((item) => item.id === split.card)) return;
      const result = await s.run("core.card.close", { card: split.card });
      assert.equal(result?.closed, true, `section view card ${split.card} did not close during cleanup`);
      await s.until("core.grid", (value) => !value.cards.some((item) => item.id === split.card),
        `section view card ${split.card} remained during cleanup`);
    });
    const sidebar = `${split.card}:left`;
    const sectionOf = (rows) => rows.find((row) => row.sidebar === sidebar)?.sections?.find((item) => item.id === section);
    const sidebars = await s.until("core.sidebars", (rows) => sectionOf(rows) !== undefined,
      `card ${split.card} did not show the section ${section} in its card-left sidebar ${sidebar}`);
    return sectionOf(sidebars).surfaceId;
  },
  async close(s, surface, { cleanup }) {
    const sidebar = sidebarOfSurface(await s.get("core.sidebars"), surface);
    if (!sidebar) throw new Error(`section view ${surface} is in no card sidebar${cleanup ? " during cleanup" : ""}`);
    const result = await s.run("core.card.close", { card: sidebar.card });
    assert.equal(result?.closed, true, `card ${sidebar.card} of section view ${surface} did not close${cleanup ? " during cleanup" : ""}`);
    await s.until("core.surfaces", (items) => !items.some((item) => item.surface === surface),
      `section view ${surface} remained registered ${cleanup ? "during cleanup" : "after close"}`);
  },
});

/** The drag (viii) of a section view: the top boundary of its card `card` (core.grid) moves 80 pt down and back once. */
export function sectionTopEdgeDragPlan(grid, card) {
  if (!Array.isArray(grid?.lines?.y) || grid.lines.y.length <= 2) {
    throw new Error("the section drag requires the measured horizontal grid lines");
  }
  if (!(Number.isInteger(card?.r0) && card.r0 > 0 && card.r0 < grid.lines.y.length - 1)) {
    throw new Error(`the section drag requires a card below another card, not a card whose top row is ${card?.r0}`);
  }
  return { axis: "y", line: card.r0, dx: 0, dy: 80, ms: 500, times: 1 };
}

/**
 * The view descriptor of the section view `view` (installedSectionViews), whose plugin declares the section-view contract
 * (requireSectionDeclarations). Its readiness waits for `<plugin>.view.ready` with `ready` true, requires the declared `content` and
 * `language` and a history of one entry; a section view holds no document region, so its region history is 0. Its content trace
 * runs `<plugin>.view.frames`, and a start answer without a marker color stops the observer and fails with the plugin and section.
 */
export function sectionViewDescriptor(view) {
  const { plugin, section, content, language } = requireSectionDeclarations(view);
  const owner = `${plugin} section view ${section}`;
  const history = async (s, surface) => {
    const answer = await s.run(`${plugin}.view.history`, {}, surface);
    assert.ok(Number.isSafeInteger(answer?.length) && answer.length >= 0,
      `${owner} answered ${plugin}.view.history on ${surface} without a length`);
    return answer.length;
  };
  return Object.freeze({
    plugin,
    section,
    placement: SECTION_PLACEMENT,
    params: Object.freeze({ section }),
    expectedContent: content,
    language,
    readinessStatus: `${plugin}.view.ready`,
    readiness: async (s, surface) => {
      const status = await s.until(`${plugin}.view.ready`, (value) => value?.ready === true,
        `${owner} did not report ${plugin}.view.ready on ${surface}`, { surface });
      assert.deepEqual({ content: status.content, language: status.language }, { content, language },
        `${owner} reported ${plugin}.view.ready on ${surface} with content and language that differ from its declaration`);
      const historyEntries = await history(s, surface);
      assert.equal(historyEntries, 1, `${owner} history on ${surface} does not contain only its initial document`);
      return { historyEntries, regionHistoryEntries: 0, status };
    },
    readDocument: async (s, surface) => ({ historyEntries: await history(s, surface), regionHistoryEntries: 0 }),
    startContentTrace: async (s, surface) => {
      const result = await s.run(`${plugin}.view.frames`, { action: "start" }, surface);
      assert.equal(result?.enabled, true, `${owner} content-frame observer did not start on ${surface}`);
      try {
        requireMarkerColor(result.markerColor, owner);
      } catch (error) {
        try {
          await s.run(`${plugin}.view.frames`, { action: "stop" }, surface);
        } catch (stopError) {
          throw new AggregateError([error, stopError], `${owner} answered a start without a marker color and did not stop on ${surface}`);
        }
        throw error;
      }
      return result;
    },
    stopContentTrace: async (s, surface) => {
      const result = await s.run(`${plugin}.view.frames`, { action: "stop" }, surface);
      assert.equal(result?.enabled, false, `${owner} content-frame observer did not stop on ${surface}`);
      return result;
    },
  });
}

/**
 * Collects the measurements of the section view of `descriptor` (sectionViewDescriptor) in the window of `s`, which shows the section
 * alone in the card-left sidebar of every terminal card: the process starts, first displays, warm reuse, total and reclaim of
 * e2e/view-metrics-collection.mjs, then the layout (v) on the y axis and the drag (viii) of the top boundary of a new section card,
 * measured with the palette of the active core theme and the marker color of each trace start.
 */
export async function collectSectionViewMeasurements(t, s, descriptor) {
  const start = await collectViewStartAndMemory(t, s, descriptor);
  const evidence = { events: [...start.events], recordings: [...start.recordings] };
  const reclaim = await collectViewReclaimMeasurements(t, s, descriptor, start.opened, evidence);
  const theme = await activeCoreTheme(s);
  const cornerRadiusPt = effectiveCardCornerRadiusPt((await s.get("core.settings")).values);
  const owner = `${descriptor.plugin} section view ${descriptor.section}`;
  const surface = await SECTION_PLACEMENT.open(s, { card: start.card, plugin: descriptor.plugin, params: descriptor.params });
  const readinessEvidence = await waitForViewReadiness(s, surface, descriptor);
  const card = sidebarOfSurface(await s.get("core.sidebars"), surface)?.card;
  assert.ok(card, `${owner} measurement surface ${surface} is in no card sidebar`);
  const layout = await markerLayoutObservation(t, s, descriptor, surface, card, { owner, theme, cornerRadiusPt, axis: "y" });
  const grid = await s.get("core.grid");
  const plan = sectionTopEdgeDragPlan(grid, grid.cards.find((item) => item.id === card));
  const drag = await markerDragObservation(t, s, descriptor, surface, card, layout.pixelPalette, { owner, plan });
  await SECTION_PLACEMENT.close(s, surface, { cleanup: false });
  return {
    plugin: descriptor.plugin,
    host: s.app.name,
    total: start.total,
    reclaim,
    warmDisplay: start.warmDisplay,
    newProcess: { processStarts: start.processStarts, firstDisplays: start.firstDisplays },
    layoutDisplay: [layout],
    drag,
    _evidence: { events: [...evidence.events, ...layout.events, ...drag.events],
      recordings: [...evidence.recordings, { directory: layout.captureDirectory }, { directory: drag.captureDirectory }],
      scratch: { surface, readinessEvidence }, pixelPalette: layout.pixelPalette },
  };
}
