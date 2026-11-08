// Starting layout of the core window checks. The default layout of diagnostics.fixture has a terminal tab, so the preparation opens
// the layout through prepareFixture of the harness and waits until that terminal is ready (this module knows the terminal until
// F25.2 replaces the core checks with a fixture plugin).
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { keepCommonSettings, prepareFixture, TRACE } from "@soksak/window-check/app.mjs";
import { currentEventOffsets, readEvents, traceRows, untilEventLine } from "@soksak/window-check/event-log.mjs";
import { catalogOf } from "../scripts/check-events.mjs";

/** The shell of the window-check terminal. It avoids a prompt that depends on the profile of the login shell. */
const CHECK_SHELL = fileURLToPath(new URL("./check-shell", import.meta.url));
const CHECK_ZSH = fileURLToPath(new URL("./check-zsh", import.meta.url));

/**
 * Puts an inner left sidebar on the terminal card. The default layout has no card sidebar, so a check of the card sidebar
 * adds the set set-files (files.tree, files.bookmarks, list) and the card-left link of the terminal to the common settings. When the check ends,
 * keepCommonSettings restores the set and the link together, so the caller does not reset sets separately.
 */
export async function terminalCardSidebar(s, { sections = ["files.tree", "files.bookmarks"] } = {}) {
  await keepCommonSettings(s);
  const sets = (await s.get("core.settings")).values.sets;
  await s.run("core.settings.set", { patch: { sets: [...sets,
    { id: "set-files", title: "파일", sections, layout: "list" }] }, scope: "common" });
  await s.run("core.settings.link", { place: "card-left", plugin: "terminal", set: "set-files", scope: "common" });
  await s.until("core.sidebars", (value) => value.some((item) => item.sidebar === "terminal:left"),
    "the terminal card sidebar did not appear");
}

/** The event catalog of this repository (docs/spec/logging.md#catalog). */
const CATALOG = fileURLToPath(new URL("../docs/spec/events.json", import.meta.url));

export function terminalCheckShell(shell = "check") {
  if (shell === "check") return CHECK_SHELL;
  if (shell === "zsh") return CHECK_ZSH;
  throw new Error(`unsupported terminal check shell ${JSON.stringify(shell)}`);
}

/**
 * The declarations of the records that a check reads: the catalog of this repository joined with the catalogs of the sidecars
 * installed in the configuration folder of the application.
 */
export const recordCatalog = (app) => catalogOf(JSON.parse(readFileSync(CATALOG, "utf8")), app.configDir);

/** The declaration `{ catalog, records }` of a wait of `untilEventLines` on the records that the predicate reads. */
export const reading = (app, records) => ({ catalog: recordCatalog(app), records });

/** The surface registration rows of the trace that the event log gained after the offsets. */
async function registrationTimeline(s, offsets) {
  await s.flushLog();
  return traceRows(readEvents(s.app.configDir, offsets).events).filter((row) => row.event === "surface.registration");
}

/**
 * Puts the window in the start state of a check, waits until the terminal of the window check is ready with its fixed shell
 * fixture, and returns that terminal. `shell` is `check` by default or `zsh` for the tracked ZLE case. `log` is the log policy
 * that the check declares and `reads` the records below `error` that it reads (prepareFixture); with the performance trace the
 * registration timeline of a failed start is read too.
 */
/** The file of the disposable configuration that holds the registry of the application while a check uses its own registry. */
const heldRegistryFile = (s) => join(s.app.configDir, "check-registry.json");

/**
 * Sets a registry of the check. The first change records the registry that the application had. The record outlives a restore
 * that fails, so the registry of a failed run is never taken for the registry of the application.
 */
export async function useRegistry(s, index) {
  const held = heldRegistryFile(s);
  if (!existsSync(held)) writeFileSync(held, JSON.stringify({ registry: (await s.get("core.plugins")).registry }));
  await s.run("core.plugins.registry", { index });
}

/** Restores the recorded registry and removes the record; without a record the check changed no registry. */
export async function restoreRegistry(s) {
  const held = heldRegistryFile(s);
  if (!existsSync(held)) return;
  await s.run("core.plugins.registry", { index: JSON.parse(readFileSync(held, "utf8")).registry });
  rmSync(held);
}

export async function fresh(s, { performanceTrace = TRACE, settings = {}, log = {}, reads = [], shell = "check" } = {}) {
  const traceOffsets = currentEventOffsets(s.app.configDir);
  const declared = performanceTrace ? [...reads, "workbench.trace.surface.registration"] : reads;
  const shellPath = terminalCheckShell(shell);
  // Window checks use fixed shell fixtures; the activation ZLE case never reads user shell startup files.
  await prepareFixture(s, { settings: { ...settings, "terminal.shell": shellPath }, performanceTrace, log, reads: declared,
    catalog: declared.length ? recordCatalog(s.app) : undefined });
  // A record that remains belongs to an earlier run whose restore failed.
  await restoreRegistry(s);
  let terminal;
  try {
    [terminal] = await terminalReady(s);
  } catch (error) {
    if (!performanceTrace) throw error;
    throw new Error(`${error.message}; registration timeline: ${JSON.stringify(await registrationTimeline(s, traceOffsets))}`, { cause: error });
  }
  await s.presented();
  try {
    await s.get("terminal.session", terminal.surface);
  } catch (error) {
    throw new Error(`terminal readiness returned stale surface ${terminal.surface}: ${error.message}; ` +
      `current surfaces: ${JSON.stringify(await s.get("core.surfaces"))}`);
  }
  return terminal;
}

