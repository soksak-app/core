// 라이브러리 시작, 기존 OS 창 재사용, 폴더 생성과 작업 화면 복원을 검사한다.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { APPS, failure, fresh, open } from "./app.mjs";

/** 창 목록에서 known 에 없는 창 하나. */
const added = (list, known) => list.find((w) => !known.includes(w.window)).window;

/** 라이브러리가 보이는 프로젝트 수가 count 가 될 때까지 기다린다. */
const shown = (s, count, message) => s.until("core.library", (library) => library.shown.length === count, message);

/** 프로젝트 저장이 끝날 때까지 기다린 뒤 이름이 id 인 프로젝트를 반환한다. */
const project = async (s, id) => (await s.get("core.projects")).find((p) => p.id === id);

for (const app of Object.values(APPS)) {
  test(`${app.name}: library windows create and open projects in place`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    const temporary = realpathSync(mkdtempSync(join(tmpdir(), "soksak-library-")));
    s.cleanup(async () => {
      for (const window of await s.get("host.windows")) {
        if (window.window !== s.window) await s.on(window.window).close();
      }
      await s.windows(1, "extra windows did not close");
      for (const item of await s.get("core.projects")) {
        if (item.root.startsWith(temporary)) await s.run("core.project.close", { id: item.id });
      }
      const remaining = await s.get("core.projects");
      if (remaining.length) await s.run("core.project.activate", { id: remaining[0].id });
      await s.run("core.projects.flush");
      rmSync(temporary, { recursive: true, force: true });
    });

    const geometry = (await s.get("core.grid")).cards.map(({ id, x, y, w, h }) => ({ id, x, y, w, h }));
    const first = await s.get("core.project");
    await s.run("core.settings.set", { patch: { projectOpening: "windows" }, scope: "common" });
    await s.run("core.projects.browse");
    assert.equal((await s.get("core.screen")).screen, "library");
    assert.equal((await s.surfaces("shell")).length, 0);
    assert.equal((await s.get("host.window")).surfaces.some((x) => x.visible), false, "the library shows no native surface");
    const library = await shown(s, 1, "the library did not list the project");
    const preview = library.previews[first.id].map(({ card, x, y, w, h }) => ({ id: card, x, y, w, h }));
    assert.deepEqual(preview.map((c) => c.id).sort(), geometry.map((c) => c.id).sort(), "preview must include the workspace cards");
    for (const a of geometry) {
      for (const b of geometry) {
        const pa = preview.find((c) => c.id === a.id), pb = preview.find((c) => c.id === b.id);
        if (a.x + a.w <= b.x) assert.ok(pa.x + pa.w < pb.x, `${a.id} must remain left of ${b.id}`);
        if (a.y + a.h <= b.y) assert.ok(pa.y + pa.h < pb.y, `${a.id} must remain above ${b.id}`);
      }
    }
    const [left, rail, shell, browser, right] = ["left", "rail-shell", "shell", "browser", "right"]
      .map((id) => preview.find((c) => c.id === id));
    assert.ok(Math.abs(left.w - right.w) <= 1 / 64, "sidebar widths must be uniform");
    assert.ok(Math.abs(shell.h - browser.h) <= 1 / 64, "split rows must have equal heights");
    const gaps = [rail.x - left.x - left.w, shell.x - rail.x - rail.w, right.x - shell.x - shell.w,
      browser.y - shell.y - shell.h];
    assert.ok(gaps.every((gap) => gap > 0 && Math.abs(gap - gaps[0]) <= 1 / 64), "pane gaps must be uniform on both axes");
    const saved = await project(s, first.id);
    const space = saved.spaces.find((x) => x.id === saved.activeSpaceId);
    assert.equal("preview" in space.layout, false, "screen state must not store renderer coordinates for previews");

    await s.run("core.window.new");
    const two = await s.windows(2, "new OS window was not created");
    let child = s.on(added(two, [s.window]));
    await shown(child, 1, "new window library did not initialise");
    assert.equal(await child.get("core.project"), null);
    const blank = await child.get("host.window");
    assert.deepEqual([blank.surfaces.length, blank.modal], [0, null], "a library window has only its main document");

    // 실제 라이브러리 생성 폼을 제출한다.
    await child.run("core.library.form.open", { mode: "create" });
    await child.run("core.library.form.set", { field: "name", value: "created" });
    await child.run("core.library.form.set", { field: "parent", value: temporary });
    await child.run("core.library.form.submit");
    await child.until("core.screen", (screen) => screen.screen === "workspace", "created project did not replace the library");
    assert.equal((await s.get("host.windows")).length, 2);
    const created = await child.get("core.project");
    assert.equal(created.root, join(temporary, "created"));
    assert.equal(existsSync(created.root), true);
    await child.until("core.grid", (grid) => grid?.cards.length > 0, "new project cards did not render");
    await child.run("core.projects.browse");
    await child.until("core.screen", (screen) => screen.screen === "library", "project list button did not open the library");
    await child.until("core.library", (state) => state.count === "프로젝트 2 · 열림 2", "open project count is not actual");
    const order = (await child.get("core.library")).shown;
    assert.ok(order.includes(created.id), "the library must list the created project");
    await child.run("core.library.pin", { id: created.id, pinned: true });
    await child.until("core.projects", (list) => list.find((p) => p.id === created.id)?.pinned, "pin was not saved");
    await child.run("core.library.search", { query: "created" });
    await shown(child, 1, "search did not filter the library");
    await child.run("core.project.activate", { id: created.id });
    assert.equal((await s.get("host.windows")).length, 2);
    await child.until("host.window", (state) => state.surfaces.some((x) => x.visible), "return did not restore native content");
    await child.close();
    await s.windows(1, "project close did not complete");

    // 미선택 새 창에서 저장된 프로젝트를 열어도 창 수는 증가하지 않는다.
    await s.run("core.window.new");
    child = s.on(added(await s.windows(2, "second library window did not open"), [s.window]));
    const libraryOrder = (await shown(child, 2, "saved library did not render")).shown;
    assert.ok(libraryOrder.includes(created.id), "the library must list the saved project");
    await child.run("core.library.open", { id: created.id });
    await child.until("core.screen", (screen) => screen.screen === "workspace", "saved project did not reuse the new window");
    assert.equal((await s.get("host.windows")).length, 2);

    // 이미 열린 프로젝트는 기존 창을 선택하며, 미선택 창은 그대로 유지한다.
    assert.deepEqual(await s.get("host.dock"), ["새 창"]);
    await s.run("host.dock.select", { title: "새 창" });
    const three = await s.windows(3, "third library did not open");
    const third = s.on(added(three, [s.window, child.window]));
    await shown(third, 2, "third library did not render");
    await third.run("core.project.activate", { id: created.id });
    assert.equal((await s.get("host.windows")).length, 3);
    assert.equal(await third.get("core.project"), null);
    for (const name of ["../escape", "created"]) {
      assert.equal(await failure(third.run("core.folder.create", { parent: temporary, name })), -32000,
        `the host must reject creating ${name}`);
    }
    assert.equal(existsSync(join(temporary, "created")), true);
    assert.equal((await third.get("core.screen")).screen, "library");
    t.diagnostic("same OS window reused for creation and saved projects; Dock menu creates an unassigned library window");
  });
}
