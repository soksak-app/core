// A window that another window covers is reported occluded, and WebKit hides the documents of its document regions
// (docs/spec/native-surfaces.md#document-regions), so a covered tab stops drawing and releases its memory. The document is the region
// document of the layout probe start tab, which reports its visibility state (layoutprobe.document).
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { coverCheckWindow, fresh } from "./fixture.mjs";

for (const app of Object.values(APPS)) {
  test(`${app.name}: a covered window is occluded and hides the document of its tab`, { timeout: 90000 }, async (t) => {
    const s = await open(t, app);
    const { surface } = await fresh(s);
    // The check starts behind the windows of a person, which may cover this window already; the claim holds whatever covered it
    // before, so the check covers it with its own window and judges only the covered state (docs/spec/hosts.md#launch-activation).
    await s.until("layoutprobe.document", (at) => at.reported, "the region document did not report its visibility", { surface });

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
    await coverCheckWindow(s, cover);

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
    await measured(() => s.until("layoutprobe.document", (at) => at.document === "hidden",
      "the covered region document stayed visible", { surface }));
  });
}
