// 사이드바마다 고른 탭과 접은 섹션이 스페이스와 함께 저장되어 다시 불러온 뒤에도 보이는지 검사한다
// (docs/spec/projects.md#persistence).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh, terminalCardSidebar } from "./fixture.mjs";

const read = (path) => JSON.parse(readFileSync(path, "utf8"));

for (const app of Object.values(APPS)) {
  test(`${app.name}: a sidebar's selected tab and folded sections survive a reload from the saved space`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    await terminalCardSidebar(s);
    // 터미널 카드의 안쪽 왼쪽 사이드바는 tabs 세트, 왼쪽 고정 사이드바는 list 세트로 둔다.
    const sets = (await s.get("core.settings")).values.sets;
    await s.run("core.settings.set", { patch: {
      sets: sets.map((set) => (set.id === "set-files" ? { ...set, layout: "tabs" } : set)) }, scope: "common" });
    const of = (bars, id) => bars.find((bar) => bar.sidebar === id);
    await s.until("core.sidebars", (bars) => of(bars, "terminal:left")?.layout === "tabs" && of(bars, "left")?.layout === "list",
      "the terminal card sidebar and the left sidebar did not draw");

    await s.run("core.sidebar.section.select", { sidebar: "terminal:left", section: "files.bookmarks" });
    await s.run("core.sidebar.section.fold", { sidebar: "left", section: "files.bookmarks" });
    const chosen = (bars) => of(bars, "terminal:left")?.tab === "files.bookmarks"
      && of(bars, "left")?.sections.find((item) => item.id === "files.bookmarks")?.folded === true;
    await s.until("core.sidebars", chosen, "the tab and the fold were not applied");
    await s.run("core.projects.flush");

    // 저장된 스페이스가 선택을 담는다.
    const project = await s.get("core.project");
    const record = read(join(dirname(project.root), "projects.json")).find((item) => item.id === project.id);
    const layout = record.spaces.find((space) => space.id === record.activeSpaceId).layout;
    assert.deepEqual(layout.sidebars["terminal:left"], { tab: "files.bookmarks", folded: [] });
    assert.deepEqual(layout.sidebars.left.folded, ["files.bookmarks"]);

    // 문서를 다시 불러오면 저장된 스페이스에서 같은 선택이 보인다.
    const before = (await s.get("core.window.document")).timeOrigin;
    await s.run("host.window.reload");
    await s.until("core.window.document", (doc) => doc.timeOrigin !== before && doc.readyState === "complete",
      "the main document did not reload");
    await s.until("core.sidebars", chosen, "the reloaded document did not show the saved tab and fold");
  });
}
