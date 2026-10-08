// The plugin screen lists the plugins that the registry lists in a newer version and updates them with one action
// (docs/spec/installation.md, Plugin screen).
//
// The check serves a registry index that lists a newer version of an installed plugin with a wrong hash, so the update
// is refused and the installation does not change.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { APPS, keepCommonSettings, open } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";

const REGISTRY = fileURLToPath(new URL("../target/registry/", import.meta.url));

for (const app of Object.values(APPS)) {
  test(`${app.name}: the plugin screen lists the updates and 모두 업데이트 stops at a refused update`, { timeout: 90000 }, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    await keepCommonSettings(s);
    const before = await s.get("core.plugins");
    const installed = before.plugins.find((row) => row.id === "browser").installed.version;

    // The index lists browser in a version after the installed one, with a hash that no release has.
    const index = JSON.parse(readFileSync(join(REGISTRY, "index.json"), "utf8"));
    const browser = index.plugins.find((plugin) => plugin.id === "browser");
    const newer = `${installed.split(".").slice(0, 2).join(".")}.${Number(installed.split(".")[2]) + 1}`;
    browser.versions.push({ ...structuredClone(browser.versions.at(-1)), version: newer });
    browser.versions.at(-1).release.sha256 = "0".repeat(64);
    const folder = mkdtempSync(join(tmpdir(), "soksak-plugin-updates-"));
    writeFileSync(join(folder, "index.json"), JSON.stringify(index));
    const address = pathToFileURL(join(folder, "index.json")).href;
    s.cleanup(() => rmSync(folder, { recursive: true, force: true }));
    s.cleanup(async () => {
      if ((await s.get("core.screen")).screen === "library") {
        await s.run("core.library.page", { page: "projects" });
        await s.run("core.library.return");
      }
      await s.run("core.plugins.registry", { index: before.registry });
    });

    await s.run("core.plugins.registry", { index: address });
    const listed = await s.until("core.plugins", (value) => value.registry === address && value.error === null && value.updates.length > 0,
      "the registry with a newer version did not list an update");
    assert.deepEqual(listed.updates, [{ id: "browser", installed, latest: newer }]);

    // The window shows the control 업데이트 N while an update exists; it opens the plugin screen at the update list.
    const control = await s.rect("core.chrome.updates");
    assert.ok(control.width > 0 && control.height > 0, `the update control has no size: ${JSON.stringify(control)}`);
    await s.act("core.chrome.updates", "click");
    await s.run("core.plugins.browse");
    await s.until("core.library", (library) => library.page === "plugins" && library.plugins.shown.length > 0, "the plugin page did not show");
    const row = await s.rect("core.library.plugins.updates", 0);
    assert.ok(row.width > 0 && row.height > 0, `the update row has no size: ${JSON.stringify(row)}`);
    await s.rect("core.library.plugins.update-all", undefined);

    // 모두 업데이트 runs the update, which the wrong hash refuses, and the installation does not change.
    // The library shows the refusal through its error display, which writes the error line.
    s.expectError(/has sha256 [0-9a-f]{64}, the entry says 0{64}/);
    await s.act("core.library.plugins.update-all", "click");
    const failed = await s.until("core.plugins", (value) => value.operation?.action === "update" && value.operation.state === "failed",
      "모두 업데이트 did not run the update of browser");
    assert.match(failed.operation.error, /has sha256 [0-9a-f]{64}, the entry says 0{64}/);
    assert.equal(failed.plugins.find((entry) => entry.id === "browser").installed.version, installed);

    // The control leaves with the last update.
    await s.run("core.plugins.registry", { index: before.registry });
    await s.until("core.plugins", (value) => value.updates.length === 0, "the original registry still lists an update");
    await assert.rejects(s.rect("core.chrome.updates"), /core\.chrome\.updates/);
  });
}
