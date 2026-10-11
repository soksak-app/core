// Each operation of the page that changes the application leaves its complete chain in the event log (docs/spec/logging.md#operation-chains).
//
// The check performs the operations through their declared commands: a plugin is disabled, enabled, removed and installed again,
// a project is opened in its window and removed, a window is opened and closed, a common setting changes, and the application
// update runs against a registry that offers a newer release which refuses at its first step. After each operation it asks the
// host for the events of the chain (`log.query`, channel `all`, by the correlation identifier of the first event) and requires
// every event that the catalog declares for the chain. It waits on the notices of the host status `host.log`, which the host
// publishes when the index covers lines that announce a change, and not on a timer.
//
// The update operation cannot run to its end offline: `appUpdateApply` would replace the running application. The check runs the
// operation that the release refuses at `appUpdateStage`, which is the first host call of the chain and is recorded whether or not
// it succeeds, so the chain `update` is checked through `page.update.operation`, `page.call` and `host.binding.call` of that call.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { APPS, keepCommonSettings, open } from "@soksak/window-check/app.mjs";
import { chainOf, declaredChains, tailOf } from "./chains.mjs";
import { fresh } from "./fixture.mjs";

const REGISTRY = fileURLToPath(new URL("../target/registry/", import.meta.url));
const NEWER = "99.0.0";

for (const app of Object.values(APPS)) {
  test(`${app.name}: each operation of the page leaves its complete chain in the log`, { timeout: 240000 }, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    const chains = declaredChains();
    await fresh(s);
    await keepCommonSettings(s);
    for (const name of Object.keys(chains)) s.expectEvent(chains[name][0]);
    const before = await s.get("core.plugins");

    // A plugin without a sidecar that is installed and loaded, so its removal does not end a service that the fixture uses.
    const target = before.plugins.find((row) => row.installed && row.state === "loaded" && row.sidecars.length === 0);
    assert.ok(target, `${app.name}: no installed and loaded plugin without a sidecar in ${JSON.stringify(before.plugins.map((row) => [row.id, row.state, row.sidecars.length]))}`);
    s.cleanup(async () => {
      const now = (await s.get("core.plugins")).plugins.find((row) => row.id === target.id);
      if (!now?.installed) await s.run("core.plugins.install", { plugin: target.id });
      else if (!now.installed.enabled) await s.run("core.plugins.enable", { plugin: target.id });
    });
    const operate = async (action) => {
      const since = await tailOf(s);
      await s.run(`core.plugins.${action}`, { plugin: target.id });
      await s.until("core.plugins", (value) => value.operation?.action === action && value.operation.plugin === target.id && value.operation.state === "done",
        `the plugin ${target.id} was not ${action === "remove" ? "removed" : `${action}d`}`);
      const { cid, events } = await chainOf(s, chains, "plugin", since, { action, plugin: target.id });
      t.diagnostic(`${app.name}: plugin ${action} ${cid}: ${events.map((event) => event.event).join(", ")}`);
    };
    await operate("disable");
    await operate("enable");
    await operate("remove");
    await operate("install");

    // A project opens in its own window (the default of projectOpening), the window closes, and the project leaves the registry.
    const root = realpathSync(mkdtempSync(join(tmpdir(), "soksak-chains-")));
    const projectRoot = join(root, "project");
    mkdirSync(projectRoot);
    s.cleanup(() => rmSync(root, { recursive: true, force: true }));
    s.cleanup(async () => {
      for (const window of await s.get("host.windows")) {
        if (window.window !== s.window) await s.on(window.window).close();
      }
      await s.windows(1, "the chains check left an extra window");
      for (const project of await s.get("core.projects")) {
        if (project.root.startsWith(root)) await s.run("core.project.close", { id: project.id });
      }
      await s.run("core.projects.flush");
    });
    const added = (list, known) => list.find((item) => !known.includes(item.window)).window;
    let since = await tailOf(s);
    const opened = await s.run("core.project.open", { root: projectRoot, color: "#7fe3b0" });
    const project = s.on(added(await s.windows(2, "the project window did not open"), [s.window]));
    await project.until("core.project", (value) => value?.id === opened.id, "the project did not become active in its window");
    await chainOf(s, chains, "project", since, { action: "open", project: opened.id });
    since = await tailOf(s);
    await project.close();
    await s.windows(1, "the project window did not close");
    await chainOf(s, chains, "window", since, { action: "close" });
    since = await tailOf(s);
    await s.run("core.project.close", { id: opened.id });
    await s.until("core.projects", (projects) => !projects.some((item) => item.id === opened.id), "the project did not leave the registry");
    await chainOf(s, chains, "project", since, { action: "remove", project: opened.id });

    // A window opens and closes.
    since = await tailOf(s);
    await s.run("core.window.new");
    const created = s.on(added(await s.windows(2, "the new window did not open"), [s.window]));
    await chainOf(s, chains, "window", since, { action: "new" });
    since = await tailOf(s);
    await created.close();
    await s.windows(1, "the new window did not close");
    await chainOf(s, chains, "window", since, { action: "close" });

    // The application update runs against a registry that offers a newer release whose download is refused.
    const key = `darwin-${process.arch === "arm64" ? "arm64" : "x64"}-${app.name}`;
    const index = JSON.parse(readFileSync(join(REGISTRY, "index.json"), "utf8"));
    const release = { url: `https://127.0.0.1:9/soksak-app/core/releases/download/v${NEWER}/soksak-${NEWER}.zip`, sha256: "0".repeat(64) };
    index.core = { versions: [{ version: NEWER, releases: { [key]: release } }] };
    const folder = mkdtempSync(join(tmpdir(), "soksak-chains-registry-"));
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
    await s.until("core.app", (value) => value.available?.version === NEWER, "the registry with a newer core did not list an update");
    await s.run("core.plugins.show-updates");
    await s.until("core.library", (library) => library.page === "plugins", "the plugin page did not show");
    since = await tailOf(s);
    s.expectError(/application update 99\.0\.0: /);
    await s.act("core.library.app.update", "click");
    await s.until("core.app", (value) => value.operation?.state === "failed", "the update operation did not report its failure");
    await chainOf(s, chains, "update", since, { action: "update", version: NEWER });

    // A common setting changes through the declared command that names itself as the actor.
    since = await tailOf(s);
    await s.run("core.settings.set", { patch: { projectOpening: "tabs" }, scope: "common" });
    await chainOf(s, chains, "settings", since, { scope: "common", actor: "core.settings.set", keys: "projectOpening" });
  });
}
