/**
 * Runs one awaited step of the fixture and records it as the event `workbench.fixture.step`: a `start` record before the step and an
 * `end` record after it with the elapsed milliseconds and the error text, or null when the step succeeded. The error is rethrown.
 */
async function step(name, emitEvent, work) {
  emitEvent("info", "workbench.fixture.step", { step: name, phase: "start" });
  const started = performance.now();
  try {
    const result = await work();
    emitEvent("info", "workbench.fixture.step", { step: name, phase: "end", ms: Math.round(performance.now() - started), error: null });
    return result;
  } catch (error) {
    emitEvent("info", "workbench.fixture.step", { step: name, phase: "end", ms: Math.round(performance.now() - started), error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

// The renderer input is diagnostic data, not another debug layout. Validate the
// whole listing before a fixture can mutate projects/settings or its provider.
export function validateDebugEntries(value) {
  if (value === undefined) return null;
  if (!Array.isArray(value)) throw new Error("diagnostics.fixture debugEntries must be an array");
  const paths = new Set();
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) ||
        Object.keys(entry).sort().join(",") !== "modified,path,size" ||
        typeof entry.path !== "string" || !entry.path.startsWith("logs/") || /[\\:\0]/.test(entry.path) ||
        entry.path.split("/").some(part => !part || part === "." || part === "..") || paths.has(entry.path) ||
        !Number.isSafeInteger(entry.size) || entry.size < 0 || !Number.isSafeInteger(entry.modified) || entry.modified < 0) {
      throw new Error("diagnostics.fixture debugEntries contains an invalid or duplicate file");
    }
    paths.add(entry.path);
  }
  return structuredClone(value);
}

/**
 * The state that a window check starts from (docs/spec/diagnostics.md): every project is closed, the common settings are the defaults
 * with the values that the check gives, and one project of the folder `root` is open on a fresh layout. `modules` are the
 * modules `projects`, `settings` and `plane` of the page, and `emitEvent(level, event, fields)` writes each step (docs/spec/logging.md).
 */
export async function prepareFixture({ root, settings: overrides, debugEntries }, { projects, settings, plane, debug, emitEvent }) {
  if (typeof root !== "string" || !root) throw new Error("diagnostics.fixture requires root");
  if (overrides !== undefined && (typeof overrides !== "object" || overrides === null || Array.isArray(overrides))) {
    throw new Error("diagnostics.fixture settings must be an object");
  }
  const entries = validateDebugEntries(debugEntries);
  // The awaited steps inside the project operations are steps of the fixture too, so a project step that does not end names the
  // step of the operation that it waits for.
  projects.runSteps((name, work) => step(name, emitEvent, work));
  try {
    await step("projects.flush", emitEvent, () => projects.flush());
    for (const project of [...projects.all()]) await step("projects.close", emitEvent, () => projects.close(project.id));
    // The common settings given by the check are applied together with the defaults in one step. A surface that opens starts with those values, and the change notification is sent once.
    await step("settings.set", emitEvent, () => settings.set({ ...structuredClone(settings.defaults), ...overrides }, "common", "diagnostics.fixture"));
    await step("projects.open", emitEvent, () => projects.open({ root, color: "#ffb36b", layout: plane.fresh() }));
    await step("projects.flush", emitEvent, () => projects.flush());
  } finally {
    projects.runSteps(null);
  }
  debug.setDebugFixtureEntries(entries);
  return { root };
}