/** Waits until the visible terminal surfaces are registered and apply their theme, then returns those surfaces. */
export async function terminalReady(s) {
  await s.until("core.surfaces",
    (all) => all.some((x) => x.visible && x.plugin === "terminal" &&
      x.exposes.includes("status core.surface.document") &&
      x.exposes.includes("status terminal.session") &&
      x.exposes.includes("element terminal.view")),
    "no visible terminal surface registered its document, session, and view");
  // A notification that satisfies the predicate can describe the surface just before a reload replaces it.
  // The function reads the current registry before it returns the id. It does not
  // proceed with a stale surface id.
  const active = new Set((await s.get("core.grid")).cards
    .map((card) => card.active)
    .filter(Boolean));
  const terminals = (await s.surfaces("terminal")).filter((x) => active.has(x.surface) &&
    x.exposes.includes("status core.surface.document") &&
    x.exposes.includes("status terminal.session") &&
    x.exposes.includes("element terminal.view"));
  for (const terminal of terminals) {
    await s.until("core.surface.document", (doc) => doc !== null && doc.readyState === "complete" && doc.themed,
      `terminal ${terminal.surface} did not apply its theme`, { surface: terminal.surface });
  }
  return terminals;
}

/**
 * Waits until the page of the window has reloaded after a plugin operation that changed installed.json
 * (docs/spec/installation.md#applying-a-change). `offsets` are the positions of the event files before the operation: the new
 * document writes `workbench.start`, and `host.windows`, which the host answers while the page reloads, then reports the page ready.
 */
export async function pluginChangeApplied(s, offsets, action) {
  await untilEventLine(s.app.configDir, offsets, (line) => line.includes("workbench.start"), 30000, reading(s.app, ["workbench.start"]));
  await s.windows(1, `the page was not ready again after ${action}`);
}


/** Prepares a real visible occlusion baseline without raising or activating a
 * window. The caller supplies only windows of its declared diagnostic cohort. */
export async function prepareOcclusionFixture(target, otherWindows) {
  const key = session => `${session.app.name}/${session.window}`;
  if (!target || !Array.isArray(otherWindows)) throw new TypeError("placement fixture requires an explicit owned cohort");
  const own = key(target), seen = new Set();
  for (const other of otherWindows) {
    const identity = key(other);
    if (identity === own) throw new Error("placement target cannot belong to the parked cohort");
    if (seen.has(identity)) throw new Error("placement fixture has duplicate parked window ownership");
    seen.add(identity);
  }
  const validFrame = frame => frame && ["x","y","width","height"].every(field=>Number.isFinite(frame[field]))
    && frame.width>0 && frame.height>0;
  const inactiveCount = state => {
    const observation = state?.activationObservation;
    if (state?.active !== false || observation?.registered !== true
      || typeof observation.count !== "string" || !/^(0|[1-9]\d*)$/.test(observation.count)) {
      throw new Error("placement fixture preparation requires actual inactive activation observation");
    }
    return observation.count;
  };
  const before = await target.get("host.window"), count = inactiveCount(before);
  const [screen] = await target.get("host.screens"), area = screen?.visible;
  if (!validFrame(before.frame) || !validFrame(area)) throw new Error("placement fixture preparation has invalid public screen/window geometry");
  const snapshots = [{ session: target, frame: { ...before.frame }, count }];
  for (const session of otherWindows) {
    const state = await session.get("host.window");
    if (!validFrame(state.frame)) throw new Error("placement fixture preparation has invalid owned cohort geometry");
    snapshots.push({ session, frame: { ...state.frame }, count: inactiveCount(state) });
  }
  for (const { frame } of snapshots) {
    if (frame.width>area.width || frame.y<area.y || frame.y+frame.height>area.y+area.height)
      throw new Error("placement fixture preparation cannot keep normal owned frames within the visible work area");
  }
  // Register the target and entire original cohort before any mutation, including a move
  // that fails after earlier windows have already moved.
  if (snapshots.length) target.cleanup(async () => {
    const failures = [];
    for (const { session, frame, count: originalCount } of snapshots) {
      try {
        const state = await session.get("host.window");
        if (state.frame.x !== frame.x || state.frame.y !== frame.y)
          await session.run("host.window.move", { x: frame.x, y: frame.y });
        const restored = await session.until("host.window", value =>
          ["x","y","width","height"].every(field=>value.frame[field]===frame[field]),
        "placement fixture did not restore the exact owned cohort frame");
        if (inactiveCount(restored) !== originalCount) throw new Error("placement cohort activation count changed during restoration");
      } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures,"placement owned cohort restoration failed");
  });
  const parked = [];
  for (const { session, frame, count: originalCount } of snapshots) {
    // A real inactive normal-frame observation established this exposed edge:
    // target left, other declared cohort windows right. Do not raise or resize.
    const x = session === target ? area.x : area.x + area.width - frame.width;
    if (frame.x !== x) await session.run("host.window.move", { x, y: frame.y });
    const actual = await session.until("host.window", value => value.frame.x===x && value.frame.y===frame.y
      && value.frame.width===frame.width && value.frame.height===frame.height,
    "placement fixture owned cohort move did not reach its exact frame");
    if (inactiveCount(actual) !== originalCount) throw new Error("placement cohort activation count changed during preparation");
    parked.push({ application:session.app.name, window:session.window, originalFrame:frame, parkedFrame:actual.frame });
  }
  // Other apps and user windows remain untouched. Their real occlusion is a
  // preparation failure, never a product failure or a reason to fake visibility.
  const baseline = await target.until("host.window", value => value.occluded === false,
    "placement fixture preparation remains occluded after owned cohort moves", { timeout: 2000 });
  if (inactiveCount(baseline) !== count) throw new Error("placement target activation count changed during preparation");
  return { before, baseline, parked };
}
