// Checks the plugin overrides of the fixed left and right sidebars and the combined border with real host records. The layout probe
// has a window-right override and the second layout probe has none, so a tab of each shows the override and the general choice.
import assert from "node:assert/strict";
import test from "node:test";
import { rmSync } from "node:fs";
import { APPS, MAIN_PAGE_APPS, keepCommonSettings, open, recordingSummary } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";
import { turnOffCardSidebars } from "./card-sidebar-choices.mjs";
/** The plugin without a window sidebar override. */
const PLAIN = "layoutprobe2";

/**
 * Stores two list sets of layout probe sections and links one as the general left choice and the other as the window-right override
 * of `plugin`; keepCommonSettings restores the sets and the links when the check ends.
 */
async function probeLinks(s, plugin) {
  await keepCommonSettings(s);
  const sets = (await s.get("core.settings")).values.sets;
  const left = { id: "check-left", title: "Left", sections: ["layoutprobe.beta", "layoutprobe.follow"], layout: "list" };
  const right = { id: "check-right", title: "Right", sections: ["layoutprobe.alpha", "layoutprobe.fill"], layout: "list" };
  await s.run("core.settings.set", { patch: { sets: [...sets, left, right] }, scope: "common" });
  await s.run("core.settings.link", { place: "left", plugin: null, set: left.id, scope: "common" });
  await s.run("core.settings.link", { place: "window-right", plugin, set: right.id, scope: "common" });
}

/** The card of the grid that holds the tab surface. */
const cardOf = (grid, surface) => grid.cards.find((item) => item.tabs?.some((tab) => tab.id === surface)).id;
const geometry = (grid) =>
  grid.cards.map(({ id, x, y, w, h }) => ({ id, x, y, w, h })).sort((a, b) => a.id.localeCompare(b.id));
for (const app of Object.values(APPS))
  test(`${app.name}: fixed sidebars apply plugin overrides without extra columns`, { timeout: 90000 }, async (t) => {
    console.info(`START ${app.name}: fixed sidebar overrides`);
    const s = await open(t, app);
    t.diagnostic(`tested endpoint: ${JSON.stringify(s.client.endpoint)}`);
    const { surface, plugin } = await fresh(s);
    await s.run("core.settings.theme", { name: "midnight", mode: "dark" });
    await probeLinks(s, plugin);
    // Adds a tab of the second layout probe to the start card to put the tab of another plugin in one card.
    const { tab: added } = await s.run("core.card.add-tab", { card: cardOf(await s.get("core.grid"), surface), plugin: PLAIN });
    s.cleanup(() => s.run("core.tab.close", { tab: added }));
    const initial = await s.get("core.grid");
    const target = initial.cards.find((card) => new Set(card.tabs.map((tab) => tab.plugin)).size > 1);
    assert.ok(target, "different-plugin tabs are required");
    await turnOffCardSidebars(s, target.id);
    await s.presented();
    const baseline = await s.get("core.grid");
    const windows = baseline.cards.filter((card) => card.tabs.length === 0);
    assert.deepEqual(
      windows.map((card) => card.id).sort(),
      ["left", "right"],
      "only fixed left/right sidebars may exist",
    );
    for (const card of windows) assert.equal(card.h, baseline.height, "a window sidebar does not span the work area");
    const settings = (await s.get("core.settings")).values;
    const observations = [];
    async function measure(card, tab) {
      const grid = await s.get("core.grid");
      assert.deepEqual(geometry(grid), geometry(baseline), "selection changed fixed sidebar or content geometry");
      const rail = await s.get("core.rail");
      // A section view that the selection mounts reports ready after the selection settles.
      const bars = (await s.until("core.sidebars", (all) => all.every((bar) => bar.placement !== "window"
        || bar.sections.filter((section) => section.mounted).every((section) => section.phase === "ready")),
      "selected sidebar section views are not ready")).filter((bar) => bar.placement === "window");
      const overrides = settings.links.filter((link) => link.place.startsWith("window-") && link.plugin === tab.plugin);
      assert.equal(
        rail.groups.length,
        overrides.length ? 1 : 0,
        "rail exists without an applied override or is missing",
      );
      if (overrides.length) {
        assert.equal(rail.groups[0].card, card.id);
        assert.deepEqual(rail.groups[0].sidebars.slice().sort(), overrides.map((link) => link.place.slice(7)).sort());
      }
      for (const side of ["left", "right"]) {
        const override = overrides.find((link) => link.place === `window-${side}`);
        const selected = override ?? settings.links.find((link) => link.place === side && link.plugin === null);
        const bar = bars.find((item) => item.sidebar === side);
        if (!selected) {
          assert.equal(bar, undefined, "an inactive plugin output remains displayed");
          continue;
        }
        assert.ok(bar, `${side} selected sidebar is missing`);
        assert.equal(bar.set, selected.set);
        assert.equal(bar.plugin, override ? tab.plugin : null);
        assert.equal(bar.card, override ? card.id : null);
        assert.equal(bar.surface, override ? tab.id : null);
        const set = settings.sets.find((set) => set.id === selected.set);
        assert.equal(bar.layout, set.layout);
        assert.deepEqual(
          bar.sections.map((section) => section.id),
          set.sections,
        );
        assert.ok(
          bar.sections.every((section) => section.error === null),
          "selected section has an error",
        );
      }
      assert.deepEqual(
        (await s.get("core.verify")).rows.filter((row) => !row.ok),
        [],
      );
      assert.deepEqual((await s.get("core.workbench.audit")).unbound, []);
      return { grid, rail, plugin: tab.plugin, card: card.id };
    }
    const recording = await s.record();
    let displayed = 0,
      stop;
    try {
      try {
        for (const card of baseline.cards.filter((card) => card.tabs.length))
          for (const tab of card.tabs) {
            await s.run("core.tab.select", { tab: tab.id });
            await s.until(
              "core.grid",
              (grid) =>
                grid.cards.find((item) => item.id === card.id)?.active === tab.id &&
                grid.cards.find((item) => item.id === card.id)?.focused === true,
              "tab selection did not settle",
            );
            ({ displayed } = await s.presented());
            observations.push({ ...(await measure(card, tab)), displayed });
          }
      } finally {
        stop = await recording.stop({ after: displayed ? displayed + 100 : 0 });
      }
      assert.ok(
        observations.some((item) => item.plugin === PLAIN && item.rail.groups.length === 0),
        `${PLAIN} selection did not remove plugin rail`,
      );
      assert.ok(
        observations.some((item) => item.plugin === plugin && item.rail.groups.length === 1),
        `${plugin} override was not measured`,
      );
      t.diagnostic(
        `fixed windows=${windows.map((card) => card.id)}; selections=${observations.map((item) => `${item.plugin}:${item.rail.groups.length}`)}; ${recordingSummary(stop)}`,
      );
    } finally {
      if (recording.frames) rmSync(recording.frames, { recursive: true, force: true });
    }
  });

