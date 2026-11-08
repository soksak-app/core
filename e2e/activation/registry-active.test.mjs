// A window that becomes the key window reads the plugin state again, because the remote registry sends no change event
// (docs/spec/installation.md#plugin-operations-in-the-application). The host focuses the window of a project that opens, and
// a focused window becomes the key window only in the active application; the virtual key window comes only from input and
// refuses makeKeyAndOrderFront: (docs/spec/exposure.md#virtual-key-window), so this check activates the application.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { APPS, keepCommonSettings, open } from "@soksak/window-check/app.mjs";
import { buildFixtureRegistry, nextPatch, readIndex } from "../../scripts/fixture-registry.mjs";
import { fixtureRegistry, fresh, restoreRegistry, useRegistry } from "../fixture.mjs";

/** The fixture plugin that the registry later lists in a newer version. */
const PLUGIN = "probeplain";

for (const app of Object.values(APPS)) {
  test(`${app.name}: a window that becomes active reads the registry again`, { timeout: 90000 }, async (t) => {
    const s = await open(t, app);
    // The records that decide whether the owner became key and whether the application was active when the project opened.
    await fresh(s, { log: { lifecycle: "debug" }, reads: ["host.window.event", "host.project.front", "workbench.window.active", "workbench.plugins.reread"] });
    await keepCommonSettings(s);
    // A window becomes the key window only in the active application, so the check activates the application first, as a person who
    // switches to it does (docs/spec/installation.md#plugin-operations-in-the-application).
    const content = (await s.get("host.window")).content;
    await s.pointer(content.width / 2, content.height / 2, "move", { activate: true });
    await s.until("host.window", (state) => state.active && state.key, "the window did not become the active key window");
    const before = await s.get("core.plugins");
    const installed = before.plugins.find((row) => row.id === PLUGIN).installed.version;
    const newer = nextPatch(installed);
    // The registry starts as a copy of the fixture registry of the application; the later registry is a fixture registry that lists
    // the plugin in its installed version and the next one.
    const { index } = readIndex(before.registry);
    const later = await fixtureRegistry({ sok: join(dirname(app.binary), "sok"), signal: t.signal,
      build: (sok, out, options) => buildFixtureRegistry(sok, out, { ...options, versions: { [PLUGIN]: [{ version: installed }, { version: newer }] } }) });
    s.cleanup(() => rmSync(later, { recursive: true, force: true }));
    const folder = realpathSync(mkdtempSync(join(tmpdir(), "soksak-plugin-active-")));
    const projectRoot = join(folder, "project");
    mkdirSync(projectRoot);
    const file = join(folder, "index.json");
    writeFileSync(file, JSON.stringify(index));
    s.cleanup(() => rmSync(folder, { recursive: true, force: true }));
    s.cleanup(async () => {
      for (const window of await s.get("host.windows")) {
        if (window.window !== s.window) await s.on(window.window).close();
      }
      await s.windows(1, "the check left an extra window");
      for (const project of await s.get("core.projects")) {
        if (project.root.startsWith(folder)) await s.run("core.project.close", { id: project.id });
      }
      await restoreRegistry(s);
    });
    await useRegistry(s, pathToFileURL(file).href);
    await s.until("core.plugins", (value) => value.registry === pathToFileURL(file).href && value.error === null,
      "the registry did not change");
    assert.deepEqual((await s.get("core.plugins")).updates, []);

    // Another window opens, and the registry then lists a newer version. Nothing tells this window about it.
    await s.run("core.settings.set", { patch: { projectOpening: "windows" }, scope: "common" });
    const mainRoot = (await s.get("core.project")).root;
    await s.run("core.project.open", { root: projectRoot, color: "#7fe3b0" });
    const windows = await s.windows(2, "the project window did not open");
    const child = s.on(windows.find((item) => item.window !== s.window).window);
    writeFileSync(file, JSON.stringify(readIndex(pathToFileURL(join(later, "index.json")).href).index));
    assert.deepEqual((await s.get("core.plugins")).updates, [], "the window read the registry before it became active");

    // Opening the project of the first window makes the host focus that window, which then reads the registry.
    await child.run("core.project.open", { root: mainRoot, color: "#ffb36b" });
    const read = await s.until("core.plugins", (value) => value.updates.length > 0,
      "the window did not read the registry when it became active");
    assert.deepEqual(read.updates, [{ id: PLUGIN, installed, latest: newer }]);
  });
}
