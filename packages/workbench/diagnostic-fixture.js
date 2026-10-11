/**
 * The state that a window check starts from (docs/spec/diagnostics.md): every project is closed, the common settings are the defaults
 * with the values that the check gives, and one project of the folder `root` is open on a fresh layout. `modules` are the
 * modules `projects`, `settings` and `plane` of the page.
 */
export async function prepareFixture({ root, settings: overrides }, { projects, settings, plane }) {
  if (typeof root !== "string" || !root) throw new Error("diagnostics.fixture requires root");
  if (overrides !== undefined && (typeof overrides !== "object" || overrides === null || Array.isArray(overrides))) {
    throw new Error("diagnostics.fixture settings must be an object");
  }
  await projects.flush();
  for (const project of [...projects.all()]) await projects.close(project.id);
  // The common settings given by the check are applied together with the defaults in one step. A surface that opens starts with those values, and the change notification is sent once.
  await settings.set({ ...structuredClone(settings.defaults), ...overrides }, "common", "diagnostics.fixture");
  await projects.open({ root, color: "#ffb36b", layout: plane.fresh() });
  await projects.flush();
  return { root };
}
