// The memory saver end to end (docs/spec/plugins.md#memory-saver, docs/spec/exposure.md#tab-memory). An unload probe that
// declares surface.unload is packed into a registry of the check beside the workspace plugins and installed. On each host the
// check requires that:
// 1. core.tab.unload of a hidden probe tab reports it unloaded in core.tab.memory and removes its document region from the
//    host objects (diagnostics.objects);
// 2. showing it again emits page.tab.restored and restores the same address and session history;
// 3. warn pressure (diagnostics.memory.pressure) unloads the hidden candidates one at a time, least recently shown first, and
//    a normal report stops the unloading;
// 4. a kept tab (core.tab.keep) and a modified tab are not unloaded.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { currentEventOffsets } from "@soksak/window-check/event-log.mjs";
import { pluginEntry } from "../scripts/workspace-registry.mjs";
import { allRows, tailOf } from "./chains.mjs";
import { fresh, pluginChangeApplied } from "./fixture.mjs";

const REGISTRY = fileURLToPath(new URL("../target/registry/", import.meta.url));
const PROBE = fileURLToPath(new URL("./fixtures/memory-saver/unload-probe/", import.meta.url));

/** A registry folder with the entries of the workspace registry and the unload probe, and its built index. */
function probeRegistry(sok) {
  const folder = mkdtempSync(join(tmpdir(), "soksak-unload-registry-"));
  for (const name of ["plugins", "sidecars", "packs", "revoked.json"]) cpSync(join(REGISTRY, name), join(folder, name), { recursive: true });
  const sidecars = new Set(readdirSync(join(folder, "sidecars")).map((file) => JSON.parse(readFileSync(join(folder, "sidecars", file), "utf8")).name));
  const pack = JSON.parse(execFileSync(sok, ["plugin", "pack", PROBE, join(folder, "releases")], { encoding: "utf8" }));
  const manifest = JSON.parse(readFileSync(join(PROBE, "plugin.json"), "utf8"));
  const pkg = JSON.parse(readFileSync(join(PROBE, "package.json"), "utf8"));
  writeFileSync(join(folder, "plugins", `${manifest.id}.json`), JSON.stringify(pluginEntry(manifest, pkg, pack, sidecars), null, 2));
  execFileSync(sok, ["registry", "build", folder], { encoding: "utf8" });
  return folder;
}

