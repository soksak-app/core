// A window that becomes the key window reads the plugin state again, because the remote registry sends no change event
// (docs/spec/installation.md#plugin-operations-in-the-application). Only a window of the active application becomes the key window, so the check runs in the
// activation tier, which activates the application.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { APPS, keepCommonSettings, open } from "@soksak/window-check/app.mjs";
import { fresh } from "../fixture.mjs";

const REGISTRY = fileURLToPath(new URL("../../target/registry/", import.meta.url));

for (const app of Object.values(APPS)) {
  test(`${app.name}: a window that becomes active reads the registry again`, { timeout: 90000 }, async (t) => {
    const s = await open(t, app);
    // The records that decide whether the owner became key and whether the application was active when the project opened.
    await fresh(s, { log: { lifecycle: "debug" }, reads: ["host.window.event", "host.project.front", "page.window.active", "page.plugins.reread"] });
    await keepCommonSettings(s);
    // A window becomes the key window only in the active application, so the check activates the application first, as a person who
    // switches to it does (docs/spec/installation.md#plugin-operations-in-the-application).
    const content = (await s.get("host.window")).content;
    await s.pointer(content.width / 2, content.height / 2, "move", { activate: true });
    await s.until("host.window", (state) => state.active && state.key, "the window did not become the active key window");
    const before = await s.get("core.plugins");
    const installed = before.plugins.find((row) => row.id === "browser").installed.version;
    const index = JSON.parse(readFileSync(join(REGISTRY, "index.json"), "utf8"));
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
      await s.run("core.plugins.registry", { index: before.registry });
    });
    await s.run("core.plugins.registry", { index: pathToFileURL(file).href });
    await s.until("core.plugins", (value) => value.registry === pathToFileURL(file).href && value.error === null,
      "the registry did not change");
    assert.deepEqual((await s.get("core.plugins")).updates, []);

    // Another window opens, and the registry then lists a newer version. Nothing tells this window about it.
    await s.run("core.settings.set", { patch: { projectOpening: "windows" }, scope: "common" });
    const mainRoot = (await s.get("core.project")).root;
    await s.run("core.project.open", { root: projectRoot, color: "#7fe3b0" });
    const windows = await s.windows(2, "the project window did not open");
    const child = s.on(windows.find((item) => item.window !== s.window).window);
    const browser = index.plugins.find((plugin) => plugin.id === "browser");
    const newer = `${installed.split(".").slice(0, 2).join(".")}.${Number(installed.split(".")[2]) + 1}`;
    browser.versions.push({ ...structuredClone(browser.versions.at(-1)), version: newer });
    writeFileSync(file, JSON.stringify(index));
    assert.deepEqual((await s.get("core.plugins")).updates, [], "the window read the registry before it became active");

    // Opening the project of the first window makes the host focus that window, which then reads the registry.
    await child.run("core.project.open", { root: mainRoot, color: "#ffb36b" });
    const read = await s.until("core.plugins", (value) => value.updates.length > 0,
      "the window did not read the registry when it became active");
    assert.deepEqual(read.updates, [{ id: "browser", installed, latest: newer }]);
  });
}
