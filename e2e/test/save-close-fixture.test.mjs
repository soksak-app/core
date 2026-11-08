import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { savesKey, startCloseProbe } from "../fixtures/save-close/probe/ui/close-probe.js";

const manifestPath = fileURLToPath(new URL("../fixtures/save-close/probe/plugin.json", import.meta.url));
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

/** A local storage of one view document: a map of strings. */
function memoryStorage(entries = []) {
  const values = new Map(entries);
  return { values, getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)) };
}

/** Starts the probe of `surface` on `storage` with a fake bridge and exposure; returns its commands, its status and its reports. */
async function started(storage, surface) {
  const commands = new Map();
  const served = new Map();
  const reports = [];
  const bridge = {
    calls: { request: async (name, value) => { reports.push([name, value]); return null; } },
    commands: { register: async (name, run) => { commands.set(name, run); } },
  };
  const expose = { status: async (name, read, subscribe) => { served.set(name, { read, subscribe }); } };
  await startCloseProbe({ bridge, expose, storage, surface });
  return { commands, state: served.get("probeclose.state"), served, reports };
}

test("the save close probe serves its declared status and keeps the modified state that each save chooses", { timeout: 1000 }, async () => {
  const probe = await started(memoryStorage(), "s1");
  assert.deepEqual([...probe.served.keys()], manifest.exposes.status.map((status) => status.name));
  assert.deepEqual([...probe.commands.keys()], manifest.exposes.commands.map((command) => command.name));
  assert.deepEqual(probe.state.read(), { saves: 0, modified: false });
  const values = [];
  probe.state.subscribe((value) => values.push(value));
  await probe.commands.get("probeclose.prepare")({ keepModified: true });
  await probe.commands.get("probeclose.save")({});
  assert.deepEqual(probe.state.read(), { saves: 1, modified: true });
  await probe.commands.get("probeclose.prepare")({ keepModified: false });
  await probe.commands.get("probeclose.save")({});
  assert.deepEqual(probe.state.read(), { saves: 2, modified: false });
  assert.deepEqual(probe.reports, [["tab.modified", true], ["tab.modified", true], ["tab.modified", true], ["tab.modified", false]]);
  assert.deepEqual(values.at(-1), { saves: 2, modified: false });
});

test("the save count of a tab survives a reload of the same tab and stays apart from other tabs", { timeout: 1000 }, async () => {
  const storage = memoryStorage();
  const first = await started(storage, "s1");
  await first.commands.get("probeclose.prepare")({ keepModified: false });
  await first.commands.get("probeclose.save")({});
  assert.equal(storage.values.get(savesKey("s1")), "1");
  const reloaded = await started(storage, "s1");
  assert.deepEqual(reloaded.state.read(), { saves: 1, modified: false });
  const other = await started(storage, "s2");
  assert.deepEqual(other.state.read(), { saves: 0, modified: false });
});
