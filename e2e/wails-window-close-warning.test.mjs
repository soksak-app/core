// Checks project-window close on each selected host and the Wails-specific close warning.
// The check connects to an already running host; it never launches one.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";

function stderrPath(configDir, pid) {
  const logs = join(configDir, "logs");
  const matches = readdirSync(logs).filter((name) => new RegExp(`^host-\\d+-${pid}\\.stderr$`).test(name));
  if (matches.length !== 1) throw new Error(`${logs} has ${matches.length} stderr files for host ${pid}, expected one`);
  return join(logs, matches[0]);
}

function warningCount(contents) {
  return contents.split(/\r?\n/).filter((line) => /WebviewWindow #\d+ not found/.test(line)).length;
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: closing a project window preserves host availability`, { timeout: 90000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    const root = realpathSync(mkdtempSync(join(tmpdir(), "soksak-window-close-warning-")));
    // Two files of the type that the layout probe opens give the project window two document views.
    writeFileSync(join(root, "alpha.lprobe"), "alpha\n");
    writeFileSync(join(root, "beta.lprobe"), "beta\n");
    s.cleanup(() => rmSync(root, { recursive: true, force: true }));
    s.cleanupSteps(
      async () => {
        for (const window of await s.get("host.windows")) {
          if (window.window !== s.window && window.project === root) await s.on(window.window).close();
        }
        await s.windows(1, "the project-window close left an extra window");
      },
      async () => {
        for (const project of await s.get("core.projects")) {
          if (project.root === root) await s.run("core.project.close", { id: project.id });
        }
        await s.run("core.projects.flush");
      },
    );

    await s.run("core.settings.set", { patch: { projectOpening: "windows" }, scope: "common" });
    const opened = await s.run("core.project.open", { root, color: "#7fe3b0" });
    const windows = await s.windows(2, "the disposable project window did not open");
    const projectWindow = windows.find((window) => window.project === root && window.window !== s.window);
    assert.ok(projectWindow, `host.windows did not report project ${root}: ${JSON.stringify(windows)}`);
    const child = s.on(projectWindow.window);
    await child.until("core.project", (project) => project?.id === opened.id,
      "the disposable project did not become active in its window");
    for (const path of ["alpha.lprobe", "beta.lprobe"]) {
      const { tab } = await child.run("core.file.open", { path });
      await child.until("core.surfaces", (all) => all.some((surface) => surface.surface === tab &&
        surface.status.phase === "ready" && surface.exposes.includes("status layoutprobe.document")),
      `the tab of ${path} did not register its document status`);
      await child.until("layoutprobe.view", (view) => view.path === path, `the tab of ${path} did not start with its path`, { surface: tab });
      await child.until("layoutprobe.document", (document) => document.reported === true,
        `the document region of ${path} did not load`, { surface: tab });
    }

    const pid = s.client.endpoint.pid;
    const endpointPath = join(app.configDir, "endpoint.json");
    const logPath = app.name === "wailsv3" ? stderrPath(app.configDir, pid) : null;
    const warningsBefore = logPath === null ? 0 : warningCount(readFileSync(logPath, "utf8"));
    s.step(`close project window ${projectWindow.window} while host ${pid} remains live`);
    await child.close();
    await s.windows(1, "the project window did not close");
    await s.presented();
    await s.get("host.windows");

    // Read stderr after the remaining window presents and a host status request completes.
    if (logPath !== null) {
      const contents = readFileSync(logPath, "utf8");
      const newWarnings = contents.split(/\r?\n/).filter((line) => /WebviewWindow #\d+ not found/.test(line))
        .slice(warningsBefore);
      assert.deepEqual(newWarnings, [], `project-window close wrote missing-window warnings to ${logPath}: ${newWarnings.join(" | ")}`);
    }

    const endpoint = JSON.parse(readFileSync(endpointPath, "utf8"));
    assert.equal(endpoint.pid, pid, "the endpoint changed while reading the close warning");
    assert.ok(existsSync(endpointPath), "the host endpoint disappeared before the warning was read");
    process.kill(pid, 0);
    t.diagnostic(`host ${pid} remained live after project-window close${logPath === null ? "" : `; stderr ${logPath}; new missing-window warnings=0`}`);
  });
}
