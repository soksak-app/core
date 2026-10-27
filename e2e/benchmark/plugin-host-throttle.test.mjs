import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { currentEventOffsets } from "@soksak/window-check/event-log.mjs";
import { pluginEntry } from "../../scripts/workspace-registry.mjs";
import { allRows, tailOf } from "../chains.mjs";
import { fresh, pluginChangeApplied } from "../fixture.mjs";
import { cleanupPluginHostFixture, readPluginHostSample, reducePluginHostRafMeasurement,
  selectPluginHostSamplerRows, waitForPluginHostRegistrations } from "./cases/plugin-host-throttle.mjs";

const PROBE = fileURLToPath(new URL("../fixtures/plugin-host-throttle/raf-probe/", import.meta.url));
const PLUGIN = "probehostraf";
const SAMPLE_STATUS = `${PLUGIN}.sample`;
const READ_COMMAND = `${PLUGIN}.read`;

/** A temporary index that preserves the public active registry and adds only the host-only RAF probe. */
function probeRegistry(sok, currentIndexURL) {
  let currentIndex;
  try {
    const currentIndexAddress = new URL(currentIndexURL);
    if (currentIndexAddress.protocol !== "file:") {
      throw new Error(`the active registry must be a local file URL, found ${currentIndexAddress.protocol}`);
    }
    currentIndex = JSON.parse(readFileSync(fileURLToPath(currentIndexAddress), "utf8"));
  } catch (error) {
    throw new Error(`cannot read the active registry index ${currentIndexURL}: ${error.message}`, { cause: error });
  }
  if (!currentIndex || currentIndex.format !== 1 || !Array.isArray(currentIndex.plugins)
      || !Array.isArray(currentIndex.sidecars) || !Array.isArray(currentIndex.packs)) {
    throw new Error(`the active registry index ${currentIndexURL} has an unsupported shape`);
  }
  if (currentIndex.plugins.some((entry) => entry?.id === PLUGIN)) {
    throw new Error(`the active registry already contains fixture plugin ${PLUGIN}`);
  }
  const folder = mkdtempSync(join(tmpdir(), "soksak-plugin-host-raf-registry-"));
  try {
    const pack = JSON.parse(execFileSync(sok, ["plugin", "pack", PROBE, join(folder, "releases")], { encoding: "utf8" }));
    const manifest = JSON.parse(readFileSync(join(PROBE, "plugin.json"), "utf8"));
    const pkg = JSON.parse(readFileSync(join(PROBE, "package.json"), "utf8"));
    currentIndex.plugins.push(pluginEntry(manifest, pkg, pack, new Set()));
    writeFileSync(join(folder, "index.json"), `${JSON.stringify(currentIndex, null, 2)}\n`);
    return folder;
  } catch (error) {
    rmSync(folder, { recursive: true, force: true });
    throw new Error(`cannot build the plugin-host RAF fixture registry: ${error.message}`, { cause: error });
  }
}

/** Reads only the plugin-host memory rows of this fixture and window. */
async function pluginHostSamplerRows(session, since) {
  const rows = await allRows(session, { channel: "all", event: "host.sampler.memory", since });
  return selectPluginHostSamplerRows(rows, PLUGIN, session.window);
}

/** Waits for sampler notices instead of polling or scheduling a benchmark timer. */
async function waitForSamplerRows(session, since, count) {
  for (;;) {
    let rows = await pluginHostSamplerRows(session, since);
    if (rows.length >= count) return rows;
    const notices = (await session.get("host.log")).notices;
    rows = await pluginHostSamplerRows(session, since);
    if (rows.length >= count) return rows;
    await session.until("host.log", (value) => value.notices > notices,
      `${PLUGIN} produced no further host.sampler.memory notice`, { timeout: 15000 });
  }
}

async function pluginChange(session, action, run) {
  const offsets = currentEventOffsets(session.app.configDir);
  await run();
  await pluginChangeApplied(session, offsets, action);
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: a built plugin host reports its observed RAF rate`, { timeout: 90000 }, async (t) => {
    const session = await open(t, app);
    await fresh(session, { performanceTrace: true, log: { call: "debug" }, reads: ["host.sampler.memory"] });
    const previous = await session.get("core.plugins");
    const registry = probeRegistry(join(dirname(app.binary), "sok"), previous.registry);
    session.cleanup(() => cleanupPluginHostFixture({
      ensureWindow: () => session.windows(1, "the plugin-host RAF check did not return to one window"),
      readState: () => session.get("core.plugins"),
      plugin: PLUGIN,
      previousRegistry: previous.registry,
      removePlugin: () => pluginChange(session, `remove ${PLUGIN} in cleanup`,
        () => session.run("core.plugins.remove", { plugin: PLUGIN })),
      restoreRegistry: (index) => session.run("core.plugins.registry", { index }),
      removeDirectory: () => rmSync(registry, { recursive: true, force: true }),
      directory: registry,
    }));

    await session.run("core.plugins.registry", { index: pathToFileURL(join(registry, "index.json")).href });
    await session.until("core.plugins", (value) => value.plugins.some((row) => row.id === PLUGIN),
      "the plugin-host RAF fixture registry was not loaded");
    const registrationStart = await tailOf(session);
    await pluginChange(session, `install ${PLUGIN}`, () => session.run("core.plugins.install", { plugin: PLUGIN }));
    await waitForPluginHostRegistrations({
      session,
      plugin: PLUGIN,
      registrations: [{ kind: "status", name: SAMPLE_STATUS }, { kind: "command", name: READ_COMMAND }],
      since: registrationStart,
      readRows: (since) => allRows(session, { channel: "all", event: "page.trace.surface.registration", since }),
    });

    const start = await readPluginHostSample(session, READ_COMMAND, SAMPLE_STATUS);
    const since = await tailOf(session);
    const samplerRows = await waitForSamplerRows(session, since, 2);
    const end = await readPluginHostSample(session, READ_COMMAND, SAMPLE_STATUS);
    const measurement = reducePluginHostRafMeasurement({
      plugin: PLUGIN, window: session.window, start, end, samplerRows,
    });
    assert.ok(measurement.sampler.length >= 2, "the RAF observation has fewer than two sampler rows");

    const directory = join(app.configDir, "logs", "plugin-host-throttle");
    mkdirSync(directory, { recursive: true });
    const evidence = { host: app.name, measurement };
    const path = join(directory, `${process.pid}.json`);
    writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`);
    t.diagnostic(`${app.name}: plugin host ${PLUGIN}, PID ${measurement.pid}, ${measurement.callbacks} RAF callbacks in `
      + `${measurement.elapsedMs.toFixed(3)} ms (${measurement.framesPerSecond.toFixed(3)} frames/s); `
      + `sampler rows ${measurement.sampler.map((row) => `${row.seq}@${row.monoNs} PID ${row.pid}, `
        + `RSS ${row.rssKB} KB, footprint ${row.footprintKB} KB`).join("; ")}; evidence ${path}`);
  });
}
