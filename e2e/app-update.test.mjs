// The plugin screen lists the application update first and reports the steps of its operation
// (docs/spec/installation.md#application-update).
//
// The check serves a registry index that lists a core release newer than the running one. One release has a URL of a
// published release whose address refuses connections, the other a local file with a hash that no file has, so the
// operation fails at its first step and the installation does not change.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { APPS, keepCommonSettings, open } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";

const REGISTRY = fileURLToPath(new URL("../target/registry/", import.meta.url));
const NEWER = "99.0.0";

for (const app of Object.values(APPS)) {
  const key = `darwin-${process.arch === "arm64" ? "arm64" : "x64"}-${app.name}`;

  /** Serves an index with the core release `url` for this application and makes the window read it. */
  async function serve(s, before, url, sha256, edit = () => {}) {
    const index = JSON.parse(readFileSync(join(REGISTRY, "index.json"), "utf8"));
    edit(index);
    index.core = { versions: [{ version: NEWER, releases: { [key]: { url, sha256 } } }] };
    const folder = mkdtempSync(join(tmpdir(), "soksak-app-update-"));
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
    return s.until("core.app", (value) => value.available?.version === NEWER, "the registry with a newer core did not list an update");
  }

  test(`${app.name}: the update list shows the core release first and a refused release fails the operation`, { timeout: 90000 }, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    await keepCommonSettings(s);
    const before = await s.get("core.plugins");
    const url = "https://127.0.0.1:9/soksak-app/core/releases/download/v99.0.0/soksak-99.0.0.zip";
    // The installed version of browser needs a core below 99.0.0, and a newer version of it needs a core from 99.0.0.
    const installed = before.plugins.find((row) => row.id === "browser").installed.version;
    const newer = `${installed.split(".").slice(0, 2).join(".")}.${Number(installed.split(".")[2]) + 1}`;
    const listed = await serve(s, before, url, "0".repeat(64), (index) => {
      const browser = index.plugins.find((plugin) => plugin.id === "browser");
      browser.versions.find((item) => item.version === installed).engines.soksak = ">=0.0.1 <99.0.0";
      browser.versions.push({ ...structuredClone(browser.versions.at(-1)), version: newer, engines: { soksak: ">=99.0.0" } });
    });
    assert.equal(listed.available.release, "https://127.0.0.1:9/soksak-app/core/releases/tag/v99.0.0");
    assert.equal(listed.operation, null);
    assert.deepEqual(listed.incompatible, [{ id: "browser", installed, range: ">=0.0.1 <99.0.0", compatible: newer }]);

    // The window shows the control 업데이트 N for the core release, which opens the plugin screen at the update list.
    const control = await s.rect("core.chrome.updates");
    assert.ok(control.width > 0 && control.height > 0, `the update control has no size: ${JSON.stringify(control)}`);
    await s.run("core.plugins.show-updates");
    await s.until("core.library", (library) => library.page === "plugins", "the plugin page did not show");
    const row = await s.rect("core.library.app.row");
    assert.ok(row.width > 0 && row.height > 0, `the core update row has no size: ${JSON.stringify(row)}`);
    await s.rect("core.library.app.release");
    await s.rect("core.library.app.update");
    const note = await s.rect("core.library.app.incompatible", 0);
    assert.ok(note.width > 0 && note.height > 0, `the incompatible plugin line has no size: ${JSON.stringify(note)}`);

    // The operation stops at the download of the release, reports the failed step, and the installation is unchanged.
    s.expectError(/application update 99\.0\.0: /);
    await s.act("core.library.app.update", "click");
    const failed = await s.until("core.app", (value) => value.operation?.state === "failed", "the operation did not report its failure");
    assert.equal(failed.operation.version, NEWER);
    assert.ok(failed.operation.error.length > 0);
    assert.equal(failed.version, listed.version);
    const line = await s.rect("core.library.app.operation");
    assert.ok(line.width > 0 && line.height > 0, `the operation line has no size: ${JSON.stringify(line)}`);
  });

  test(`${app.name}: a release without a published page offers no release link`, { timeout: 90000 }, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    await keepCommonSettings(s);
    const before = await s.get("core.plugins");
    const listed = await serve(s, before, "file:///no/such/soksak-99.0.0.zip", "0".repeat(64));
    assert.equal(listed.available.release, null);
    await s.run("core.plugins.show-updates");
    await s.until("core.library", (library) => library.page === "plugins", "the plugin page did not show");
    await s.rect("core.library.app.update");
    await assert.rejects(s.rect("core.library.app.release"), /core\.library\.app\.release/);
    s.expectError(/application update 99\.0\.0: /);
    await s.act("core.library.app.update", "click");
    const failed = await s.until("core.app", (value) => value.operation?.state === "failed", "the operation did not report its failure");
    assert.match(failed.operation.error, /application update/);
  });
}
