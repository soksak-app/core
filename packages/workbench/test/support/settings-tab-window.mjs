// The window of the settings tab for the tests: the document of index.html, the settings store in memory, and the core commands of
// core-exposure.js. The tab opens through core.settings.open and is mounted into its container, as the tab strip does in the window.
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { pageMemorySaver } from "./memory-saver.mjs";

/**
 * Starts the window. setup(settings) runs before the settings store connects, so a test can declare plugin settings.
 * connect false leaves the settings store unconnected, for a test whose page-wire case answers the first host call itself.
 * setup may return {common, projects}, the stored snapshot of the window.
 * Returns {registry, core, settings, memory, run, status, control}.
 */
export async function startSettingsTab(t, { setup = () => {}, connect = true, project = null, refuse = null } = {}) {
  // The address names the project of the window, as the window of a project does.
  const url = project === null ? "http://localhost/" : `http://localhost/?project=${encodeURIComponent(project)}`;
  const dom = new JSDOM(readFileSync(new URL("../../index.html", import.meta.url), "utf8"), { url });
  dom.window.matchMedia = (query) => ({ media: query, matches: true, addEventListener: () => {}, removeEventListener: () => {} });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.location = dom.window.location;
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  globalThis.CSS = dom.window.CSS;
  globalThis.Element = dom.window.Element;
  globalThis.addEventListener = dom.window.addEventListener.bind(dom.window);
  globalThis.PointerEvent = dom.window.PointerEvent;
  globalThis.MouseEvent = dom.window.MouseEvent;
  if (t) t.after(() => dom.window.close());

  const memory = { common: {}, projects: [], refusals: 0 };
  const settings = await import("../../settings.js");
  // setup may return the stored snapshot {common, projects} that the store holds at the start.
  Object.assign(memory, (await setup(settings)) ?? {});
  // The window starts the project list from the start document, which the project title of the scope reads.
  if (memory.projects.length > 0) {
    const open = project === null ? [] : [project];
    (await import("../../projects.js")).begin({ common: structuredClone(memory.common), projects: structuredClone(memory.projects), open });
  }
  // The settings of the project of the window are the snapshot's project overrides over the common values.
  if (project !== null) settings.beginSettings({ common: structuredClone(memory.common), projects: structuredClone(memory.projects) }, project);
  if (connect) {
    await settings.connectSettings({
      snapshot: async () => structuredClone(memory),
      settings: async (id, values) => {
        // refuse names the error of the host for every write, so a test runs the refusal of a write (docs/spec/settings.md#performance).
        if (refuse !== null) throw new Error(refuse);
        // A project value is kept in the project's settings, and an undefined value removes the stored value.
        const target = id === null ? memory.common : memory.projects.find((project) => project.id === id).settings;
        for (const [key, value] of Object.entries(values)) {
          if (value === undefined) delete target[key];
          else target[key] = value;
        }
      },
      onChange: () => () => {},
    });
  }
  const { registry } = await import("../../exposure.js");
  registry.declare("core", JSON.parse(readFileSync(new URL("../../exposure.json", import.meta.url), "utf8")).exposes);
  const core = await import("../../core-exposure.js");
  await core.installCoreExposure({
    memorySaver: await pageMemorySaver(),
    home: { state: () => null }, renames: { state: () => null }, chrome: () => null, drawn: async () => {},
  });
  const run = (name, params = {}) => registry.run(name, params);
  /** The status of the core, read as a surface reads it. */
  const status = async (name) => {
    const reply = await registry.handle({ id: 1, method: "status.get", params: { name } });
    if (reply.error) throw new Error(reply.error.message);
    return reply.result;
  };
  /** The control of the tab with the element name, optionally with its key or its index among the matches. */
  const control = (name, index = 0) => document.querySelectorAll(`[data-expose="${name}"]`)[index] ?? null;
  return { registry, core, settings, memory, run, status, control, document };
}

/** Opens the settings tab and mounts its content into the container of the window. */
export async function openSettingsTab(ctx) {
  await ctx.run("core.settings.open");
  ctx.core.mountSettingsTab(document.getElementById("settingsTab"));
}
