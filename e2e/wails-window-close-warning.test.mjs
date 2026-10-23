// Reproduces Wails close warnings while the application remains available.
// The check connects to an already running host; it never launches one.
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";

const HWP_FIXTURE = new URL("./fixtures/two-paragraphs.hwp", import.meta.url);
const app = APPS.wailsv3;
if (!app) throw new Error("wails-window-close-warning.test.mjs requires SOKSAK_APP=wailsv3");

function stderrPath(configDir, pid) {
  const logs = join(configDir, "logs");
  const matches = readdirSync(logs).filter((name) => new RegExp(`^host-\\d+-${pid}\\.stderr$`).test(name));
  if (matches.length !== 1) throw new Error(`${logs} has ${matches.length} stderr files for host ${pid}, expected one`);
  return join(logs, matches[0]);
}

function warningCount(contents) {
  return contents.split(/\r?\n/).filter((line) => /WebviewWindow #\d+ not found/.test(line)).length;
}

test("wailsv3: closing a project window leaves no missing-window warnings", { timeout: 90000 }, async (t) => {
  const s = await open(t, app);
  await fresh(s);
  const root = realpathSync(mkdtempSync(join(tmpdir(), "soksak-window-close-warning-")));
  const file = join(root, "note.txt");
  writeFileSync(file, "alpha\n");
  copyFileSync(HWP_FIXTURE, join(root, "two-paragraphs.hwp"));
  s.cleanup(() => rmSync(root, { recursive: true, force: true }));
  s.cleanup(async () => {
    for (const window of await s.get("host.windows")) {
      if (window.window !== s.window && window.project === root) await s.on(window.window).close();
    }
    await s.windows(1, "the project-window close left an extra window");
    for (const project of await s.get("core.projects")) {
      if (project.root === root) await s.run("core.project.close", { id: project.id });
    }
    await s.run("core.projects.flush");
  });

  await s.run("core.settings.set", { patch: { projectOpening: "windows" }, scope: "common" });
  const opened = await s.run("core.project.open", { root, color: "#7fe3b0" });
  const windows = await s.windows(2, "the disposable project window did not open");
  const projectWindow = windows.find((window) => window.project === root && window.window !== s.window);
  assert.ok(projectWindow, `host.windows did not report project ${root}: ${JSON.stringify(windows)}`);
  const child = s.on(projectWindow.window);
  await child.until("core.project", (project) => project?.id === opened.id,
    "the disposable project did not become active in its window");
  const { tab } = await child.run("core.file.open", { path: "note.txt" });
  await child.until("core.surfaces", (all) => all.some((surface) => surface.surface === tab &&
    surface.status.phase === "ready" && surface.exposes.includes("status editor.document")),
  "the editor surface did not register its document status");
  await child.until("editor.document", (document) => document.path === "note.txt" && document.version !== null,
    "the editor did not read the disposable project file", { surface: tab });
  const hwp = await child.run("core.file.open", { path: "two-paragraphs.hwp" });
  await child.until("core.surfaces", (all) => all.some((surface) => surface.surface === hwp.tab &&
    surface.exposes.includes("status hwp.document")), "the HWP surface did not register its document status");
  await child.until("hwp.document", (document) => document.path === "two-paragraphs.hwp" &&
    document.phase === "ready" && document.pages > 0, "the HWP document did not finish loading", { surface: hwp.tab });

  const pid = s.client.endpoint.pid;
  const endpointPath = join(app.configDir, "endpoint.json");
  const logDirectory = join(app.configDir, "logs");
  const logPath = stderrPath(app.configDir, pid);
  const warningsBefore = warningCount(readFileSync(logPath, "utf8"));
  s.step(`close project window ${projectWindow.window} while host ${pid} remains live`);
  await child.close();
  await s.windows(1, "the project window did not close");
  await s.presented();
  await s.get("host.windows");

  // Read stderr after the remaining window presents and a host status request completes.
  const contents = readFileSync(logPath, "utf8");
  const newWarnings = contents.split(/\r?\n/).filter((line) => /WebviewWindow #\d+ not found/.test(line))
    .slice(warningsBefore);
  assert.deepEqual(newWarnings, [], `project-window close wrote missing-window warnings to ${logPath}: ${newWarnings.join(" | ")}`);

  const endpoint = JSON.parse(readFileSync(endpointPath, "utf8"));
  assert.equal(endpoint.pid, pid, "the endpoint changed while reading the close warning");
  assert.ok(existsSync(endpointPath), "the host endpoint disappeared before the warning was read");
  process.kill(pid, 0);
  t.diagnostic(`host ${pid} remained live after project-window close; stderr ${logPath}; new missing-window warnings=0`);
});
