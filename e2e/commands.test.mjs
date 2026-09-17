// UI 조작 명령을 실행하고 그 결과를 status 로 검사한다.
//
// 사람이 누르는 컨트롤은 같은 명령을 실행하므로(docs/spec/exposure.md), 명령의 결과가
// status 에 나타나면 컨트롤의 결과도 같다.
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, fresh, open } from "./app.mjs";

/** 카드 id 의 카드. */
const cardOf = (grid, id) => grid?.cards.find((c) => c.id === id);

/** 탭 id 가 있는 카드. */
const holder = (grid, tab) => grid?.cards.find((c) => c.tabs.some((t) => t.id === tab));

/** 조작할 수 있는 카드(도구 버튼이 있는 카드). 사이드바와 레일 자리는 제외한다. */
const panes = (grid) => grid.cards.filter((c) => c.pane !== null);

const ids = (grid) => panes(grid).map((c) => c.id).sort();

for (const app of Object.values(APPS)) {
  test(`${app.name}: card, tab, and menu commands change the grid`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    const start = await s.get("core.grid");
    const shell = cardOf(start, "shell");
    const browser = cardOf(start, "browser");
    assert.ok(shell && browser, `the start layout must have shell and browser cards: ${ids(start)}`);
    assert.equal(shell.acts.add.enabled, true, "the shell card must be able to add a tab");

    await s.run("core.card.focus", { card: "browser" });
    await s.until("core.grid", (grid) => cardOf(grid, "browser").focused, "core.card.focus did not focus the card");

    // 추가 메뉴를 열고 닫은 뒤, 다시 열어 항목을 고른다.
    await s.run("core.card.menu", { card: "shell", menu: "add" });
    const menu = await s.until("core.picker", (picker) => picker.open && picker.items.length > 0,
      "core.card.menu did not open the add menu");
    await s.until("core.modal", (modal) => modal?.id === "picker", "the add menu did not show its modal");
    await s.run("core.picker.close");
    await s.until("core.picker", (picker) => !picker.open, "core.picker.close did not close the menu");
    const browserItem = menu.items.findIndex((item) => item.key === "browser");
    assert.ok(browserItem >= 0, `the add menu must list the browser: ${JSON.stringify(menu.items)}`);
    await s.run("core.card.menu", { card: "shell", menu: "add" });
    await s.until("core.picker", (picker) => picker.open, "the add menu did not open again");
    await s.run("core.picker.pick", { index: browserItem });
    const picked = await s.until("core.grid", (grid) => cardOf(grid, "shell").tabs.length === shell.tabs.length + 1,
      "core.picker.pick did not add a tab");
    assert.equal((await s.get("core.picker")).open, false, "picking must close the menu");
    const added = cardOf(picked, "shell");
    assert.equal(added.tabs.at(-1).plugin, "browser");
    assert.equal(added.active, added.tabs.at(-1).id, "the added tab must be active");

    await s.run("core.tab.select", { tab: shell.tabs[0].id });
    await s.until("core.grid", (grid) => cardOf(grid, "shell").active === shell.tabs[0].id,
      "core.tab.select did not activate the tab");
    await s.run("core.tab.close", { tab: added.tabs.at(-1).id });
    await s.until("core.grid", (grid) => cardOf(grid, "shell").tabs.length === shell.tabs.length,
      "core.tab.close did not close the tab");

    // 탭을 다른 카드의 가운데로, 그다음 변으로 옮긴다.
    const { tab } = await s.run("core.card.add-tab", { card: "shell", plugin: "browser" });
    await s.until("core.grid", (grid) => holder(grid, tab)?.id === "shell", "core.card.add-tab did not add the tab");
    await s.run("core.tab.move", { tab, card: "browser", zone: "centre" });
    await s.until("core.grid", (grid) => holder(grid, tab)?.id === "browser", "core.tab.move did not move the tab to the centre");
    await s.run("core.tab.move", { tab, card: "browser", zone: "right" });
    const split = await s.until("core.grid", (grid) => panes(grid).length === panes(start).length + 1,
      "core.tab.move did not make a card on the right");
    const made = holder(split, tab);
    assert.ok(made && !start.cards.some((c) => c.id === made.id), "the moved tab must be in a new card");
    assert.ok(made.x > cardOf(split, "browser").x, "the new card must be right of the browser card");
    assert.equal((await s.get("core.drag")), null, "no drag must remain after a command move");
    await s.run("core.card.close", { card: made.id });
    await s.until("core.grid", (grid) => panes(grid).length === panes(start).length, "core.card.close did not close the card");

    const result = await s.run("core.card.split", { card: "shell", axis: "x", plugin: "browser" });
    const wide = await s.until("core.grid", (grid) => cardOf(grid, result.card), "core.card.split did not add a card");
    assert.equal(cardOf(wide, result.card).tabs[0].plugin, "browser");
    await s.run("core.card.close", { card: result.card });
    await s.until("core.grid", (grid) => !cardOf(grid, result.card), "the split card did not close");

    await s.run("core.card.tab-list", { card: "shell" });
    const list = await s.until("core.picker", (picker) => picker.open, "core.card.tab-list did not open the tab list");
    assert.equal(list.items.length, shell.tabs.length);
    await s.run("core.picker.close");
    await s.until("core.picker", (picker) => !picker.open, "the tab list did not close");

    await s.run("core.card.split", { card: "shell", axis: "y", plugin: "browser" });
    await s.until("core.grid", (grid) => panes(grid).length === panes(start).length + 1, "the second split did not add a card");
    await s.run("core.layout.reset");
    await s.until("core.grid", (grid) => ids(grid).join() === ids(start).join(), "core.layout.reset did not restore the layout");
  });

  test(`${app.name}: settings modal commands change its section, scope, and position`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    await s.run("core.settings.open");
    const opened = await s.until("core.settings-modal", (modal) => modal.open, "settings did not open");
    for (const section of ["sidebars", "compositing", "general"]) {
      await s.run("core.settings-modal.nav", { section });
      await s.until("core.settings-modal", (modal) => modal.section === section, `settings did not show ${section}`);
    }
    await s.run("core.settings-modal.scope", { scope: "project" });
    const project = await s.until("core.settings-modal", (modal) => modal.scope === "project", "settings did not select project scope");
    const tab = project.controls.find((c) => c.key === "pick:scope:project");
    assert.equal(tab?.on, true, "the project scope tab must be selected");
    assert.deepEqual(tab.command, { name: "core.settings-modal.scope", params: { scope: "project" } });
    await s.run("core.settings-modal.scope", { scope: "common" });
    await s.until("core.settings-modal", (modal) => modal.scope === "common", "settings did not select common scope");

    await s.run("core.settings-modal.move", { dx: 40, dy: 20 });
    const moved = await s.until("core.settings-modal",
      (modal) => modal.card.x === opened.card.x + 40 && modal.card.y === opened.card.y + 20,
      "core.settings-modal.move did not move the card by 40,20");
    await s.until("core.modal", (modal) => modal?.document?.rect.x === moved.card.x && modal.document.rect.y === moved.card.y,
      "the native modal document did not follow the card");

    const mode = (await s.get("core.settings")).values.mode;
    const other = mode === "dark" ? "light" : "dark";
    const pick = moved.controls.find((c) => c.key === `pick:mode:${other}`);
    assert.ok(pick?.command, "the appearance control must name its command");
    await s.run(pick.command.name, pick.command.params);
    await s.until("core.settings", (value) => value.values.mode === other && !value.saving, "the control command did not change the mode");

    await s.run("core.settings.close");
    await s.until("core.settings-modal", (modal) => !modal.open, "settings did not close");
  });

  test(`${app.name}: library commands search, sort, and edit the form`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    const project = await s.get("core.project");
    await s.run("core.projects.browse");
    const start = await s.until("core.library", (library) => library.shown.length === 1 && library.returnVisible,
      "the library did not list the project with a return button");

    await s.run("core.focus.set", { name: "core.library.search" });
    await s.until("core.focus", (focus) => focus?.name === "core.library.search", "core.focus.set did not focus search");
    await s.run("core.library.search", { query: "no such project" });
    await s.until("core.library", (library) => library.noResults && library.shown.length === 0,
      "core.library.search did not filter the library");
    await s.run("core.library.search", { query: "" });
    await s.until("core.library", (library) => library.shown.length === 1 && !library.noResults, "clearing search did not restore the list");
    const order = start.sort === "name" ? "recent" : "name";
    await s.run("core.library.sort", { order });
    await s.until("core.library", (library) => library.sort === order, "core.library.sort did not change the order");

    await s.run("core.library.pin", { id: project.id, pinned: true });
    await s.until("core.library", (library) => library.pinned.includes(project.id), "core.library.pin did not pin the project");
    await s.run("core.library.pin", { id: project.id, pinned: false });
    await s.until("core.library", (library) => !library.pinned.includes(project.id), "core.library.pin did not unpin the project");

    await s.run("core.library.form.open", { mode: "create" });
    await s.until("core.library", (library) => library.formState?.mode === "create", "the create form did not open");
    await s.run("core.library.form.set", { field: "name", value: "draft" });
    await s.until("core.library", (library) => library.formState?.name === "draft", "core.library.form.set did not fill the name");
    await s.run("core.library.form.cancel");
    await s.until("core.library", (library) => !library.form, "core.library.form.cancel did not close the form");

    await s.run("core.library.return");
    await s.until("core.screen", (screen) => screen.screen === "workspace", "core.library.return did not return to the workspace");
  });

  test(`${app.name}: layout commands return after the new layout is drawn`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    /** 문서에 그려진 카드 요소들의 너비. */
    const drawnWidths = async () => {
      const widths = [];
      for (let index = 0; ; index++) {
        const rect = await s.rect("core.card", index).catch(() => null);
        if (!rect) return widths;
        widths.push(rect.width);
      }
    };
    const start = await s.get("core.grid");
    const browser = cardOf(start, "browser");
    await s.run("core.boundary.move", { axis: "x", line: 2, position: start.lines.x[2] - 60 });
    const moved = cardOf(await s.get("core.grid"), "browser");
    assert.notEqual(moved.w, browser.w, "the boundary move did not change the card");
    const afterMove = await drawnWidths();
    assert.ok(afterMove.includes(moved.w) && !afterMove.includes(browser.w),
      `core.boundary.move returned before the card was drawn at ${moved.w}: ${afterMove}`);

    await s.run("core.grid.size", { card: "right", axis: "x", size: cardOf(await s.get("core.grid"), "right").w + 40 });
    const sized = cardOf(await s.get("core.grid"), "right");
    const afterSize = await drawnWidths();
    assert.ok(afterSize.includes(sized.w),
      `core.grid.size returned before the card was drawn at ${sized.w}: ${afterSize}`);
  });

  test(`${app.name}: rename commands edit and cancel a space title`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    const project = await s.get("core.project");
    const space = project.spaces.find((x) => x.id === project.activeSpaceId);

    await s.run("core.rename.begin", { kind: "space", id: space.id });
    await s.until("core.rename", (rename) => rename?.id === space.id && rename.value === space.title,
      "core.rename.begin did not start editing");
    await s.until("core.focus", (focus) => focus?.name === "core.rename.input", "the rename field did not take the focus");
    await s.run("core.rename.set", { value: "discarded" });
    await s.until("core.rename", (rename) => rename?.value === "discarded", "core.rename.set did not change the value");
    await s.run("core.rename.cancel");
    await s.until("core.rename", (rename) => rename === null, "core.rename.cancel did not stop editing");
    const kept = (await s.get("core.project")).spaces.find((x) => x.id === space.id);
    assert.equal(kept.title, space.title, "cancel must keep the title");

    await s.run("core.rename.begin", { kind: "space", id: space.id });
    await s.until("core.rename", (rename) => rename?.id === space.id, "rename did not start again");
    await s.run("core.rename.set", { value: "renamed" });
    await s.run("core.rename.commit");
    await s.until("core.project", (value) => value.spaces.find((x) => x.id === space.id)?.title === "renamed",
      "core.rename.commit did not rename the space");
    assert.equal(await s.get("core.rename"), null);
  });
}
