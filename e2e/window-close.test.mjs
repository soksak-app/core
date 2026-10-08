// A window close request asks about each modified tab before the window closes (docs/spec/plugins.md#tab-reports).
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";

const QUESTION = ["저장하고 닫기", "저장하지 않고 닫기", "닫지 않기"];

for (const app of Object.values(APPS)) {
  test(`${app.name}: closing a window asks about a modified tab and 닫지 않기 keeps the window`, { timeout: 90000 }, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    const root = realpathSync(mkdtempSync(join(tmpdir(), "soksak-window-close-")));
    const file = join(root, "note.txt");
    writeFileSync(file, "alpha\n");
    s.cleanup(() => rmSync(root, { recursive: true, force: true }));
    s.cleanup(async () => {
      for (const window of await s.get("host.windows")) {
        if (window.window !== s.window) await s.on(window.window).close();
      }
      await s.windows(1, "the check left an extra window");
      for (const project of await s.get("core.projects")) {
        if (project.root.startsWith(root)) await s.run("core.project.close", { id: project.id });
      }
      await s.run("core.projects.flush");
    });
    await s.run("core.settings.set", { patch: { projectOpening: "windows" }, scope: "common" });
    const opened = await s.run("core.project.open", { root, color: "#7fe3b0" });
    const windows = await s.windows(2, "the project window did not open");
    const child = s.on(windows.find((item) => item.window !== s.window).window);
    await child.until("core.project", (project) => project?.id === opened.id, "the project did not become active");
    const { tab } = await child.run("core.file.open", { path: "note.txt" });
    await child.until("core.surfaces", (all) => all.some((x) => x.surface === tab && x.status.phase === "ready"),
      "the editor tab did not open");
    await child.until("editor.document", (value) => value.path === "note.txt" && value.version !== null,
      "the editor did not read the file", { surface: tab });
    await child.run("editor.edit", { changes: [{ from: 0, to: 0, insert: "z" }] }, tab);
    await child.until("editor.document", (value) => value.modified, "editor.edit did not modify the text", { surface: tab });

    const ask = async () => (await child.until("core.picker", (picker) => picker.open && picker.title.includes("저장하지 않은 변경이 있습니다"),
      "closing the window did not ask about the modified tab")).items.map((item) => item.name);
    await child.run("host.window.close");
    assert.deepEqual(await ask(), QUESTION);
    // 닫지 않기 keeps the window and the modified tab.
    await child.run("core.picker.pick", { index: 2 });
    await child.until("core.picker", (picker) => !picker.open, "닫지 않기 did not close the question");
    assert.equal((await s.get("host.windows")).length, 2, "닫지 않기 closed the window");
    assert.equal((await child.get("editor.document", tab)).modified, true);

    // 저장하지 않고 닫기 closes the window without writing the file.
    await child.run("host.window.close");
    assert.deepEqual(await ask(), QUESTION);
    await child.run("core.picker.pick", { index: 1 });
    await s.windows(1, "저장하지 않고 닫기 did not close the window");
    assert.equal(readFileSync(file, "utf8"), "alpha\n");
  });
}
