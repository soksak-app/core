// The plugin page shows a persistent service that runs another version than the installed one, and its action
// replaces the service (docs/spec/installation.md, Plugin screen; docs/spec/persistent-services.md#updates).
//
// The vehicle is the fake persistent sidecar of the raster probe, which reports the version of its package in its hello. No
// declared entry installs another version of a sidecar, so the check writes another installed version of that service into
// the installed.json of its own disposable configuration directory, with a copy of the installed folder under the new
// version, and restores both in its cleanup. The running service keeps reporting the version it was built with, which is
// the running version that differs from the installed one. The replacement starts the executable of the copy, so the
// cleanup ends that service before it removes the copy: a service whose executable is gone starts no session process.
import assert from "node:assert/strict";
import { cpSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { APPS, keepCommonSettings, open } from "@soksak/window-check/app.mjs";
import { currentEventOffsets, untilEventLine } from "@soksak/window-check/event-log.mjs";
import { fresh, pluginChangeStarted, reading } from "./fixture.mjs";
import { addRasterTab, RASTER, RASTER_SIDECAR as SIDECAR } from "./raster-probe.mjs";

/** A fixture plugin that does not name the sidecar: disabling and enabling it makes the host read installed.json again. */
const OTHER = "layoutprobe2";

/** Replaces the file in one step, as `sok` does, so the host never reads half of it. */
function replaceFile(file, text) {
  const temporary = `${file}.check`;
  writeFileSync(temporary, text);
  renameSync(temporary, file);
}

/** Runs a plugin change, which starts the workbench of the window again, and waits until the new start is ready (pluginChangeStarted). */
const change = (s, action, plugin = OTHER) =>
  pluginChangeStarted(s, () => s.run(`core.plugins.${action}`, { plugin }), `${action} ${plugin}`);

for (const app of Object.values(APPS)) {
  test(`${app.name}: the plugin page shows an outdated persistent service and replaces it`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    // The replacement of the service is a record of the host at the level info.
    await fresh(s, { log: { lifecycle: "info" }, reads: ["host.record.info"] });
    await keepCommonSettings(s);
    // The host starts the service when a page first sends to it: a raster probe tab opens its session.
    await addRasterTab(s);
    const file = join(app.configDir, "plugins", "installed.json");
    const original = readFileSync(file, "utf8");
    const installed = JSON.parse(original);
    const running = installed.sidecars[SIDECAR];
    const newer = running.version.replace(/\d+$/, (patch) => String(Number(patch) + 1));
    const folder = running.path.replace(`/${running.version}/`, `/${newer}/`);
    assert.notEqual(folder, running.path, `the path of ${SIDECAR} does not hold its version: ${running.path}`);
    // The cleanup returns the installed version, applies it, and removes the copy only after the host stopped declaring
    // it and the service that runs its executable ended: a host that still declares a folder that is gone fails to start
    // its service, and a service whose executable is gone fails to start the process of each new session. Each step runs
    // also when a step before it failed, because a copy or a service of the copy that stays poisons the checks after this
    // one: an install prunes the copy that installed.json no longer names, and the service that still runs it starts no
    // session process.
    s.cleanupSteps(
      async () => {
        replaceFile(file, original);
        await change(s, "enable");
        await s.until("core.plugins", (value) => value.outdated.length === 0, "the restored version still shows an outdated service");
      },
      // The running service reports the installed version, so only a sidecar that no plugin declares makes the host end
      // it; with no surface holding the sidecar, the host ends it after the list of the layouts.
      async () => {
        for (const card of (await s.get("core.grid")).cards) {
          for (const tab of card.tabs) if (tab.plugin === RASTER) await s.run("core.tab.close", { tab: tab.id });
        }
      },
      async () => {
        const ending = currentEventOffsets(app.configDir);
        await change(s, "disable", RASTER);
        await untilEventLine(app.configDir, ending, (line) => line.includes(`service ${running.version} ended; the sidecar is not declared`), { ...reading(app, ["host.record.info"]), ended: s.client.ended });
      },
      async () => {
        await change(s, "enable", RASTER);
        await s.until("core.plugins", (value) => value.outdated.length === 0, "the enabled raster probe shows an outdated service");
      },
      async () => rmSync(join(app.configDir, folder, ".."), { recursive: true, force: true }),
      // The next raster probe starts the service of the installed folder, which opens sessions.
      async () => {
        const { surface } = await addRasterTab(s);
        await s.run("core.tab.close", { tab: surface });
      },
    );
    cpSync(join(app.configDir, running.path), join(app.configDir, folder), { recursive: true });
    installed.sidecars[SIDECAR] = { version: newer, path: folder };
    // The raster probe names the range that it was installed with, which the other version must satisfy.
    installed.plugins[RASTER].sidecars[SIDECAR] = `>=${running.version}`;
    replaceFile(file, JSON.stringify(installed));
    // A plugin change makes the host read installed.json again; OTHER is not the plugin of the service.
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
    const offsets = currentEventOffsets(app.configDir);
    await s.act("core.library.plugins.replace", "click");
    await untilEventLine(app.configDir, offsets, (line) => line.includes(`service ${running.version} replaced by ${newer}`),
      { ...reading(app, ["host.record.info"]), ended: s.client.ended });
  });
}
