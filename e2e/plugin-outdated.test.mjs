// The plugin page shows a persistent service that runs another version than the installed one, and its action
// replaces the service (docs/spec/installation.md, Plugin screen; docs/spec/terminal-runtime.md#updates).
//
// No declared entry installs another version of a sidecar, so the check writes the installed version of the terminal
// service into the installed.json of its own disposable configuration directory, with a copy of the installed
// folder under the new version, and restores both in its cleanup.
import assert from "node:assert/strict";
import { cpSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { APPS, keepCommonSettings, open } from "@soksak/window-check/app.mjs";
import { readLines, readOffset } from "@soksak/window-check/application-log.mjs";
import { fresh } from "./fixture.mjs";

const SIDECAR = "@soksak/sidecar-vt-alacritty";

/** Replaces the file in one step, as `sok` does, so the host never reads half of it. */
function replaceFile(file, text) {
  const temporary = `${file}.check`;
  writeFileSync(temporary, text);
  renameSync(temporary, file);
}

/** Runs a plugin change, which reloads the window, and waits until the new page is ready. */
async function change(s, action) {
  const before = (await s.get("host.window")).pageProcess;
  await s.run(`core.plugins.${action}`, { plugin: "hwp" });
  await s.until("host.window", (value) => value.pageProcess !== 0 && value.pageProcess !== before, `${action} did not reload the window`);
  await s.until("host.windows", (list) => list.some((item) => item.window === s.window && item.ready), `the page did not report ready after ${action}`);
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: the plugin page shows an outdated terminal service and replaces it`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    await keepCommonSettings(s);
    const file = join(app.configDir, "plugins", "installed.json");
    const original = readFileSync(file, "utf8");
    const installed = JSON.parse(original);
    const running = installed.sidecars[SIDECAR];
    const newer = running.version.replace(/\d+$/, (patch) => String(Number(patch) + 1));
    const folder = running.path.replace(`/${running.version}/`, `/${newer}/`);
    assert.notEqual(folder, running.path, `the path of ${SIDECAR} does not hold its version: ${running.path}`);
    // The cleanup returns the installed version, applies it, and removes the copy only after the host stopped declaring
    // it: a host that still declares a folder that is gone fails to start its service.
    s.cleanup(async () => {
      replaceFile(file, original);
      await change(s, "enable");
      await s.until("core.plugins", (value) => value.outdated.length === 0, "the restored version still shows an outdated service");
      rmSync(join(app.configDir, folder, ".."), { recursive: true, force: true });
    });
    cpSync(join(app.configDir, running.path), join(app.configDir, folder), { recursive: true });
    installed.sidecars[SIDECAR] = { version: newer, path: folder };
    // The terminal plugin names the range that it was installed with, which the other version must satisfy.
    installed.plugins.terminal.sidecars[SIDECAR] = `>=${running.version}`;
    replaceFile(file, JSON.stringify(installed));
    // A plugin change makes the host read installed.json again; hwp is not the plugin of the service.
    await change(s, "disable");
    const outdated = await s.until("core.plugins", (value) => value.outdated.length === 1,
      "the host did not report the service of another version as outdated");
    assert.deepEqual(outdated.outdated.map(({ sidecar, running: version, installed: next }) => ({ sidecar, version, next })),
      [{ sidecar: SIDECAR, version: running.version, next: newer }]);

    await s.run("core.plugins.browse");
    await s.until("core.library", (library) => library.page === "plugins" && library.plugins.shown.length > 0, "the plugin page did not show");
    const row = await s.rect("core.library.plugins.outdated", 0);
    assert.ok(row.width > 0 && row.height > 0, `the outdated row has no size: ${JSON.stringify(row)}`);

    // The action ends the sessions of the service and replaces it; the host writes the replacement to its log.
    const offset = readOffset(app.configDir);
    const replaced = () => readLines(app.configDir, offset).lines.some((line) => line.includes(`service ${running.version} replaced by ${newer}`));
    await s.act("core.library.plugins.replace", "click");
    await s.until("host.sidecars", () => replaced(), "the replacement of the outdated service was not written to the log");
  });
}
