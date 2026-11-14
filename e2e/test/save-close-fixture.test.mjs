import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

import { openView } from "@soksak/plugin-api/testing";
import { savesKey, startCloseProbe } from "../fixtures/save-close/probe/ui/close-probe.js";

const manifestPath = fileURLToPath(new URL("../fixtures/save-close/probe/plugin.json", import.meta.url));
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

/** The local storage of a view document: the Storage of a jsdom window on a tuple origin, which soksak:// does not give. */
const localStorageOf = () => new JSDOM("", { url: "https://probeclose.example/" }).window.localStorage;

/** Starts the probe of `surface` on `storage` in a view whose wire is the case `wire`; returns the view, which records its calls and serves its exposure. */
async function started(wire, storage, surface) {
  const view = await openView(wire, { declarations: manifest.exposes,
    start: { surface, params: null, origin: { directory: null }, project: null, section: null } });
  await startCloseProbe({ bridge: view.bridge, expose: view.expose, storage, surface });
  return view;
}

test("the save close probe serves its declared status and keeps the modified state that each save chooses", { timeout: 1000 }, async () => {
  const probe = await started("save-close-fixture-modified", localStorageOf(), "s1");
  assert.deepEqual(probe.registered("status"), manifest.exposes.status.map((status) => status.name));
  assert.deepEqual(probe.calls.filter(({ command }) => command === "runtime.command.register").map(({ params }) => params.name),
    manifest.exposes.commands.map((command) => command.name));
  assert.deepEqual(await probe.status("probeclose.state"), { saves: 0, modified: false });
  await probe.exposed("status.watch", { name: "probeclose.state" });
  await probe.run("probeclose.prepare", { keepModified: true });
  await probe.run("probeclose.save", {});
  assert.deepEqual(await probe.status("probeclose.state"), { saves: 1, modified: true });
  await probe.run("probeclose.prepare", { keepModified: false });
  await probe.run("probeclose.save", {});
  assert.deepEqual(await probe.status("probeclose.state"), { saves: 2, modified: false });
  assert.deepEqual(probe.calls.filter(({ command }) => command === "tab.modified").map(({ params }) => params), [true, true, true, false]);
  assert.deepEqual(probe.changes("probeclose.state").at(-1), { saves: 2, modified: false });
  await probe.close();
});

test("the save count of a tab survives a reload of the same tab and stays apart from other tabs", { timeout: 1000 }, async () => {
  const storage = localStorageOf();
  const first = await started("save-close-fixture-first-tab", storage, "s1");
  await first.run("probeclose.prepare", { keepModified: false });
  await first.run("probeclose.save", {});
  assert.equal(storage.getItem(savesKey("s1")), "1");
  await first.close();
  const reloaded = await started("save-close-fixture-reloaded-tab", storage, "s1");
  assert.deepEqual(await reloaded.status("probeclose.state"), { saves: 1, modified: false });
  await reloaded.close();
  const other = await started("save-close-fixture-other-tab", storage, "s2");
  assert.deepEqual(await other.status("probeclose.state"), { saves: 0, modified: false });
  await other.close();
});
