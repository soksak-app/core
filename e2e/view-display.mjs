// Measures view display through the declared window-check session interface.
import assert from "node:assert/strict";

const PRESENTATION_PHASES = new Set(["requested", "result", "presented", "abandoned"]);

/**
 * The presentation-join phases of one view surface and the reasons of its presentation-abandoned rows, from trace rows (the
 * traceRows of the event log). `phases` lists the view.presentation-join rows of the surface in row order; `abandoned` lists
 * the reasons of its view.presentation-abandoned rows (docs/spec/native-surfaces.md#view-surfaces).
 */
export function viewPresentationJoins(rows, surface) {
  if (!Array.isArray(rows)) throw new TypeError("presentation trace rows must be an array");
  if (typeof surface !== "string" || surface.length === 0) throw new TypeError("presentation surface must be nonempty");
  const phases = [];
  const abandoned = [];
  for (const row of rows) {
    if (row?.layer !== "host" || row.surface !== surface) continue;
    if (row.event === "view.presentation-join") {
      if (!PRESENTATION_PHASES.has(row.phase)) {
        throw new Error(`presentation join of ${surface} has unknown phase: ${JSON.stringify(row)}`);
      }
      phases.push(row.phase);
    } else if (row.event === "view.presentation-abandoned") {
      abandoned.push(row.reason);
    }
  }
  return { phases, abandoned };
}

/**
 * The view surfaces of core.surfaces that hold a view web view, which host.window counts in appDomWebviews beside the app DOM
 * (docs/spec/native-surfaces.md): every loaded view, shown or not. A tab that is not active in its card keeps its view as a
 * retained view (docs/spec/exposure.md), an unloaded view released its web view, and a placeholder has none. Returns
 * `{tabs, sections}`; a view in another state (restoring) fails, because its web view is not settled.
 */
export function viewWebviews(surfaces) {
  if (!Array.isArray(surfaces)) throw new TypeError("core.surfaces must be an array");
  const views = surfaces.filter((item) => item.placeholder == null && item.composition === "view");
  const unsettled = views.filter((item) => item.state !== "loaded" && item.state !== "unloaded");
  if (unsettled.length > 0) {
    throw new Error(`views without a settled web view: ${unsettled.map((item) => `${item.surface} ${item.state}`).join(", ")}`);
  }
  const loaded = views.filter((item) => item.state === "loaded");
  return { tabs: loaded.filter((item) => item.kind === "tab"), sections: loaded.filter((item) => item.kind === "section") };
}

/**
 * The web views that host.window counts in appDomWebviews: the main page of a window that has one and one view web view for each
 * loaded view surface (viewWebviews). A window of the Wails and Tauri hosts has one app DOM web view, its main page, and a window of
 * the mygo host has none (docs/spec/plugins.md#surface-ownership, docs/spec/native-surfaces.md). `mainPage` tells whether the window
 * has a main page. Returns `{mainPages, tabs, sections, count}`.
 */
export function appDomWebviews(surfaces, { mainPage } = {}) {
  if (typeof mainPage !== "boolean") throw new TypeError("appDomWebviews needs mainPage, whether the window has a main page");
  const { tabs, sections } = viewWebviews(surfaces);
  const mainPages = mainPage ? 1 : 0;
  return { mainPages, tabs, sections, count: mainPages + tabs.length + sections.length };
}

/** The placement of a host surface row with phase `placed` (the frame and visibility of a view), validated at the boundary. */
function placementOf(row) {
  for (const key of ["x", "y", "w", "h"]) {
    if (!Number.isFinite(row[key])) throw new Error(`placed row of ${row.surface} has no finite ${key}: ${JSON.stringify(row)}`);
  }
  if (typeof row.visible !== "boolean") throw new Error(`placed row of ${row.surface} has no boolean visible: ${JSON.stringify(row)}`);
  return `${row.x},${row.y},${row.w},${row.h},${row.visible}`;
}

/**
 * The surfaces of `surfaces` whose committed placement changed during a drag window. `baselineRows` are the trace rows before the
 * window and `windowRows` the rows of the window, in trace order. The placement of a surface is the frame and visibility of its last
 * `placed` row; its first row in the window is compared with the placement of its last row in the baseline. A surface with a `created`
 * row starts a new root-view generation and is a change (docs/spec/plugin-processes.md, rule 6), and so is a surface created in the
 * baseline before its first placed row. The baseline covers the lifetime of each surface: a surface of `surfaces` with a placed row in
 * the window and neither a created nor a placed row in the baseline is rejected, because its placement at the window start is unknown.
 * A surface without a row in the window is not a change.
 */
export function expectedPresentations(baselineRows, windowRows, surfaces) {
  if (!Array.isArray(baselineRows)) throw new TypeError("baseline rows must be an array");
  if (!Array.isArray(windowRows)) throw new TypeError("window rows must be an array");
  if (!Array.isArray(surfaces)) throw new TypeError("surfaces must be an array");
  const isSurfaceRow = (row) => row?.layer === "host" && row.event === "surface" && (row.phase === "placed" || row.phase === "created");
  const last = new Map();
  const covered = new Set();
  for (const row of baselineRows) {
    if (!isSurfaceRow(row)) continue;
    covered.add(row.surface);
    if (row.phase === "created") last.delete(row.surface);
    else last.set(row.surface, placementOf(row));
  }
  const wanted = new Set(surfaces);
  const changed = new Set();
  for (const row of windowRows) {
    if (!isSurfaceRow(row)) continue;
    if (row.phase === "created") {
      changed.add(row.surface);
      covered.add(row.surface);
      last.delete(row.surface);
      continue;
    }
    if (wanted.has(row.surface) && !covered.has(row.surface)) {
      throw new Error(`baseline rows hold no created or placed row of ${row.surface}; its placement at the window start is unknown`);
    }
    const placement = placementOf(row);
    if (last.get(row.surface) !== placement) changed.add(row.surface);
    last.set(row.surface, placement);
  }
  return surfaces.filter((surface) => changed.has(surface));
}

