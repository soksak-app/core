/**
 * Runs one awaited step of the fixture and records it as the event `page.fixture.step`: a `start` record before the step and an
 * `end` record after it with the elapsed milliseconds and the error text, or null when the step succeeded. The error is rethrown.
 */
async function step(name, emitEvent, work) {
  emitEvent("info", "page.fixture.step", { step: name, phase: "start" });
  const started = performance.now();
  try {
    const result = await work();
    emitEvent("info", "page.fixture.step", { step: name, phase: "end", ms: Math.round(performance.now() - started), error: null });
    return result;
  } catch (error) {
    emitEvent("info", "page.fixture.step", { step: name, phase: "end", ms: Math.round(performance.now() - started), error: String(error?.message ?? error) });
    throw error;
  }
}

/**
 * The state that a window check starts from (docs/spec/diagnostics.md): every project is closed, the common settings are the defaults
 * with the values that the check gives, and one project of the folder `root` is open on a fresh layout. `modules` are the
 * modules `projects`, `settings` and `plane` of the page, and `emitEvent(level, event, fields)` writes each step (docs/spec/logging.md).
 */
export async function prepareFixture({ root, settings: overrides }, { projects, settings, plane, emitEvent }) {
  if (typeof root !== "string" || !root) throw new Error("diagnostics.fixture requires root");
  if (overrides !== undefined && (typeof overrides !== "object" || overrides === null || Array.isArray(overrides))) {
    throw new Error("diagnostics.fixture settings must be an object");
  }
  await step("projects.flush", emitEvent, () => projects.flush());
  for (const project of [...projects.all()]) await step("projects.close", emitEvent, () => projects.close(project.id));
  // The common settings given by the check are applied together with the defaults in one step. A surface that opens starts with those values, and the change notification is sent once.
  await step("settings.set", emitEvent, () => settings.set({ ...structuredClone(settings.defaults), ...overrides }, "common", "diagnostics.fixture"));
  await step("projects.open", emitEvent, () => projects.open({ root, color: "#ffb36b", layout: plane.fresh() }));
  await step("projects.flush", emitEvent, () => projects.flush());
  return { root };
}