// Even when a tab is moved or closed, the fixed sidebar sets its context from the active tab of the focused card and does not move its own column.
for (const app of Object.values(APPS))
  test(
    `${app.name}: fixed sidebar context follows tab moves and removal without moving its column`,
    { timeout: 60000 },
    async (t) => {
      const s = await open(t, app);
      const { surface, plugin } = await fresh(s);
      await probeLinks(s, plugin);
      const links = (await s.get("core.settings")).values.links;
      const columns = async () =>
        (await s.get("core.grid")).cards
          .filter((card) => card.tabs.length === 0)
          .map(({ id, x, w }) => ({ id, x, w }))
          .sort((a, b) => a.id.localeCompare(b.id));
      const baseline = await columns();
      async function expectContext(label) {
        await s.presented();
        const grid = await s.get("core.grid");
        const focused = grid.cards.find((card) => card.focused);
        assert.ok(focused, `${label}: no focused card`);
        const tab = focused.tabs.find((item) => item.id === focused.active);
        for (const side of ["left", "right"]) {
          const override = links.find((link) => link.place === `window-${side}` && link.plugin === tab.plugin);
          const general = links.find((link) => link.place === side && link.plugin === null);
          if (!override && !general) continue;
          const bar = await s.until(
            "core.sidebars",
            (bars) => {
              const found = bars.find((item) => item.sidebar === side);
              return (
                found !== undefined &&
                found.plugin === (override ? tab.plugin : null) &&
                found.card === (override ? focused.id : null) &&
                found.surface === (override ? tab.id : null) &&
                (found.layout !== "tabs" ||
                  found.sections.some((section) => section.id === found.tab && section.mounted))
              );
            },
            `${label}: ${side} sidebar context did not follow ${focused.id}/${tab.id} (${tab.plugin})`,
          );
          const shown = bar.find((item) => item.sidebar === side);
          assert.equal(shown.set, (override ?? general).set, `${label}: ${side} sidebar shows the wrong set`);
          // The list layout draws all sections, and the tab layout draws only the sections of the chosen tab (docs/spec/plugins.md).
          const drawn =
            shown.layout === "tabs" ? shown.sections.filter((section) => section.id === shown.tab) : shown.sections;
          assert.ok(
            drawn.length > 0 && drawn.every((section) => section.mounted && section.error === null),
            `${label}: ${side} sidebar sections did not mount: ${JSON.stringify(shown.sections)}`,
          );
        }
        assert.deepEqual(await columns(), baseline, `${label}: a tab change moved or resized a fixed sidebar column`);
        t.diagnostic(`${label}: ${focused.id}/${tab.plugin}`);
      }
      // Adds a tab of the second layout probe to the start card. Even when the active tab is moved, the card stays and the tab of
      // another plugin becomes the context.
      const grid = await s.get("core.grid");
      const own = cardOf(grid, surface);
      const other = grid.cards.find((card) => card.id !== own && card.tabs?.length).id;
      const before = grid.cards.find((card) => card.id === own);
      const { tab: kept } = await s.run("core.card.add-tab", { card: own, plugin: PLAIN });
      s.cleanup(() => s.run("core.tab.close", { tab: kept }));
      await s.run("core.tab.select", { tab: before.active });
      await s.run("core.card.focus", { card: own });
      await expectContext("start card focus");
      const start = (await s.get("core.grid")).cards.find((card) => card.id === own);
      const moved = start.tabs.find((item) => item.id === start.active);
      await s.run("core.tab.move", { tab: moved.id, card: other, zone: "centre" });
      await expectContext("tab moved into the other card");
      await s.run("core.card.focus", { card: own });
      await expectContext("start card after the move");
      await s.run("core.tab.close", { tab: moved.id });
      await expectContext("moved tab closed");
      await s.run("core.card.focus", { card: other });
      await expectContext("other card focus");
    },
  );

