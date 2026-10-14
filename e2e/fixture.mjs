// Starting layout of the core window checks. The default layout of diagnostics.fixture has a terminal tab, so the preparation opens
// the layout through prepareFixture of the harness and waits until that terminal is ready (this module knows the terminal until
// F25.2 replaces the core checks with a fixture plugin).
import { fileURLToPath } from "node:url";
import { keepCommonSettings, prepareFixture, TRACE } from "@soksak/window-check/app.mjs";
import { currentEventOffsets, readEvents, traceRows, untilEventLine } from "@soksak/window-check/event-log.mjs";

/** The shell of the window-check terminal. It avoids a prompt that depends on the profile of the login shell. */
const CHECK_SHELL = fileURLToPath(new URL("./check-shell", import.meta.url));

/**
 * Puts an inner left sidebar on the terminal card. The default layout has no card sidebar, so a check of the card sidebar
 * adds the set set-files (files.tree, files.bookmarks, list) and the card-left link of the terminal to the common settings. When the check ends,
 * keepCommonSettings restores the set and the link together, so the caller does not reset sets separately.
 */
export async function terminalCardSidebar(s) {
  await keepCommonSettings(s);
  const sets = (await s.get("core.settings")).values.sets;
  await s.run("core.settings.set", { patch: { sets: [...sets,
    { id: "set-files", title: "파일", sections: ["files.tree", "files.bookmarks"], layout: "list" }] }, scope: "common" });
  await s.run("core.settings.link", { place: "card-left", plugin: "terminal", set: "set-files", scope: "common" });
  await s.until("core.sidebars", (value) => value.some((item) => item.sidebar === "terminal:left"),
    "the terminal card sidebar did not appear");
}

/** The surface registration rows of the trace that the event log gained after the offsets. */
async function registrationTimeline(s, offsets) {
  await s.flushLog();
  return traceRows(readEvents(s.app.configDir, offsets).events).filter((row) => row.event === "surface.registration");
}

/** Puts the window in the start state of a check, waits until the terminal of the window check is ready with the check shell (check-shell), and returns that terminal. */
export async function fresh(s, { performanceTrace = TRACE, settings = {} } = {}) {
  const traceOffsets = currentEventOffsets(s.app.configDir);
  // The terminal of a window check starts with the check shell (check-shell), whatever the login shell of the user is.
  await prepareFixture(s, { settings: { ...settings, "terminal.shell": CHECK_SHELL }, performanceTrace });
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
      x.exposes.includes("dom terminal.view")),
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
    x.exposes.includes("dom terminal.view"));
  for (const terminal of terminals) {
    await s.until("core.surface.document", (doc) => doc !== null && doc.readyState === "complete" && doc.themed,
      `terminal ${terminal.surface} did not apply its theme`, { surface: terminal.surface });
  }
  return terminals;
}

/**
 * Waits until the page of the window has reloaded after a plugin operation that changed installed.json
 * (docs/spec/installation.md#applying-a-change). `offsets` are the positions of the event files before the operation: the new
 * document writes `page.start`, and `host.windows`, which the host answers while the page reloads, then reports the page ready.
 */
export async function pluginChangeApplied(s, offsets, action) {
  await untilEventLine(s.app.configDir, offsets, (line) => line.includes("page.start"), 30000);
  await s.windows(1, `the page was not ready again after ${action}`);
}

