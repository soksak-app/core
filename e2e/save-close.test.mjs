// The native core close boundary consumes a declared fixture's save reply and modified report.
// Actual Editor save behavior is checked separately; this fixture performs no Editor filesystem write.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { APPS, open } from "@soksak/window-check/app.mjs";
import { currentEventOffsets } from "@soksak/window-check/event-log.mjs";
import { pluginEntry } from "../scripts/workspace-registry.mjs";
import { hashFile } from "../scripts/candidate-identity.mjs";
import { runCommand } from "../scripts/test-command.mjs";
import { fresh, pluginChangeApplied, restoreRegistry, useRegistry } from "./fixture.mjs";

const PROBE = fileURLToPath(new URL("./fixtures/save-close/probe/", import.meta.url));
const REGISTRY = fileURLToPath(new URL("../target/registry/", import.meta.url));
const tabOf = (grid, id) => grid.cards.flatMap((card) => card.tabs ?? []).find((tab) => tab.id === id);

async function probeRegistry(sok, signal) {
  const folder = mkdtempSync(join(tmpdir(), "soksak-close-registry-"));
  try {
    for (const name of ["plugins", "sidecars", "packs", "revoked.json"]) cpSync(join(REGISTRY, name), join(folder, name), { recursive: true });
    const manifest = JSON.parse(readFileSync(join(PROBE, "plugin.json"), "utf8"));
    const pkg = JSON.parse(readFileSync(join(PROBE, "package.json"), "utf8"));
    const releases = join(folder, "releases");
    mkdirSync(releases);
    const pack = await runCommand({ id: "pack close probe", command: "pnpm", args: ["pack", "--json", "--pack-destination", releases],
      cwd: PROBE, timeoutMs: 30000, signal });
    assert.equal(pack.status, "pass", `close probe pack: ${JSON.stringify(pack.error ?? pack.stderr)}`);
    const { filename } = JSON.parse(pack.stdout);
    const packed = { release: filename, sha256: await hashFile(filename) };
    writeFileSync(join(folder, "plugins", `${manifest.id}.json`), JSON.stringify(pluginEntry(manifest, pkg, packed, new Set())));
    const build = await runCommand({ id: "build close probe registry", command: sok, args: ["registry", "build", folder],
      cwd: PROBE, timeoutMs: 30000, signal });
    assert.equal(build.status, "pass", `close probe registry: ${JSON.stringify(build.error ?? build.stderr)}`);
    return folder;
  } catch (error) {
    try { rmSync(folder, { recursive: true }); }
    catch (cleanup) { throw new AggregateError([error, cleanup], "close fixture preparation and cleanup failed"); }
    throw error;
  }
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: save replies that retain modified state keep the native tab open`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    const folder = await probeRegistry(join(dirname(app.binary), "sok"), t.signal);
    s.cleanup(() => rmSync(folder, { recursive: true }));
    const change = async (name, run) => {
      const offsets = currentEventOffsets(app.configDir);
      await run();
      await pluginChangeApplied(s, offsets, name);
    };
    s.cleanup(async () => {
      if ((await s.get("core.plugins")).plugins.some((entry) => entry.id === "probeclose" && entry.installed)) {
        await change("remove close probe", () => s.run("core.plugins.remove", { plugin: "probeclose" }));
      }
      await restoreRegistry(s);
    });
    await useRegistry(s, pathToFileURL(join(folder, "index.json")).href);
    await change("install close probe", () => s.run("core.plugins.install", { plugin: "probeclose" }));
    const card = (await s.get("core.grid")).cards.find((entry) => entry.pane !== null);
    const { tab } = await s.run("core.card.add-tab", { card: card.id, plugin: "probeclose" });
    s.cleanup(async () => {
      if (!tabOf(await s.get("core.grid"), tab)) return;
      const reply = await s.run("core.tab.close", { tab });
      if (reply.closed) return;
      const picker = await s.until("core.picker", (value) => value.open, "close probe cleanup did not ask");
      await s.run("core.picker.pick", { index: picker.items.findIndex((item) => item.name === "저장하지 않고 닫기") });
    });
    await s.registered(tab, ["command probeclose.prepare", "command probeclose.save", "status probeclose.state"]);
    const saveAndClose = async () => {
      assert.deepEqual(await s.run("core.tab.close", { tab }), { closed: false });
      const picker = await s.until("core.picker", (value) => value.open, "a modified close did not ask");
      const index = picker.items.findIndex((item) => item.name === "저장하고 닫기");
      assert.ok(index >= 0, "the close question omitted the declared save action");
      await s.run("core.picker.pick", { index });
    };
    await s.run("probeclose.prepare", { keepModified: true }, tab);
    await s.until("core.grid", (grid) => tabOf(grid, tab)?.modified === true, "the fixture's modified report did not reach core");
    const refusal = "저장하지 못했습니다 · probeclose.save left the tab modified";
    s.expectError(/tab error .*: 저장하지 못했습니다 · probeclose\.save left the tab modified$/);
    await saveAndClose();
    // The picker closes before its asynchronous action. This error is emitted only after core consumes the save reply.
    const refused = await s.until("core.grid", (grid) => tabOf(grid, tab)?.error === refusal,
      "core did not report the completed save's remaining modified state");
    assert.equal(tabOf(refused, tab).modified, true, "a successful save reply discarded the remaining modified tab");
    assert.deepEqual(await s.get("probeclose.state", tab), { saves: 1, modified: true });
    await s.run("probeclose.prepare", { keepModified: false }, tab);
    await saveAndClose();
    await s.until("core.grid", (grid) => !tabOf(grid, tab), "the same tab did not close after its next save cleared modified state");
    t.diagnostic("The native core consumes save completion and modified reports separately; this fixture establishes no Editor write-race result.");
  });
}