/**
 * The raster identity of a presented image region: its generation, raster, and the size and scale of that raster. A later sequence of
 * the same raster keeps this identity (docs/spec/host-contract.md, images.wait.continuous-raster-snapshot).
 */
export function rasterIdentity(presented) {
  if (presented === null || typeof presented !== "object") throw new TypeError("presented raster must be an object");
  const identity = {};
  for (const key of ["generation", "raster", "width", "height", "scale"]) {
    if (presented[key] === undefined) throw new TypeError(`presented raster has no ${key}: ${JSON.stringify(presented)}`);
    identity[key] = presented[key];
  }
  return identity;
}

/**
 * Runs the view display assertions. Each view opens under a recording, which is the evidence of its display. `vehicles` names the
 * view plugins to open, each of which must be an installed enabled view plugin; without it every installed enabled view plugin opens.
 */
export async function observeViewDisplay(s, t, verifyContent, paramsForPlugin = () => undefined, vehicles) {
  // Each view opens as a new tab of the focused card, the card of the start tab of the check.
  const card = (await s.get("core.grid")).cards.find((item) => item.focused);
  assert.ok(card, "the grid has no focused card for the opened views");
  const installed = await s.get("core.plugins");
  assert.equal(installed.error, null, `installed plugins failed: ${installed.error}`);
  const installedViews = installed.plugins.filter((plugin) => plugin.installed?.enabled && plugin.composition === "view");
  t.diagnostic(`installed view plugins: ${installedViews.map((plugin) => plugin.id).join(", ") || "none"}`);
  const views = vehicles === undefined ? installedViews : vehicles.map((id) => {
    const view = installedViews.find((plugin) => plugin.id === id);
    assert.ok(view, `${id} is not an installed enabled view plugin: ${JSON.stringify(installed.plugins)}`);
    return view;
  });
  assert.ok(views.length > 0, vehicles === undefined
    ? `core.plugins lists no installed enabled plugin with composition view: ${JSON.stringify(installed.plugins)}`
    : "the display check names no view plugin to open");
  for (const view of views) {
    const recording = await s.record({});
    let displayed = 0;
    let stopped;
    let tab;
    let verifyShown;
    try {
      try {
        ({ tab } = await s.run("core.card.add-tab", { card: card.id, plugin: view.id, params: paramsForPlugin(view.id) }));
        await s.until("core.surfaces", (all) => all.some((item) => item.surface === tab && item.visible
          && item.exposes.includes("status core.surface.document")), `view ${view.id} did not show its document`);
        const document = await s.get("core.surface.document", tab);
        if (verifyContent) verifyShown = await verifyContent({ plugin: view.id, tab, document });
        ({ displayed } = await s.presented());
      } finally {
        stopped = await recording.stop({ after: displayed ? displayed + 100 : 0 });
      }
      const now = (await s.get("core.surfaces")).find((item) => item.surface === tab && item.visible);
      assert.ok(now, `${view.id}: opened tab ${tab} is not visible`);
      assert.equal(now.status.phase, "ready", `${view.id}: surface failed: ${now.status.error}`);
      assert.equal(now.composition, "view", `${view.id} reports composition ${now.composition}`);
      assert.deepEqual((await s.get("core.surface.document", tab)).unbound, [],
        `${view.id}: ready view document controls without a command or element name`);
      if (verifyShown) await verifyShown();
      t.diagnostic(`${view.id}: recording ${stopped.frames}, ${stopped.count} written, ${stopped.missed} missed and ${stopped.late} late stills`);
    } finally {
      if (tab) {
        await s.run("core.tab.close", { tab });
        await s.until("core.surfaces", (all) => !all.some((item) => item.surface === tab),
          `view ${view.id} tab ${tab} did not close`);
      }
    }
  }
  assert.deepEqual((await s.get("core.workbench.audit")).unbound, [], "workbench controls without a command or element name");
}

/**
 * Opens each view plugin of `vehicles` (by default the plugins of the content cases) and requires each to have an explicit content
 * case before accepting its display.
 */
export async function checkViewDisplay(s, t, contentCases = new Map(), vehicles = [...contentCases.keys()]) {
  await observeViewDisplay(s, t, async (observation) => {
    const content = contentCases.get(observation.plugin);
    assert.equal(typeof content?.ready, "function",
      `${observation.plugin}: tab ${observation.tab} has no explicit content case`);
    const verifyShown = await content.ready(s, observation);
    assert.equal(typeof verifyShown, "function",
      `${observation.plugin}: tab ${observation.tab} has no content verifier`);
    return verifyShown;
  }, (plugin) => contentCases.get(plugin)?.params, vehicles);
}