/** A loopback server of three small pages, /a, /b and /c. It is closed when the check ends. */
async function serve(s) {
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(`<!doctype html><title>${request.url.slice(1)}</title><p>${request.url}</p>`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  s.cleanup(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { a: `${base}/a`, b: `${base}/b`, c: `${base}/c` };
}

/** Runs a plugin operation that changes installed.json and waits until the page has reloaded (docs/spec/installation.md#applying-a-change). */
async function pluginChange(s, action, run) {
  const offsets = currentEventOffsets(s.app.configDir);
  await run();
  await pluginChangeApplied(s, offsets, action);
}

/**
 * Waits on the notices of `host.log` until the events stored after `since` satisfy `done`, and returns those events. The page
 * writes its events to the log after they occur, so a read right after a status change can precede them.
 */
async function eventsUntil(s, since, done, what) {
  for (; ;) {
    const notices = (await s.get("host.log")).notices;
    const events = (await allRows(s, { channel: "all", since })).map((row) => row.event);
    if (done(events)) return events;
    await s.until("host.log", (value) => value.notices > notices, `the log announced no ${what}`);
  }
}

/** Runs one step of the check and writes its elapsed time. */
async function step(t, s, name, fn) {
  s.step(name);
  const started = performance.now();
  const result = await fn();
  t.diagnostic(`${s.app.name}: ${name}: ${Math.round(performance.now() - started)} ms`);
  return result;
}

const entryOf = (memory, tab) => memory.tabs.find((entry) => entry.tab === tab);
const regionsOf = (objects, tab) => objects.documents.filter((entry) => entry.surface === tab).length;

for (const app of Object.values(APPS)) {
  test(`${app.name}: the memory saver unloads hidden tabs on the command and under pressure and restores them`, { timeout: 300000 }, async (t) => {
    const s = await open(t, app);
    // The delay of 720 minutes keeps the delay deadline out of the check, so every unload comes from the command or the pressure.
    // The check reads the page.tab events, lifecycle events at the level info.
    await step(t, s, "prepare the fixture", () => fresh(s, { settings: { memorySaver: true, memorySaverDelay: 720 },
      log: { lifecycle: "info" }, reads: ["page.tab.restored", "page.tab.unloaded", "page.tab.unload.skipped"] }));
    const pages = await serve(s);
    const before = await s.get("core.plugins");
    const folder = probeRegistry(join(dirname(app.binary), "sok"));
    s.cleanup(() => rmSync(folder, { recursive: true, force: true }));
    s.cleanup(async () => {
      await s.windows(1, "the page was not ready for the cleanup");
      if ((await s.get("core.plugins")).plugins.find((row) => row.id === "probeunload")?.installed) {
        await pluginChange(s, "the removal of probeunload in the cleanup", () => s.run("core.plugins.remove", { plugin: "probeunload" }));
      }
      await s.run("core.plugins.registry", { index: before.registry });
    });
    await step(t, s, "install the unload probe", async () => {
      await s.run("core.plugins.registry", { index: pathToFileURL(join(folder, "index.json")).href });
      await s.until("core.plugins", (value) => value.plugins.some((row) => row.id === "probeunload"), "the probe registry did not list the unload probe");
      await pluginChange(s, "the install of probeunload", () => s.run("core.plugins.install", { plugin: "probeunload" }));
    });
    // The pressure level belongs to the process, so the check returns it to normal for the checks after it.
    s.cleanup(() => s.request("diagnostics.memory.pressure", { level: "normal" }));

    const card = (await s.get("core.grid")).cards.find((item) => item.pane !== null);
    const home = card.active;
    const opened = [];
    s.cleanup(async () => {
      for (const tab of opened.toReversed()) await s.run("core.tab.close", { tab });
    });
    /** Adds a probe tab, loads the addresses in order and waits until the region shows the last one. */
    const probeTab = async (urls) => {
      const { tab } = await s.run("core.card.add-tab", { card: card.id, plugin: "probeunload" });
      opened.push(tab);
      await s.until("core.surfaces", (list) => list.some((x) => x.surface === tab && x.exposes.includes("status probeunload.location")),
        `probe surface ${tab} did not register`);
      for (const [index, url] of urls.entries()) {
        await s.run("probeunload.load", { url }, tab);
        await s.until("probeunload.location", (at) => at.url === url && !at.loading && at.history.entries.length === index + 1,
          `probe ${tab} did not load ${url}`, { surface: tab });
      }
      return tab;
    };
    const [a, b, kept, modified] = await step(t, s, "open four probe tabs", async () => [
      await probeTab([pages.a, pages.b]), await probeTab([pages.c]), await probeTab([pages.a]), await probeTab([pages.b]),
    ]);
    s.cleanup(() => s.run("probeunload.modified", { modified: false }, modified));
    await step(t, s, "mark one tab kept and one tab modified and show the first tab of the card", async () => {
      await s.run("core.tab.keep", { tab: kept, keep: true });
      await s.run("probeunload.modified", { modified: true }, modified);
      await s.run("core.tab.select", { tab: home });
      await s.until("core.tab.memory", (memory) => entryOf(memory, kept)?.reasons.includes("kept")
        && entryOf(memory, modified)?.reasons.includes("keep:modified")
        && [a, b, kept, modified].every((tab) => entryOf(memory, tab)?.state === "loaded" && !entryOf(memory, tab).reasons.includes("shown")),
      "the probe tabs did not become hidden with the marks kept and keep:modified");
    });

    // 1. The command unloads a hidden tab and its document region is gone.
    const loadedObjects = await s.request("diagnostics.objects");
    assert.equal(regionsOf(loadedObjects, a), 1, `probe ${a} has no document region before the unload: ${JSON.stringify(loadedObjects.documents)}`);
    await step(t, s, "unload a hidden tab with core.tab.unload", async () => {
      await s.run("core.tab.unload", { tab: a });
      await s.until("core.tab.memory", (memory) => entryOf(memory, a)?.state === "unloaded", `tab ${a} did not become unloaded`);
    });
    const unloadedObjects = await s.request("diagnostics.objects");
    assert.equal(regionsOf(unloadedObjects, a), 0, `the document region of ${a} remains after the unload: ${JSON.stringify(unloadedObjects.documents)}`);
    assert.equal(unloadedObjects.host.documents, loadedObjects.host.documents - 1,
      `the host documents went from ${loadedObjects.host.documents} to ${unloadedObjects.host.documents} at the unload`);

    // 2. Showing it again restores the address and the session history.
    const restoreFrom = await tailOf(s);
    await step(t, s, "show the unloaded tab and wait for its restore", async () => {
      await s.run("core.tab.select", { tab: a });
      await s.until("core.tab.memory", (memory) => entryOf(memory, a)?.state === "loaded", `tab ${a} was not restored`);
      const at = await s.until("probeunload.location", (value) => value.url === pages.b && !value.loading,
        `probe ${a} did not show ${pages.b} after the restore`, { surface: a });
      assert.deepEqual(at.restored, { url: pages.b }, `probe ${a} read ${JSON.stringify(at.restored)} as its tab state`);
      assert.deepEqual(at.history.entries.map((entry) => entry.url), [pages.a, pages.b], `the restored history is ${JSON.stringify(at.history)}`);
      assert.equal(at.history.index, 1, `the restored history is ${JSON.stringify(at.history)}`);
    });
    const restored = (await eventsUntil(s, restoreFrom, (events) => events.some((event) => event.event === "page.tab.restored"), "page.tab.restored"))
      .filter((event) => event.event === "page.tab.restored").map((event) => event.fields);
    assert.deepEqual(restored, [{ tab: a, plugin: "probeunload", history: true }], `page.tab.restored after the show: ${JSON.stringify(restored)}`);
    assert.equal(regionsOf(await s.request("diagnostics.objects"), a), 1, `probe ${a} has no document region after the restore`);

    // 3. Warn pressure unloads the hidden candidates one at a time, least recently shown first; 4. the kept and the modified tab stay.
    await s.run("core.tab.select", { tab: home });
    await s.until("core.tab.memory", (memory) => !entryOf(memory, a)?.reasons.includes("shown"), `tab ${a} did not become hidden`);
    const pressureFrom = await tailOf(s);
    await step(t, s, "inject warn pressure and wait until the candidates are unloaded", async () => {
      await s.request("diagnostics.memory.pressure", { level: "warn" });
      await s.until("core.tab.memory", (memory) => memory.pressure.level === "warn"
        && entryOf(memory, a)?.state === "unloaded" && entryOf(memory, b)?.state === "unloaded", `tabs ${a} and ${b} were not unloaded under warn pressure`);
    });
    const relief = await step(t, s, "wait for the end of the relief", () => eventsUntil(s, pressureFrom,
      (events) => events.some((event) => event.event === "page.tab.unload.skipped" && event.fields.trigger === "pressure"), "end of the relief"));
    const unloaded = relief.filter((event) => event.event === "page.tab.unloaded").map((event) => event.fields);
    assert.deepEqual(unloaded, [{ tab: b, plugin: "probeunload", trigger: "pressure" }, { tab: a, plugin: "probeunload", trigger: "pressure" }],
      `page.tab.unloaded under pressure: ${JSON.stringify(unloaded)}`);
    const skipped = relief.find((event) => event.event === "page.tab.unload.skipped").fields;
    assert.ok(skipped.reasons.includes("kept") && skipped.reasons.includes("keep:modified"), `the relief ended with ${JSON.stringify(skipped)}`);
    const pressed = await s.get("core.tab.memory");
    for (const [tab, reason] of [[kept, "kept"], [modified, "keep:modified"]]) {
      assert.equal(entryOf(pressed, tab).state, "loaded", `tab ${tab} was unloaded under pressure: ${JSON.stringify(entryOf(pressed, tab))}`);
      assert.ok(entryOf(pressed, tab).reasons.includes(reason), `tab ${tab} lost ${reason}: ${JSON.stringify(entryOf(pressed, tab))}`);
    }
    const pressedObjects = await s.request("diagnostics.objects");
    assert.deepEqual([a, b, kept, modified].map((tab) => regionsOf(pressedObjects, tab)), [0, 0, 1, 1],
      `document regions of the probe tabs under pressure: ${JSON.stringify(pressedObjects.documents)}`);
    await step(t, s, "refuse core.tab.unload of the kept and the modified tab", async () => {
      await assert.rejects(s.run("core.tab.unload", { tab: kept }), new RegExp(`tab ${kept} is protected: .*kept`));
      await assert.rejects(s.run("core.tab.unload", { tab: modified }), new RegExp(`tab ${modified} is protected: .*keep:modified`));
    });

    // A normal report stops the unloading: a hidden tab that is a candidate under pressure stays loaded while the level is normal.
    await step(t, s, "report normal, restore a tab and hide it again", async () => {
      await s.request("diagnostics.memory.pressure", { level: "normal" });
      await s.until("core.tab.memory", (memory) => memory.pressure.level === "normal", "the normal report did not reach core.tab.memory");
      await s.run("core.tab.select", { tab: a });
      await s.until("core.tab.memory", (memory) => entryOf(memory, a)?.state === "loaded", `tab ${a} was not restored`);
      await s.until("probeunload.location", (value) => value.url === pages.b && !value.loading, `probe ${a} did not restore`, { surface: a });
      await s.run("core.tab.select", { tab: home });
      const memory = await s.until("core.tab.memory", (value) => entryOf(value, a)?.reasons.includes("recent"), `tab ${a} did not become hidden and recent`);
      assert.equal(entryOf(memory, a).state, "loaded", `tab ${a} was unloaded at normal: ${JSON.stringify(entryOf(memory, a))}`);
      assert.deepEqual(entryOf(memory, a).reasons, ["recent"], `tab ${a} has reasons other than recent: ${JSON.stringify(entryOf(memory, a))}`);
    });
    await step(t, s, "inject warn pressure again and wait until the recent tab is unloaded", async () => {
      await s.request("diagnostics.memory.pressure", { level: "warn" });
      await s.until("core.tab.memory", (memory) => entryOf(memory, a)?.state === "unloaded", `tab ${a} was not unloaded under the second warn report`);
      await s.request("diagnostics.memory.pressure", { level: "normal" });
      await s.until("core.tab.memory", (memory) => memory.pressure.level === "normal", "the second normal report did not reach core.tab.memory");
    });
  });
}
