// A window that another window covers is reported occluded, and WebKit hides the documents of its document regions
// (docs/spec/native-surfaces.md#document-regions), so a covered browser tab stops drawing and releases its memory.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";

/** A loopback server whose document shows its visibility state as its title. It is closed when the check ends. */
async function serve(s) {
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end("<!doctype html><title>visibility</title><script>const show = () => { document.title = `visibility:${document.visibilityState}`; };"
      + "document.addEventListener('visibilitychange', show); show();</script>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  s.cleanup(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}/visibility`;
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: a covered window is occluded and hides the document of its browser tab`, { timeout: 90000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    const url = await serve(s);
    await s.until("core.surfaces",
      (list) => list.some((x) => x.visible && x.plugin === "browser" && x.exposes.includes("status browser.location")),
      "no visible browser surface registered browser.location");
    const active = new Set((await s.get("core.grid")).cards.map((card) => card.active).filter(Boolean));
    const browser = (await s.get("core.surfaces")).find((x) => x.visible && x.plugin === "browser" && active.has(x.surface));
    assert.ok(browser, "the grid has no active visible browser surface");
    const surface = browser.surface;
    await s.run("browser.navigate", { url }, surface);
    await s.until("browser.location", (at) => at.url === url && !at.loading && at.title === "visibility:visible",
      "the browser document did not report itself visible", { surface });

    // A project window of the same application covers the check window, which a project-window check may open.
    const root = realpathSync(mkdtempSync(join(tmpdir(), "soksak-occlusion-")));
    s.cleanup(() => rmSync(root, { recursive: true, force: true }));
    s.cleanup(async () => {
      for (const window of await s.get("host.windows")) {
        if (window.window !== s.window) await s.on(window.window).close();
      }
      await s.windows(1, "the check left an extra window");
      for (const project of await s.get("core.projects")) {
        if (project.root === root) await s.run("core.project.close", { id: project.id });
      }
      await s.run("core.projects.flush");
    });
    await s.run("core.settings.set", { patch: { projectOpening: "windows" }, scope: "common" });
    await s.run("core.project.open", { root, color: "#7db4ff" });
    const windows = await s.windows(2, "the project window did not open");
    const cover = s.on(windows.find((w) => w.window !== s.window).window);
    const covered = (await s.get("host.window")).frame;
    await cover.run("host.window.resize", { width: covered.width + 200, height: covered.height + 100 });
    await cover.run("host.window.move", { x: covered.x - 100, y: covered.y - 50 });

    const state = async () => {
      const window = await s.get("host.window");
      const coverWindow = await cover.get("host.window");
      return JSON.stringify({ window: { frame: window.frame, occluded: window.occluded },
        cover: { frame: coverWindow.frame, occluded: coverWindow.occluded } });
    };
    // A failed wait names the frames and the occlusion states of both windows, which locate a cover that moved.
    const measured = async (wait) => {
      try {
        return await wait();
      } catch (error) {
        error.message += `; ${await state()}`;
        throw error;
      }
    };
    await measured(() => s.until("host.window", (w) => w.occluded === true, "the covered window was not reported occluded"));
    await measured(() => s.until("browser.location", (at) => at.title === "visibility:hidden",
      "the covered browser document stayed visible", { surface }));
  });
}
