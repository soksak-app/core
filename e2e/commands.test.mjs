// UI 조작 명령을 실행하고 그 결과를 status 로 검사한다.
//
// 사람이 누르는 컨트롤은 같은 명령을 실행하므로(docs/spec/exposure.md), 명령의 결과가
// status 에 나타나면 컨트롤의 결과도 같다.
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
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
    const terminal = cardOf(start, "terminal");
    const browser = cardOf(start, "browser");
    assert.ok(terminal && browser, `the start layout must have terminal and browser cards: ${ids(start)}`);
    assert.equal(terminal.acts.add.enabled, true, "the terminal card must be able to add a tab");

    await s.run("core.card.focus", { card: "browser" });
    await s.until("core.grid", (grid) => cardOf(grid, "browser").focused, "core.card.focus did not focus the card");

    // 추가 메뉴를 열고 닫은 뒤, 다시 열어 항목을 고른다.
    await s.run("core.card.menu", { card: "terminal", menu: "add" });
    const menu = await s.until("core.picker", (picker) => picker.open && picker.items.length > 0,
      "core.card.menu did not open the add menu");
    await s.until("core.modal", (modal) => modal?.id === "picker", "the add menu did not show its modal");
    await s.run("core.picker.close");
    await s.until("core.picker", (picker) => !picker.open, "core.picker.close did not close the menu");
    const browserItem = menu.items.findIndex((item) => item.key === "browser");
    assert.ok(browserItem >= 0, `the add menu must list the browser: ${JSON.stringify(menu.items)}`);
    await s.run("core.card.menu", { card: "terminal", menu: "add" });
    await s.until("core.picker", (picker) => picker.open, "the add menu did not open again");
    await s.run("core.picker.pick", { index: browserItem });
    const picked = await s.until("core.grid", (grid) => cardOf(grid, "terminal").tabs.length === terminal.tabs.length + 1,
      "core.picker.pick did not add a tab");
    assert.equal((await s.get("core.picker")).open, false, "picking must close the menu");
    const added = cardOf(picked, "terminal");
    assert.equal(added.tabs.at(-1).plugin, "browser");
    assert.equal(added.active, added.tabs.at(-1).id, "the added tab must be active");

    await s.run("core.tab.select", { tab: terminal.tabs[0].id });
    await s.until("core.grid", (grid) => cardOf(grid, "terminal").active === terminal.tabs[0].id,
      "core.tab.select did not activate the tab");
    await s.run("core.tab.close", { tab: added.tabs.at(-1).id });
    await s.until("core.grid", (grid) => cardOf(grid, "terminal").tabs.length === terminal.tabs.length,
      "core.tab.close did not close the tab");

    // 탭을 다른 카드의 가운데로, 그다음 변으로 옮긴다.
    const { tab } = await s.run("core.card.add-tab", { card: "terminal", plugin: "browser" });
    await s.until("core.grid", (grid) => holder(grid, tab)?.id === "terminal", "core.card.add-tab did not add the tab");
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

    // 분할은 새 카드를 정한 변에 둔다. 왼쪽과 위는 새 카드가 원래 카드보다 앞이고, 오른쪽과 아래는 뒤다.
    const beside = {
      left: (born, base) => born.x + born.w <= base.x, right: (born, base) => born.x >= base.x + base.w,
      top: (born, base) => born.y + born.h <= base.y, bottom: (born, base) => born.y >= base.y + base.h,
    };
    for (const side of ["left", "right", "top", "bottom"]) {
      const result = await s.run("core.card.split", { card: "terminal", side, plugin: "browser" });
      const split = await s.until("core.grid", (grid) => cardOf(grid, result.card), `core.card.split ${side} did not add a card`);
      const born = cardOf(split, result.card);
      assert.equal(born.tabs[0].plugin, "browser");
      assert.ok(beside[side](born, cardOf(split, "terminal")), `the ${side} split put the new card at ${JSON.stringify(born)}`);
      await s.run("core.card.close", { card: result.card });
      await s.until("core.grid", (grid) => ids(grid).join() === ids(start).join(), `closing the ${side} split did not restore the layout`);
    }
    await assert.rejects(s.run("core.card.split", { card: "terminal", axis: "x", plugin: "browser" }), /unknown side undefined/);

    await s.run("core.card.tab-list", { card: "terminal" });
    const list = await s.until("core.picker", (picker) => picker.open, "core.card.tab-list did not open the tab list");
    assert.equal(list.items.length, terminal.tabs.length);
    await s.run("core.picker.close");
    await s.until("core.picker", (picker) => !picker.open, "the tab list did not close");

    const second = await s.run("core.card.split", { card: "terminal", side: "bottom", plugin: "browser" });
    await s.until("core.grid", (grid) => panes(grid).length === panes(start).length + 1, "the second split did not add a card");
    await s.run("core.card.close", { card: second.card });
    await s.until("core.grid", (grid) => ids(grid).join() === ids(start).join(), "closing the second split did not restore the layout");
  });

  test(`${app.name}: settings modal commands change its section, scope, and position`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    await s.run("core.settings.open");
    const opened = await s.until("core.settings-modal", (modal) => modal.open, "settings did not open");
    for (const section of ["sidebars", "plugins", "general"]) {
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
    // 모드는 선택 상자다. 고른 값은 명령의 value 로 간다(docs/spec/settings.md 의 Controls).
    const pick = moved.controls.find((c) => c.key === "mode");
    assert.ok(pick?.command, "the appearance control must name its command");
    assert.ok(pick.options.includes(other), `the mode select box does not offer ${other}`);
    await s.run(pick.command.name, { ...pick.command.params, value: other });
    await s.until("core.settings", (value) => value.values.mode === other && !value.saving, "the control command did not change the mode");

    await s.run("core.settings.close");
    await s.until("core.settings-modal", (modal) => !modal.open, "settings did not close");
  });

  test(`${app.name}: native clicks reach every chrome icon at wide window sizes`, { timeout: 180000 }, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    const initialWindow = await s.get("host.window");
    const initialSettings = await s.get("core.settings");
    s.cleanup(async () => {
      for (const key of ["left", "right", "mode"]) {
        if (initialSettings.overridden.includes(key)) {
          await s.run("core.settings.set", { patch: { [key]: initialSettings.values[key] }, scope: "project" });
        } else {
          await s.run("core.settings.reset", { key });
        }
      }
      await s.run("host.window.maximize", { on: false });
      await s.run("host.window.resize", { width: initialWindow.content.width, height: initialWindow.content.height });
    });
    let captureActive = false;
    s.cleanup(async () => {
      if (!captureActive) return;
      const stopped = await s.request("diagnostics.capture.stop", { after: 0 });
      captureActive = false;
      rmSync(stopped.frames, { recursive: true, force: true });
      if (stopped.limited) throw new Error("the aborted chrome width capture reached its frame limit");
    });

    const clickChrome = async (name) => {
      const geometry = await s.get("host.window");
      const main = geometry.webviews.find((webview) => webview.main);
      assert.ok(main, `host.window did not report the main WebView before ${name}: ${JSON.stringify(geometry.webviews)}`);
      const rect = await s.rect(name);
      assert.ok(rect.width > 0 && rect.height > 0, `${name} has no visible hit rectangle: ${JSON.stringify(rect)}`);
      const point = {
        x: (rect.document?.x ?? 0) + rect.x + rect.width / 2,
        y: (rect.document?.y ?? 0) + rect.y + rect.height / 2,
      };
      const owner = await s.run("host.hit", point);
      // hit testing이 다른 소유자를 보고해도 native 클릭을 보낸다. 쓸모 있는 Red를 위해
      // hit 결과와 명령의 효과를 따로 기록한다.
      await s.click(point.x, point.y);
      const inMainWebview = point.x >= main.frame.x && point.x < main.frame.x + main.frame.width &&
        point.y >= main.frame.y && point.y < main.frame.y + main.frame.height;
      const hitFrame = owner.kind === "native" ? owner.view?.frame : null;
      const hitViewContains = owner.kind !== "native" || Boolean(hitFrame && point.x >= hitFrame.x &&
        point.x < hitFrame.x + hitFrame.width && point.y >= hitFrame.y && point.y < hitFrame.y + hitFrame.height);
      return { name, point, owner, mainFrame: main.frame, inMainWebview, hitViewContains,
        active: geometry.active, key: geometry.key };
    };

    // 사용 가능한 화면 폭의 절반부터 보이는 frame 안에 들어가는 가장 큰 content 폭까지
    // 측정한다. 단계는 point 단위이므로 backing scale과 무관하며, 보고된 2048 physical-pixel
    // viewport를 포함한다.
    const center = {
      x: initialWindow.frame.x + initialWindow.frame.width / 2,
      y: initialWindow.frame.y + initialWindow.frame.height / 2,
    };
    const screen = (await s.get("host.screens")).find((item) => center.x >= item.x && center.x < item.x + item.width &&
      center.y >= item.y && center.y < item.y + item.height);
    assert.ok(screen, `the initial window center ${JSON.stringify(center)} is outside every screen`);
    // `fresh` 는 Tauri 창을 시작 너비에서 오른쪽에 둔다. 폭을 키울 때 전체 검사가 화면 안에 남도록 왼쪽으로 옮긴다.
    // 그렇지 않으면 넓은 표본의 단추 좌표가 화면 밖으로 나가 보이는 창의 동작을 측정하지 못한다.
    await s.run("host.window.move", { x: screen.visible.x, y: screen.visible.y });
    await s.until("host.window", (window) => window.frame.x === screen.visible.x && window.frame.y === screen.visible.y,
      "the width sweep window did not move to the visible screen origin");
    const maxWidth = Math.floor(screen.visible.width - (initialWindow.frame.width - initialWindow.content.width));
    const minWidth = Math.ceil(maxWidth / 2);
    const widths = Array.from({ length: 17 }, (_, index) =>
      Math.round(minWidth + (maxWidth - minWidth) * index / 16));
    const reportWidth = Math.round(2048 / initialWindow.scale);
    if (reportWidth >= minWidth && reportWidth <= maxWidth) widths.push(reportWidth);
    widths.sort((left, right) => left - right);
    const samples = [...new Set(widths)];
    const failures = [];
    const measurements = [];
    const waitForStatus = async (name, predicate, message) => {
      try {
        return { value: await s.until(name, predicate, message, { timeout: 1500 }) };
      } catch (error) {
        if (error.code !== "ETIMEDOUT") throw error;
        return { error: error.message };
      }
    };
    const restoreSetting = async (key) => {
      if (initialSettings.overridden.includes(key)) {
        await s.run("core.settings.set", { patch: { [key]: initialSettings.values[key] }, scope: "project" });
      } else {
        await s.run("core.settings.reset", { key });
      }
      await s.until("core.settings", (settings) => settings.values[key] === initialSettings.values[key] &&
        settings.overridden.includes(key) === initialSettings.overridden.includes(key),
      `${key} setting did not return to its initial value and scope`);
      await s.presented();
    };
    for (const width of samples) {
      let capture = null;
      if (width === maxWidth) {
        try {
          capture = await s.request("diagnostics.capture.start", {});
        } catch (error) {
          failures.push({ width, name: "diagnostics.capture.start", error: error.message });
          t.diagnostic(`recording start failed at ${width}: ${error.message}`);
        }
      }
      captureActive = Boolean(capture);
      await s.run("host.window.resize", { width, height: initialWindow.content.height });
      const resized = await s.until("host.window", (window) => window.content.width === width,
        `the window did not reach test width ${width}`);
      for (const key of ["left", "right", "mode"]) await restoreSetting(key);
      await s.presented();
      const geometry = await s.get("host.window");
      assert.ok(geometry.frame.x >= screen.visible.x && geometry.frame.x + geometry.frame.width <= screen.visible.x + screen.visible.width,
        `the window frame is outside the visible screen at ${width}: ${JSON.stringify(geometry.frame)}, screen ${JSON.stringify(screen.visible)}`);
      const main = geometry.webviews.find((webview) => webview.main);
      assert.ok(main, `host.window did not report a main WebView at ${width}: ${JSON.stringify(geometry.webviews)}`);
      t.diagnostic(`measured chrome viewport ${JSON.stringify({ requested: width, content: resized.content.width,
        scale: resized.scale, active: geometry.active, key: geometry.key, mainWebview: main.frame,
        surfaces: geometry.surfaces.filter((surface) => surface.visible) })}`);

      const outcomes = [];
      const projectBefore = (await s.get("core.screen")).screen;
      const projects = await clickChrome("core.chrome.projects");
      if (capture) {
        const { displayed } = await s.presented();
        const stopped = await s.request("diagnostics.capture.stop", { after: displayed });
        captureActive = false;
        s.cleanup(() => rmSync(stopped.frames, { recursive: true, force: true }));
        assert.equal(stopped.limited, false, `the complete resize-and-project-click recording reached its frame limit at ${width}`);
        assert.ok(stopped.count > 0, `the resize-and-project-click recording has no frames at ${width}`);
        assert.ok(stopped.longestGap <= 100, `the resize-and-project-click recording has a ${stopped.longestGap}ms frame gap at ${width}`);
        t.diagnostic(`complete resize-and-project-click recording ${JSON.stringify({ width, count: stopped.count,
          longestGap: stopped.longestGap, frames: stopped.frames })}`);
      }
      projects.before = projectBefore;
      const projectResult = projects.owner.kind === "page"
        ? await waitForStatus("core.screen", (value) => value.screen === "library", `projects icon did not open the library at ${width}`)
        : {};
      projects.after = (await s.get("core.screen")).screen;
      projects.effect = projects.after === "library";
      if (projectResult.error) {
        projects.waitError = projectResult.error;
        // 페이지가 받은 pointer 순서. 누른 요소가 뗄 때 교체되었으면 click 이 없다.
        projects.pointer = await s.get("core.pointer");
      }
      outcomes.push(projects);
      if (projects.effect) {
        await s.run("core.library.return");
        await s.until("core.screen", (value) => value.screen === "workspace", `workspace did not return at ${width}`);
        await s.presented();
      }

      for (const key of ["left", "right"]) {
        const before = initialSettings.values[key];
        const click = await clickChrome(`core.chrome.${key}`);
        const result = click.owner.kind === "page"
          ? await waitForStatus("core.settings", (settings) => settings.values[key] !== before,
            `${key} sidebar icon did not change the setting at ${width}`)
          : {};
        const after = (await s.get("core.settings")).values[key];
        outcomes.push({ ...click, before, after, effect: after !== before, waitError: result.error });
        await restoreSetting(key);
      }

      const mode = initialSettings.values.mode;
      const modeClick = await clickChrome("core.chrome.mode");
      const nextMode = mode === "dark" ? "light" : "dark";
      const modeResult = modeClick.owner.kind === "page"
        ? await waitForStatus("core.settings", (settings) => settings.values.mode === nextMode,
          `theme icon did not change the mode at ${width}`)
        : {};
      const observedMode = (await s.get("core.settings")).values.mode;
      outcomes.push({ ...modeClick, before: mode, after: observedMode, effect: observedMode !== mode,
        waitError: modeResult.error });
      await restoreSetting("mode");

      const settingsClick = await clickChrome("core.chrome.settings");
      const settingsResult = settingsClick.owner.kind === "page"
        ? await waitForStatus("core.settings-modal", (modal) => modal.open, `settings icon did not open settings at ${width}`)
        : {};
      const settingsOpen = (await s.get("core.settings-modal")).open;
      outcomes.push({ ...settingsClick, effect: settingsOpen });
      if (settingsResult.error) outcomes.at(-1).waitError = settingsResult.error;
      if (settingsOpen) {
        await s.run("core.settings.close");
        await s.until("core.settings-modal", (modal) => !modal.open, `settings did not close at ${width}`);
      }

      const failed = outcomes.filter(({ owner, effect, inMainWebview, hitViewContains }) =>
        owner.kind !== "page" || !effect || !inMainWebview || !hitViewContains);
      t.diagnostic(`chrome click outcomes ${JSON.stringify({ width, outcomes, mainWebview: main.frame })}`);
      failures.push(...failed.map((outcome) => ({ width, ...outcome })));
      const finalGeometry = await s.get("host.window");
      measurements.push({ width, active: geometry.active, key: geometry.key,
        finalActive: finalGeometry.active, finalKey: finalGeometry.key, outcomes });
    }
    assert.deepEqual(failures, [], `chrome controls failed across the width sweep: ${JSON.stringify(measurements)}`);
    assert.ok(measurements.every(({ active, key, finalActive, finalKey }) =>
      !active && !key && !finalActive && !finalKey),
    `the width sweep activated or keyed the tested application: ${JSON.stringify(measurements.map(({ width, active, key, finalActive, finalKey }) => ({ width, active, key, finalActive, finalKey })))}`);
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
