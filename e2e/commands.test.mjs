// Runs the UI operation commands and checks their results through status.
//
// The controls that a person presses run the same commands (docs/spec/exposure.md), so when the result of a command
// appears in status, the result of the control is the same.
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, open, recordingSummary } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";

/** The card with the card id. */
const cardOf = (grid, id) => grid?.cards.find((c) => c.id === id);

/** A card that has a tab id. */
const holder = (grid, tab) => grid?.cards.find((c) => c.tabs.some((t) => t.tab === tab));

/** A card that can be operated (a card with tool buttons). Sidebar and rail places are excluded. */
const panes = (grid) => grid.cards.filter((c) => c.pane !== null);

const ids = (grid) => panes(grid).map((c) => c.id).sort();

/** The plugin of the tabs that the checks add: the second layout probe, apart from the layout probe of the start tabs. */
const ADDED = "layoutprobe2";

/** The card of the start tab `surface` and the other card of the start layout that holds tabs, as card ids. */
function startCards(grid, surface) {
  const own = holder(grid, surface)?.id;
  const other = panes(grid).find((c) => c.id !== own && c.tabs.length > 0)?.id;
  return { own, other };
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: card, tab, and menu commands change the grid`, async (t) => {
    const s = await open(t, app);
    const { surface } = await fresh(s);
    const start = await s.get("core.grid");
    const { own, other } = startCards(start, surface);
    const first = cardOf(start, own);
    const second = cardOf(start, other);
    assert.ok(first && second, `the start layout must have two cards with tabs: ${ids(start)}`);
    assert.equal(first.acts.add.enabled, true, "the start card must be able to add a tab");

    await s.run("core.card.focus", { card: other });
    await s.until("core.grid", (grid) => cardOf(grid, other).focused, "core.card.focus did not focus the card");

    // Opens and closes the add menu, then opens it again and chooses an item.
    await s.run("core.card.menu", { card: own, menu: "add" });
    const menu = await s.until("core.picker", (picker) => picker.open && picker.items.length > 0,
      "core.card.menu did not open the add menu");
    await s.until("core.modal", (modal) => modal?.id === "picker", "the add menu did not show its modal");
    await s.run("core.picker.close");
    await s.until("core.picker", (picker) => !picker.open, "core.picker.close did not close the menu");
    const addedItem = menu.items.findIndex((item) => item.key === ADDED);
    assert.ok(addedItem >= 0, `the add menu must list ${ADDED}: ${JSON.stringify(menu.items)}`);
    await s.run("core.card.menu", { card: own, menu: "add" });
    await s.until("core.picker", (picker) => picker.open, "the add menu did not open again");
    await s.run("core.picker.pick", { index: addedItem });
    const picked = await s.until("core.grid", (grid) => cardOf(grid, own).tabs.length === first.tabs.length + 1,
      "core.picker.pick did not add a tab");
    assert.equal((await s.get("core.picker")).open, false, "picking must close the menu");
    const added = cardOf(picked, own);
    assert.equal(added.tabs.at(-1).plugin, ADDED);
    assert.equal(added.active, added.tabs.at(-1).tab, "the added tab must be active");

    await s.run("core.tab.select", { tab: first.tabs[0].tab });
    await s.until("core.grid", (grid) => cardOf(grid, own).active === first.tabs[0].tab,
      "core.tab.select did not activate the tab");
    await s.run("core.tab.close", { tab: added.tabs.at(-1).tab });
    await s.until("core.grid", (grid) => cardOf(grid, own).tabs.length === first.tabs.length,
      "core.tab.close did not close the tab");

    // Moves the tab to the center of another card, and then to the next side.
    const { tab } = await s.run("core.card.add-tab", { card: own, plugin: ADDED });
    await s.until("core.grid", (grid) => holder(grid, tab)?.id === own, "core.card.add-tab did not add the tab");
    await s.run("core.tab.move", { tab, card: other, zone: "centre" });
    await s.until("core.grid", (grid) => holder(grid, tab)?.id === other, "core.tab.move did not move the tab to the centre");
    await s.run("core.tab.move", { tab, card: other, zone: "right" });
    const split = await s.until("core.grid", (grid) => panes(grid).length === panes(start).length + 1,
      "core.tab.move did not make a card on the right");
    const made = holder(split, tab);
    assert.ok(made && !start.cards.some((c) => c.id === made.id), "the moved tab must be in a new card");
    assert.ok(made.x > cardOf(split, other).x, "the new card must be right of the card it was moved beside");
    assert.equal((await s.get("core.drag")), null, "no drag must remain after a command move");
    await s.run("core.card.close", { card: made.id });
    await s.until("core.grid", (grid) => panes(grid).length === panes(start).length, "core.card.close did not close the card");

    // A split puts the new card on the given side. For left and top the new card is before the original card, and for right and bottom it is after.
    const beside = {
      left: (born, base) => born.x + born.w <= base.x, right: (born, base) => born.x >= base.x + base.w,
      top: (born, base) => born.y + born.h <= base.y, bottom: (born, base) => born.y >= base.y + base.h,
    };
    for (const side of ["left", "right", "top", "bottom"]) {
      const result = await s.run("core.card.split", { card: own, side, plugin: ADDED });
      const split = await s.until("core.grid", (grid) => cardOf(grid, result.card) !== undefined, `core.card.split ${side} did not add a card`);
      const born = cardOf(split, result.card);
      assert.equal(born.tabs[0].plugin, ADDED);
      assert.ok(beside[side](born, cardOf(split, own)), `the ${side} split put the new card at ${JSON.stringify(born)}`);
      await s.run("core.card.close", { card: result.card });
      await s.until("core.grid", (grid) => ids(grid).join() === ids(start).join(), `closing the ${side} split did not restore the layout`);
    }
    await assert.rejects(s.run("core.card.split", { card: own, axis: "x", plugin: ADDED }), /command core.card.split: unknown parameter axis/);

    await s.run("core.card.tab-list", { card: own });
    const list = await s.until("core.picker", (picker) => picker.open, "core.card.tab-list did not open the tab list");
    assert.equal(list.items.length, first.tabs.length);
    await s.run("core.picker.close");
    await s.until("core.picker", (picker) => !picker.open, "the tab list did not close");

    const again = await s.run("core.card.split", { card: own, side: "bottom", plugin: ADDED });
    await s.until("core.grid", (grid) => panes(grid).length === panes(start).length + 1, "the second split did not add a card");
    await s.run("core.card.close", { card: again.card });
    await s.until("core.grid", (grid) => ids(grid).join() === ids(start).join(), "closing the second split did not restore the layout");
  });

  test(`${app.name}: settings tab commands change its page, scope, and mode`, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    await s.run("core.settings.open");
    await s.until("core.settings-tab", (tab) => tab !== null, "settings did not open");
    for (const page of ["sets", "installed", "look"]) {
      await s.run("core.settings-tab.nav", { page });
      await s.until("core.settings-tab", (tab) => tab?.page === page, `settings did not show ${page}`);
    }
    await s.run("core.settings-tab.scope", { scope: "project" });
    const project = await s.until("core.settings-tab", (tab) => tab?.scope === "project", "settings did not select project scope");
    const tab = project.controls.find((c) => c.name === "core.settings-tab.scope" && c.command?.params?.scope === "project");
    assert.equal(tab?.on, true, "the project scope button must be selected");
    assert.deepEqual(tab.command, { name: "core.settings-tab.scope", params: { scope: "project" } });
    await s.run("core.settings-tab.scope", { scope: "common" });
    await s.until("core.settings-tab", (value) => value.scope === "common", "settings did not select common scope");

    const mode = (await s.get("core.settings")).values.mode;
    const other = mode === "dark" ? "light" : "dark";
    // The mode is a choice of segments: each segment names core.settings.change with the value it sets (Controls in docs/spec/settings.md).
    const { controls } = await s.get("core.settings-tab");
    const pick = controls.find((c) => c.name === "core.settings-tab.choice" && c.key === "mode" && c.command?.params?.value === other);
    assert.ok(pick?.command, `the mode choice must offer ${other} with its command`);
    await s.run(pick.command.name, pick.command.params);
    await s.until("core.settings", (value) => value.values.mode === other && !value.saving, "the control command did not change the mode");

    await s.run("core.settings.close");
    await s.until("core.settings-tab", (tab) => tab === null, "settings did not close");
  });

  test(`${app.name}: native clicks reach every chrome icon at wide window sizes`, { timeout: 180000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    const initialWindow = await s.get("host.window");
    const initialSettings = await s.get("core.settings");
    // A chrome switch writes the scope that the applied value comes from (docs/spec/settings.md#scope-of-a-control):
    // the common scope for a key that the project does not override. So the restore writes the initial common value
    // back to the common scope, and the initial project value back to the project scope or removes the project value.
    const writeInitial = async (key) => {
      await s.run("core.settings.set", { patch: { [key]: initialSettings.common[key] }, scope: "common" });
      if (initialSettings.overridden.includes(key)) {
        await s.run("core.settings.set", { patch: { [key]: initialSettings.values[key] }, scope: "project" });
      } else {
        await s.run("core.settings.reset", { key });
      }
    };
    s.cleanupSteps(
      async () => {
        for (const key of ["left", "right", "mode"]) await writeInitial(key);
      },
      async () => {
        await s.run("host.window.maximize", { on: false });
        await s.run("host.window.resize", { width: initialWindow.content.width, height: initialWindow.content.height });
      },
    );

    const chromeViewport = async (geometry) => {
      const workbench = await s.get("core.window.workbench");
      assert.deepEqual([workbench.width, workbench.height, workbench.scale],
        [geometry.content.width, geometry.content.height, geometry.scale],
        "the workbench must fill the native content at its backing scale");
      const viewport = { x: 0, y: 0, width: workbench.width, height: workbench.height };
      const main = geometry.webviews.find((webview) => webview.main);
      if (app.name === "mygo") {
        assert.equal(main, undefined, "the native workbench has no main WebView");
      } else {
        assert.ok(main, "the page workbench must have a main WebView");
        assert.deepEqual(main.frame, viewport, "the main WebView must fill the workbench viewport");
      }
      return viewport;
    };

    const clickChrome = async (name) => {
      const geometry = await s.get("host.window");
      const viewport = await chromeViewport(geometry);
      const rect = await s.rect(name);
      assert.ok(rect.width > 0 && rect.height > 0, `${name} has no visible hit rectangle: ${JSON.stringify(rect)}`);
      const point = {
        x: (rect.document?.x ?? 0) + rect.x + rect.width / 2,
        y: (rect.document?.y ?? 0) + rect.y + rect.height / 2,
      };
      const owner = await s.run("host.hit", point);
      // Sends the native click even when hit testing reports another owner. For a useful Red,
      // the hit result and the effect of the command are recorded separately.
      await s.click(point.x, point.y);
      const inWorkbench = point.x >= viewport.x && point.x < viewport.x + viewport.width &&
        point.y >= viewport.y && point.y < viewport.y + viewport.height;
      const hitFrame = owner.kind === "native" ? owner.view?.frame : null;
      const hitViewContains = owner.kind !== "native" || Boolean(hitFrame && point.x >= hitFrame.x &&
        point.x < hitFrame.x + hitFrame.width && point.y >= hitFrame.y && point.y < hitFrame.y + hitFrame.height);
      return { name, point, owner, workbenchFrame: viewport, inWorkbench, hitViewContains,
        active: geometry.active, key: geometry.key };
    };

    // Measures from half of the usable screen width up to the largest content width that fits in the visible frame.
    // The steps are in points, so they do not depend on the backing scale, and they include the reported 2048 physical-pixel
    // viewport.
    const center = {
      x: initialWindow.frame.x + initialWindow.frame.width / 2,
      y: initialWindow.frame.y + initialWindow.frame.height / 2,
    };
    const screen = (await s.get("host.screens")).find((item) => center.x >= item.x && center.x < item.x + item.width &&
      center.y >= item.y && center.y < item.y + item.height);
    assert.ok(screen, `the initial window center ${JSON.stringify(center)} is outside every screen`);
    // `fresh` places the Tauri window on the right at the start width. When the width grows, the window is moved to the left so that the whole check stays on the screen.
    // Otherwise the button coordinates of a wide sample go off the screen and the behavior of the visible window is not measured.
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
    // A click that the workbench owns runs the command of its button, and the change of the status is the effect of that command.
    // The command can end after the next presented frame: core.settings.open loads the settings screen at its first run, and
    // core.projects.browse waits for the projects before it shows the project home. So the judgement waits for the change of the
    // status, which the command makes, and has no time limit of its own: a click without effect holds the check until the limit
    // of the test, whose output names the step of the click.
    const clickEffect = (owner, name, predicate, message) => owner.kind === "workbench" ? s.until(name, predicate, message) : undefined;
    const restoreSetting = async (key) => {
      await writeInitial(key);
      await s.until("core.settings", (settings) => settings.values[key] === initialSettings.values[key] &&
        settings.common[key] === initialSettings.common[key] &&
        settings.overridden.includes(key) === initialSettings.overridden.includes(key),
      `${key} setting did not return to its initial value and scope`);
      await s.presented();
    };
    for (const width of samples) {
      let capture = null;
      if (width === maxWidth) {
        // The session stops a recording that the check did not stop and keeps it with a failed check; a recording that does not
        // start is told, and the check does not fail on it (Session.record).
        capture = await s.record();
      }
      await s.run("host.window.resize", { width, height: initialWindow.content.height });
      const resized = await s.until("host.window", (window) => window.content.width === width,
        `the window did not reach test width ${width}`);
      for (const key of ["left", "right", "mode"]) await restoreSetting(key);
      await s.presented();
      const geometry = await s.get("host.window");
      assert.ok(geometry.frame.x >= screen.visible.x && geometry.frame.x + geometry.frame.width <= screen.visible.x + screen.visible.width,
        `the window frame is outside the visible screen at ${width}: ${JSON.stringify(geometry.frame)}, screen ${JSON.stringify(screen.visible)}`);
      const viewport = await chromeViewport(geometry);
      t.diagnostic(`measured chrome viewport ${JSON.stringify({ requested: width, content: resized.content.width,
        scale: resized.scale, active: geometry.active, key: geometry.key, workbench: viewport,
        surfaces: geometry.surfaces.filter((surface) => surface.visible) })}`);

      const outcomes = [];
      const projectBefore = (await s.get("core.screen")).screen;
      const projects = await clickChrome("core.chrome.projects");
      if (capture) {
        const { displayed } = await s.presented();
        const stopped = await capture.stop({ after: displayed });
        // The clicks and their effects below judge the controls at this width; the recording is their evidence.
        t.diagnostic(`resize-and-project-click at ${width}: ${recordingSummary(stopped)}`);
      }
      projects.before = projectBefore;
      await clickEffect(projects.owner, "core.screen", (value) => value.screen !== "workspace", `projects icon did not open the project home at ${width}`);
      projects.after = (await s.get("core.screen")).screen;
      projects.effect = projects.after !== "workspace";
      outcomes.push(projects);
      if (projects.effect) {
        await s.run("core.home.open", { project: (await s.get("core.project")).id });
        await s.until("core.screen", (value) => value.screen === "workspace", `workspace did not return at ${width}`);
        await s.presented();
      }

      for (const key of ["left", "right"]) {
        const before = initialSettings.values[key];
        const click = await clickChrome(`core.chrome.${key}`);
        await clickEffect(click.owner, "core.settings", (settings) => settings.values[key] !== before,
          `${key} sidebar icon did not change the setting at ${width}`);
        const after = (await s.get("core.settings")).values[key];
        outcomes.push({ ...click, before, after, effect: after !== before });
        await restoreSetting(key);
      }

      const settingsClick = await clickChrome("core.chrome.settings");
      await clickEffect(settingsClick.owner, "core.settings-tab", (tab) => tab !== null, `settings icon did not open settings at ${width}`);
      const settingsOpen = (await s.get("core.settings-tab")) !== null;
      outcomes.push({ ...settingsClick, effect: settingsOpen });
      if (settingsOpen) {
        await s.run("core.settings.close");
        await s.until("core.settings-tab", (tab) => tab === null, `settings did not close at ${width}`);
      }

      const failed = outcomes.filter(({ owner, effect, inWorkbench, hitViewContains }) =>
        owner.kind !== "workbench" || !effect || !inWorkbench || !hitViewContains);
      t.diagnostic(`chrome click outcomes ${JSON.stringify({ width, outcomes, workbench: viewport })}`);
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

  test(`${app.name}: project home commands search, pin, and edit the form`, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    const project = await s.get("core.project");
    await s.run("core.projects.browse");
    await s.until("core.home", (home) => home.rows.includes(project.id), "the project home did not list the project");

    await s.run("core.focus.set", { name: "core.home.search" });
    await s.until("core.focus", (focus) => focus?.name === "core.home.search", "core.focus.set did not focus search");
    await s.run("core.home.search", { query: "no such project" });
    await s.until("core.home", (home) => home.rows.length === 0, "core.home.search did not filter the project home");
    await s.run("core.home.search", { query: "" });
    await s.until("core.home", (home) => home.rows.includes(project.id), "clearing search did not restore the list");

    const pinned = (await s.get("core.projects")).find((item) => item.id === project.id).pinned;
    await s.run("core.home.pin", { project: project.id });
    await s.until("core.projects", (projects) => projects.find((item) => item.id === project.id).pinned === !pinned,
      "core.home.pin did not change the pin of the project");
    await s.run("core.home.pin", { project: project.id });
    await s.until("core.projects", (projects) => projects.find((item) => item.id === project.id).pinned === pinned,
      "core.home.pin did not restore the pin of the project");

    await s.run("core.home.form.open", { mode: "create" });
    await s.rect("core.home.form.name");
    await s.run("core.home.form.set", { field: "name", value: "draft" });
    await s.run("core.home.form.cancel");
    await assert.rejects(s.rect("core.home.form.name"), /core\.home\.form\.name/, "core.home.form.cancel did not close the form");

    await s.run("core.home.open", { project: project.id });
    await s.until("core.screen", (screen) => screen.screen === "workspace", "core.home.open did not return to the workspace");
  });

  test(`${app.name}: layout commands return after the new layout is drawn`, async (t) => {
    const s = await open(t, app);
    const { surface } = await fresh(s);
    /** The widths of the card elements drawn in the document. */
    const drawnWidths = async () => {
      const widths = [];
      for (let index = 0; ; index++) {
        const rect = await s.rect("core.card", index).catch(() => null);
        if (!rect) return widths;
        widths.push(rect.width);
      }
    };
    const start = await s.get("core.grid");
    const { other } = startCards(start, surface);
    const shown = cardOf(start, other);
    await s.run("core.boundary.move", { axis: "x", line: 2, position: start.lines.x[2] - 60 });
    const moved = cardOf(await s.get("core.grid"), other);
    assert.notEqual(moved.w, shown.w, "the boundary move did not change the card");
    const afterMove = await drawnWidths();
    assert.ok(afterMove.includes(moved.w) && !afterMove.includes(shown.w),
      `core.boundary.move returned before the card was drawn at ${moved.w}: ${afterMove}`);

    await s.run("core.grid.size", { card: "right", axis: "x", size: cardOf(await s.get("core.grid"), "right").w + 40 });
    const sized = cardOf(await s.get("core.grid"), "right");
    const afterSize = await drawnWidths();
    assert.ok(afterSize.includes(sized.w),
      `core.grid.size returned before the card was drawn at ${sized.w}: ${afterSize}`);
  });

  test(`${app.name}: rename commands edit and cancel a space title`, async (t) => {
    const s = await open(t, app);
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