// The sidebar settings of the section `general` of the settings window (the sections of packages/workbench/settings-ui.js) keep
// the workbench answering (F714-13). Input: the order of the window sidebars or the general sets of the sides change through the
// commands of the settings window. Expected: after each change the workbench answers the next request, core.sidebars shows the
// window sidebars that the switches and the links give, and the window sidebars stand where the order places them.
for (const app of Object.values(APPS))
  test(`${app.name}: the workbench answers after the sidebar settings of the settings window change`, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    const { values, overridden } = await s.get("core.settings");
    // The settings window shows the common scope of a project without overrides; a project value would hide a common change.
    assert.deepEqual(overridden, [], "the fixture project overrides settings");
    const sets = values.sets.map((set) => set.id);
    assert.ok(sets.length >= 2, `two sidebar sets are required, the fixture has ${JSON.stringify(sets)}`);
    const [first, second] = sets;
    const initial = { links: values.links, sidebarOrder: values.sidebarOrder, left: values.left, right: values.right, top: values.top, bottom: values.bottom };
    s.cleanup(() => s.run("core.settings.set", { patch: initial, scope: "common" }));
    const sides = ["left", "right", "top", "bottom"];
    // The window sidebars that the settings give: a side whose switch is on holds a sidebar when a link of the window chooses content
    // for it, and the sidebar shows a set when the general link or the override of the focused plugin chooses one (docs/spec/external-sidebars.md).
    async function answers(label) {
      const settings = (await s.get("core.settings")).values;
      const grid = await s.get("core.grid");
      const focused = grid.cards.find((card) => card.focused);
      const plugin = focused?.tabs.find((tab) => tab.id === focused.active)?.plugin ?? null;
      const held = settings.sidebarOrder.filter((side) => settings[side] && settings.links.some((link) =>
        link.place === side || link.place === `window-${side}`));
      const expected = held.filter((side) => settings.links.some((link) =>
        (link.place === side && link.plugin === null) || (link.place === `window-${side}` && link.plugin === plugin)));
      const bars = await s.until("core.sidebars", (all) => {
        const shown = all.filter((bar) => bar.placement === "window").map((bar) => bar.sidebar).sort();
        return JSON.stringify(shown) === JSON.stringify([...expected].sort());
      }, `${label}: core.sidebars does not show the window sidebars ${JSON.stringify(expected)}`);
      const placed = (await s.until("core.grid", (now) => sides.every((side) => Boolean(now.cards.find((card) => card.id === side)) === held.includes(side)),
        `${label}: the plane does not hold the window sidebars ${JSON.stringify(held)}`)).cards.filter((card) => sides.includes(card.id));
      await s.presented();
      assert.deepEqual((await s.get("core.verify")).rows.filter((row) => !row.ok), [], `${label}: a plane check fails`);
      t.diagnostic(`${label}: sidebars ${bars.filter((bar) => bar.placement === "window").map((bar) => `${bar.sidebar}:${bar.set}`).join(", ")}; cards ${placed.map((card) => card.id).join(", ")}`);
    }
    await answers("fixture");
    // The settings window stays open on its section `general` while the controls change the settings, as a person uses it.
    await s.run("core.settings.open");
    s.cleanup(() => s.run("core.settings.close"));
    const general = await s.until("core.settings-modal", (modal) => modal.open, "settings did not open");
    const nav = general.controls.find((item) => item.name === "core.settings-modal.nav" && item.key === "nav:general");
    await s.run(nav.command.name, nav.command.params);
    await s.until("core.settings-modal", (modal) => modal.section === "general", "settings did not show 일반");
    // Scrolls the settings window with the native wheel until the control stands inside the pane that scrolls, and returns the
    // centre of the control in window coordinates. element.rect of a control of a native modal reports the rectangle of the copy
    // that the person sees, so the scroll of the copy is already in it (docs/spec/exposure.md). The pane lies under the fixed head
    // of the card, and the head covers the content that the scroll clips, so a control under the head takes no press.
    async function reveal(label, name, index) {
      for (;;) {
        await s.presented();
        // element.rect of a control of a native modal answers the report of the modal document, which core.modal holds, so the
        // check waits until that report names the control. A host that draws its modal itself has no modal document and answers
        // element.rect at once.
        if (MAIN_PAGE_APPS.some((candidate) => candidate.name === app.name))
          await s.until("core.modal", (modal) => (modal?.document?.elements ?? []).filter((item) => item.name === name).length > index,
            `${label}: the modal document did not report ${name} ${index}`);
        const rect = await s.rect(name, index);
        const { pane, scroll } = await s.get("core.settings-modal");
        const point = { x: (rect.document?.x ?? 0) + rect.x + rect.width / 2, y: (rect.document?.y ?? 0) + rect.y + rect.height / 2 };
        if (point.y - rect.height / 2 >= pane.y && point.y + rect.height / 2 <= pane.y + pane.h) return point;
        await s.pointer(pane.x + pane.w / 2, pane.y + pane.h / 2, "scroll", { deltaY: point.y - (pane.y + pane.h / 2) });
        await s.until("core.settings-modal", (modal) => modal.scroll !== scroll,
          `${label}: the settings window did not scroll from ${scroll} to ${name} ${index} at ${JSON.stringify(rect)} in the pane ${JSON.stringify(pane)}`);
      }
    }
    // Changes a setting through a control of the settings window: a native click on a button or a switch, as a person presses it,
    // or the command that a select points to with value as its input, because the menu of a select is a native menu outside the
    // document. Then it waits until core.settings holds the change and checks that the workbench answers.
    async function change(label, name, key, value, param, applied) {
      const modal = await s.until("core.settings-modal", (state) => state.controls.some((item) => item.name === name && item.key === key),
        `${label}: the settings control ${name} ${key} did not appear`);
      const found = modal.controls.find((item) => item.name === name && item.key === key);
      assert.ok(found.command, `${label}: ${name} ${key} has no command`);
      let input = `the command ${found.command.name}`;
      if (param === undefined) {
        const point = await reveal(label, name, found.index);
        await s.click(point.x, point.y);
        input = `a click at ${JSON.stringify(point)} on ${name} ${found.index}`;
      } else {
        await s.run(found.command.name, { ...found.command.params, [param]: value });
      }
      await s.until("core.settings", (settings) => applied(settings.values), `${label}: core.settings does not hold the change after ${input}`);
      await answers(label);
    }
    const order = "core.settings-modal.order";
    const select = "core.settings-modal.set";
    const linked = (place, set) => (values) => values.links.some((link) => link.place === place && link.plugin === null && link.set === set);
    const ordered = (list) => (values) => JSON.stringify(values.sidebarOrder) === JSON.stringify(list);
    // The order with top second: ▲ of the row of top in the order left, right, top, bottom.
    await change("order left, top, right, bottom", order, "order:sidebarOrder:2:up", undefined, undefined, ordered(["left", "top", "right", "bottom"]));
    await change("order left, right, top, bottom", order, "order:sidebarOrder:1:down", undefined, undefined, ordered(["left", "right", "top", "bottom"]));
    // The general sets of the sides with the switches of top and bottom off.
    await change("left general set", select, "link:left:", first, "set", linked("left", first));
    await change("right general set", select, "link:right:", first, "set", linked("right", first));
    await change("top general set", select, "link:top:", second, "set", linked("top", second));
    await change("bottom general set", select, "link:bottom:", second, "set", linked("bottom", second));
    // The switches of top and bottom on and off again with every side linked, and top first.
    await change("top switch on", select, "top", undefined, undefined, (values) => values.top === true);
    await change("bottom switch on", select, "bottom", undefined, undefined, (values) => values.bottom === true);
    await change("order left, top, right, bottom with top shown", order, "order:sidebarOrder:2:up", undefined, undefined, ordered(["left", "top", "right", "bottom"]));
    await change("order top, left, right, bottom", order, "order:sidebarOrder:1:up", undefined, undefined, ordered(["top", "left", "right", "bottom"]));
    await change("top switch off", select, "top", undefined, undefined, (values) => values.top === false);
    await change("bottom switch off", select, "bottom", undefined, undefined, (values) => values.bottom === false);
  });
