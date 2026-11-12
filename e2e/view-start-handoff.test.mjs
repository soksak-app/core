// Checks that the start parameters of core.file.open reach the page view of the opened file (core.surface.document and the start
// values of the page), on the layout probe, which opens .lprobe files.
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh, START_PLUGIN } from "./fixture.mjs";

for (const app of Object.values(APPS)) {
  test(`${app.name}: file-open parameters reach the pages of the opened files`, { timeout: 60000 }, async (t) => {
    const main = await open(t, app);
    await fresh(main);
    await main.run("core.settings.set", { patch: { projectOpening: "windows" }, scope: "common" });

    const root = realpathSync(mkdtempSync(join(tmpdir(), "soksak-view-start-")));
    writeFileSync(join(root, "alpha.lprobe"), "alpha\n");
    writeFileSync(join(root, "beta.lprobe"), "beta\n");
    main.cleanup(() => rmSync(root, { recursive: true, force: true }));

    const opened = await main.run("core.project.open", { root, color: "#7fe3b0" });
    assert.equal(typeof opened.id, "string", "core.project.open returned no project id");
    const windows = await main.windows(2, "opening the verification project did not produce its project window");
    const owner = windows.find((item) => item.project === root && item.ready);
    assert.ok(owner, `no ready window owns project ${root}: ${JSON.stringify(windows)}`);
    const project = main.on(owner.window);
    await project.until("core.project", (value) => value?.id === opened.id && value?.root === root,
      "the returned project id did not identify the opened project window");
    await project.until("core.grid", (value) => value?.cards?.length > 0,
      "the opened project window did not render its grid");

    main.cleanupSteps(
      async () => {
        const current = await main.get("host.windows");
        if (current.some((item) => item.window === owner.window) && owner.window !== main.window) await project.close();
      },
      async () => {
        const projects = await main.get("core.projects");
        if (projects.some((item) => item.id === opened.id)) await main.run("core.project.close", { id: opened.id });
        await main.run("core.projects.flush");
      },
    );

    // Two files of the type that the layout probe opens each reach their own tab with their own path.
    for (const path of ["alpha.lprobe", "beta.lprobe"]) {
      const opened = await project.run("core.file.open", { path });
      assert.equal(typeof opened.tab, "string", `core.file.open returned no tab for ${path}`);
      const surface = await project.until("core.surfaces", (all) =>
        all.some((item) => item.surface === opened.tab && item.plugin === START_PLUGIN && item.exposes.includes("status core.surface.document")),
      `the opened tab of ${path} did not register its surface`);
      assert.ok(surface, `the opened tab of ${path} has no surface`);
      const start = await project.until("core.surface.document", (value) => value?.params?.path === path,
        `the surface of ${path} did not receive the file-open path`, { surface: opened.tab });
      assert.deepEqual(start.params, { path });
      // The page reads the start parameters of its surface at its start and reports them.
      const view = await project.until("layoutprobe.view", (value) => value?.path === path,
        `the page of ${path} did not read the file-open path from its start values`, { surface: opened.tab });
      assert.deepEqual(view.params, { path });
      assert.equal(view.surface, opened.tab);
    }
  });
}
