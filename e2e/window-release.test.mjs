// Checks that a closed project window leaves behind no window, no webview, no object that the shared library attached to the window and
// webview, and no WebContent process of the page.
//
// diagnostics.native.objects counts the live number of library objects after the application handles one event. The objects of a closed
// window are released when the autorelease pool of the event loop iteration that closed the window is drained, and the pool is
// drained when the application handles an event, so the check measures that release without user input. AppKit keeps a window that was on screen
// until the close animation ends and releases objects autoreleased during a drain at the next drain, so after the last window is closed it passes the initial count as equal,
// and receives the result of the comparison each time the library posts an event and drains the pool.
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { APPS, keepCommonSettings, open } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";

const CYCLES = 4;

const counts = (s, equal) => s.request("diagnostics.native.objects", equal ? { equal } : {});

for (const app of Object.values(APPS)) {
  test(`${app.name}: closed project windows release their windows, webviews, attached native objects and page processes`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    await keepCommonSettings(s);
    const root = realpathSync(mkdtempSync(join(tmpdir(), "soksak-release-")));
    s.cleanup(() => rmSync(root, { recursive: true, force: true }));
    s.cleanup(async () => {
      for (const window of await s.get("host.windows")) {
        if (window.window !== s.window) await s.on(window.window).close();
      }
      await s.windows(1, "a project window did not close");
      for (const project of await s.get("core.projects")) {
        if (project.root === root) await s.run("core.project.close", { id: project.id });
      }
    });
    await s.run("core.settings.set", { patch: { projectOpening: "windows" }, scope: "common" });

    const before = await counts(s);
    const measured = [];
    const pageProcesses = [];
    for (let cycle = 1; cycle <= CYCLES; cycle++) {
      const label = `cycle ${cycle}`;
      const opened = await s.run("core.project.open", { root, color: "#7db4ff" });
      const windows = await s.windows(2, `${label}: the project window did not open`);
      const child = s.on(windows.find((w) => w.window !== s.window).window);
      await child.until("core.project", (project) => project?.id === opened.id, `${label}: the project did not become active`);
      await child.until("core.surfaces", (surfaces) => surfaces.some((surface) => surface.visible),
        `${label}: the project window showed no surface`);
      await child.presented();
      const { pageProcess } = await child.get("host.window");
      assert.ok(Number.isInteger(pageProcess) && pageProcess > 0, `${label}: the project window has no page process: ${pageProcess}`);
      pageProcesses.push(pageProcess);
      const showing = await counts(s);
      measured.push(showing);
      // The composition view, surface, and input registration of an open window must be counted so that the value after closing shows the release.
      assert.ok(showing.windowCompositions > before.windowCompositions && showing.surfaceHosts > before.surfaceHosts &&
        showing.inputRegistrations > before.inputRegistrations,
        `${label}: the open project window is not counted: before ${JSON.stringify(before)}, open ${JSON.stringify(showing)}`);
      await child.close();
      await s.windows(1, `${label}: the project window did not close`);
      await s.run("core.project.close", { id: opened.id });
      await s.until("core.projects", (projects) => !projects.some((project) => project.id === opened.id),
        `${label}: the project did not leave the registry`);
    }
    // If the count does not return to before within 10 seconds, the request fails with an error that holds the count at that time.
    const after = await counts(s, before).catch((error) => {
      throw new Error(`${app.name}: ${CYCLES} closed project windows left native objects: ${error.message}; ` +
        `before ${JSON.stringify(before)}, while open ${JSON.stringify(measured)}`);
    });
    t.diagnostic(`${app.name}: before ${JSON.stringify(before)}, open ${JSON.stringify(measured)}, after ${JSON.stringify(after)}`);
    assert.deepEqual(after, before);
    // WebKit ends a WebContent process whose pages are all released. The process may end after the count returns, so the check waits
    // for the exit.
    for (const pid of pageProcesses) {
      await s.request("diagnostics.process.exit", { pid }).catch((error) => {
        throw new Error(`${app.name}: the page process of a closed project window is still running: ${error.message}; ` +
          `page processes ${JSON.stringify(pageProcesses)}`);
      });
    }
  });
}
