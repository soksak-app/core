import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";

const HWP_FIXTURE = new URL("./fixtures/two-paragraphs.hwp", import.meta.url);

for (const app of Object.values(APPS)) {
  test(`${app.name}: file-open parameters reach editor and HWP pages`, { timeout: 60000 }, async (t) => {
    const main = await open(t, app);
    await fresh(main);
    await main.run("core.settings.set", { patch: { projectOpening: "windows" }, scope: "common" });

    const root = realpathSync(mkdtempSync(join(tmpdir(), "soksak-view-start-")));
    writeFileSync(join(root, "sample.txt"), "alpha\n");
    copyFileSync(HWP_FIXTURE, join(root, "two-paragraphs.hwp"));
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

    main.cleanup(async () => {
      const current = await main.get("host.windows");
      if (current.some((item) => item.window === owner.window) && owner.window !== main.window) await project.close();
      const projects = await main.get("core.projects");
      if (projects.some((item) => item.id === opened.id)) await main.run("core.project.close", { id: opened.id });
      await main.run("core.projects.flush");
    });

    const editor = await project.run("core.file.open", { path: "sample.txt" });
    assert.equal(typeof editor.tab, "string", "core.file.open returned no editor tab");
    const editorSurface = await project.until("core.surfaces", (all) =>
      all.find((item) => item.surface === editor.tab && item.plugin === "editor" && item.exposes.includes("status core.surface.document")),
    "the opened editor tab did not register its surface");
    const editorStart = await project.until("core.surface.document", (value) => value?.params?.path === "sample.txt",
      "the editor surface did not receive the file-open path", { surface: editor.tab });
    assert.deepEqual(editorStart.params, { path: "sample.txt" });
    const editorDocument = await project.until("editor.document", (value) =>
      value?.path === "sample.txt" && typeof value.version === "string",
    "the editor did not read the file after receiving its start parameters", { surface: editor.tab });
    assert.equal(editorDocument.path, "sample.txt");

    const hwp = await project.run("core.file.open", { path: "two-paragraphs.hwp" });
    assert.equal(typeof hwp.tab, "string", "core.file.open returned no HWP tab");
    const hwpSurface = await project.until("core.surfaces", (all) =>
      all.find((item) => item.surface === hwp.tab && item.plugin === "hwp" && item.exposes.includes("status core.surface.document")),
    "the opened HWP tab did not register its surface");
    const hwpStart = await project.until("core.surface.document", (value) => value?.params?.path === "two-paragraphs.hwp",
      "the HWP surface did not receive the file-open path", { surface: hwp.tab });
    assert.deepEqual(hwpStart.params, { path: "two-paragraphs.hwp" });
    const hwpDocument = await project.until("hwp.document", (value) =>
      value?.path === "two-paragraphs.hwp" && typeof value.version === "string" && value.pages > 0 && value.phase === "ready",
    "the HWP reader did not finish with a document version and pages", { surface: hwp.tab });
    assert.equal(hwpDocument.path, "two-paragraphs.hwp");
    assert.ok(editorSurface && hwpSurface);
  });
}
