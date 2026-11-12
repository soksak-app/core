// Checks the independent storage of the window columns and the links inside cards with real sections and native coordinates.
import assert from "node:assert/strict";
import test from "node:test";
import { rmSync } from "node:fs";
import { APPS, holdCovered, keepCommonSettings, open, recordingSummary } from "@soksak/window-check/app.mjs";
import { fresh, joinedFailure } from "./fixture.mjs";
import { turnOffCardSidebars } from "./card-sidebar-choices.mjs";

const geometry = (grid) =>
  grid.cards.map(({ id, x, y, w, h }) => ({ id, x, y, w, h })).sort((a, b) => a.id.localeCompare(b.id));
const near = (actual, expected, label) =>
  assert.ok(Math.abs(actual - expected) <= 1, `${label}: ${actual}, expected ${expected}`);
for (const app of Object.values(APPS))
  test(
    `${app.name}: independent window and card settings survive hiding and project reload`,
    { timeout: 120000 },
    async (t) => {
      console.info(`START ${app.name}: window sidebar persistence`);
      const s = await open(t, app);
      t.diagnostic(`tested endpoint: ${JSON.stringify(s.client.endpoint)}`);
      const { surface: start, plugin } = await fresh(s);
      // The check reads the frames of the native surfaces of its window whatever the windows of other applications in front of it:
      // the window holds the covered drawing for the whole check (holdCovered), so its regions draw as they do on the screen.
      s.cleanup(await holdCovered(s));
      await s.run("core.settings.theme", { name: "midnight", mode: "dark" });
      await s.run("core.settings.set", { patch: { focusInd: "corner" }, scope: "common" });
      const initial = await s.get("core.grid");
      const configured = initial.cards.filter((card) => card.tabs.length === 0).map((card) => card.id);
      // A window sidebar follows the active tab of the focused card (docs/spec/plugins.md#sections), so the card of the plugin override is
      // the card of the start tab, the focused card, and not the first card that holds a probe tab: every card of the start layout holds one.
      const target = initial.cards.find((card) => card.focused && card.active === start);
      assert.ok(target, `the focused card does not show the start tab ${start}: ${JSON.stringify(initial.cards)}`);
      const probe = target.tabs.find((tab) => tab.id === start);
      // Stored list sets of the layout probe sections: the general left link shows one, and the right override of the probe, which
      // binds the fixed sidebar to the card of the probe tab, the other.
      await keepCommonSettings(s);
      const rightSet = { id: "window-reload-right", title: "Reload right", sections: ["layoutprobe.alpha", "layoutprobe.fill"], layout: "list" };
      const leftSet = { id: "window-reload-left", title: "Reload left", sections: ["layoutprobe.beta", "layoutprobe.follow"], layout: "list" };
      await s.run("core.settings.set", { patch: { sets: [...(await s.get("core.settings")).values.sets, rightSet, leftSet] }, scope: "common" });
      await s.run("core.settings.link", { place: "left", plugin: null, set: leftSet.id, scope: "common" });
      await s.run("core.settings.link", { place: "window-right", plugin, set: rightSet.id, scope: "common" });
      const windowBar = (await s.until("core.sidebars", (bars) => bars.some(
        (bar) => bar.placement === "window" && bar.card === target.id), "associated external sidebar absent")).find(
        (bar) => bar.placement === "window" && bar.card === target.id,
      );
      assert.ok(windowBar, "associated external sidebar absent");
      await turnOffCardSidebars(s, target.id);
      await s.run("core.tab.select", { tab: probe.id });
      const settings = (await s.get("core.settings")).values;
      const source = settings.sets.find((set) => set.id === rightSet.id);
      assert.ok(source, "the stored probe section set is absent");
      const cardSet = { ...source, id: "window-reload-card", title: "Reload card", layout: "list" };
      let savedRecords, savedSettings, savedSides, restoredGeometry;
      async function measure(label, hidden) {
        await s.until("core.settings", (value) => !value.saving, `${label}: settings save incomplete`);
        await s.presented();
        const grid = await s.get("core.grid"),
          layout = await s.get("core.layout");
        const current = grid.cards.find((card) => card.id === target.id);
        assert.ok(current, `${label}: content card absent`);
        const expectedIDs = configured.filter((id) => !hidden || id !== "right").sort();
        const columns = grid.cards.filter((card) => card.tabs.length === 0);
        assert.deepEqual(
          columns.map((card) => card.id).sort(),
          expectedIDs,
          `${label}: configured window columns changed`,
        );
        assert.deepEqual(layout.windowSidebars, savedRecords, `${label}: saved edge width changed`);
        assert.deepEqual((await s.get("core.settings")).values, savedSettings, `${label}: links or settings changed`);
        assert.deepEqual(
          layout.state.cards.find((card) => card.id === target.id).data.sidebars,
          savedSides,
          `${label}: card choices changed`,
        );
        const bars = await s.until(
          "core.sidebars",
          (all) =>
            all.some((bar) => bar.sidebar === `${target.id}:left` && bar.set === cardSet.id) &&
            all.every((bar) =>
              bar.sections.every(
                (section) =>
                  section.error === null && section.mounted === (bar.layout === "list" || section.id === bar.tab),
              ),
            ),
          `${label}: section output did not settle`,
        );
        const inside = bars.find((bar) => bar.sidebar === `${target.id}:left`);
        assert.equal(inside.placement, "card");
        assert.equal(inside.orientation, "vertical");
        assert.equal(current.sidebars.left.set, cardSet.id);
        assert.equal(current.sidebars.left.collapsed, false);
        assert.equal(current.sidebars.left.size, 144);
        assert.deepEqual(
          inside.sections.map((section) => section.id),
          cardSet.sections,
        );
        // The size less the card sidebar border and the band of its grip, before which the set stops (docs/spec/example-model.md).
        near(inside.rect.w, 137, `${label}: internal section width excluding the border and the grip`);
        assert.ok(
          inside.sections.every((section) => section.mounted && section.phase === "ready"),
          `${label}: internal section views not ready`,
        );
        assert.ok(
          inside.sections.find((section) => section.id === "layoutprobe.alpha")?.mounted === true,
          `${label}: probe section view absent`,
        );
        for (const column of columns) {
          near(column.w, savedRecords[column.id].width, `${label}: ${column.id} width`);
          near(column.h, grid.height, `${label}: full-height column`);
          const bar = bars.find((item) => item.sidebar === column.id);
          assert.ok(bar, `${label}: ${column.id} sections absent`);
          const link = savedSettings.links.find(
            (item) =>
              item.place === (column.id === "left" ? "left" : `window-${bar.side}`) && item.plugin === bar.plugin,
          );
          assert.equal(bar.set, link.set, `${label}: window assignment`);
          assert.deepEqual(
            bar.sections.map((section) => section.id),
            savedSettings.sets.find((set) => set.id === link.set).sections,
            `${label}: window section output was dropped`,
          );
          assert.ok(
            bar.sections.filter((section) => section.mounted).every((section) => section.phase === "ready"),
            `${label}: ${column.id} section views not ready`,
          );
          if (column.id === windowBar.sidebar) {
            assert.equal(bar.surface, probe.id);
            assert.equal(bar.card, target.id);
          }
          for (const [key, value] of Object.entries({
            x: grid.plane.x + column.x + 1,
            y: grid.plane.y + column.y + 1,
            w: column.w - 2,
            h: column.h - 24,
          }))
            near(bar.rect[key], value, `${label}: ${column.id} DOM ${key}`);
        }
        const surface = (await s.surfaces()).find((item) => item.surface === probe.id);
        assert.ok(surface?.applied, `${label}: native surface absent`);
        const expected = {
          x: grid.plane.x + current.x + 145,
          y: grid.plane.y + current.y + 33,
          w: current.w - 146,
          h: current.h - 56,
        };
        for (const key of Object.keys(expected)) {
          near(surface.applied[key], expected[key], `${label}: native ${key}`);
          near(surface.declared[key], expected[key], `${label}: declared ${key}`);
        }
        const host = await s.get("host.window");
        const native = host.surfaces.find((item) => item.id === probe.id)?.frame;
        assert.ok(native, `${label}: host frame absent`);
        for (const [key, value] of Object.entries({
          x: expected.x,
          y: expected.y,
          width: expected.w,
          height: expected.h,
        }))
          near(native[key], value, `${label}: host ${key}`);
        assert.deepEqual(
          (await s.get("core.verify")).rows.filter((row) => !row.ok),
          [],
        );
        assert.deepEqual((await s.get("core.workbench.audit")).unbound, []);
        t.diagnostic(
          `${label}: records=${JSON.stringify(savedRecords)}; native=${JSON.stringify(expected)}; internal=${inside.set}/${inside.rect.w}`,
        );
        return { grid, columns, native: expected };
      }
      async function phase(label, change, hidden = false) {
        const began = performance.now();
        console.info(`START ${app.name}: ${label}`);
        const recording = await s.record();
        let stopAttempted = false,
          displayed = 0,
          result;
        const errors = [];
        try {
          await change();
          result = await measure(label, hidden);
          ({ displayed } = await s.presented());
          stopAttempted = true;
          const stop = await recording.stop({ after: displayed + 100 });
          t.diagnostic(`${label}: ${recordingSummary(stop)}`);
          console.info(`PASS ${app.name}: ${label} (${Math.round(performance.now() - began)}ms)`);
        } catch (error) {
          errors.push(error);
        } finally {
          try {
            if (!stopAttempted) await recording.stop({ after: displayed ? displayed + 100 : 0 });
          } catch (error) {
            errors.push(error);
          }
          try {
            if (recording.frames) rmSync(recording.frames, { recursive: true, force: true });
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length) throw joinedFailure(`${label}: persistence recording failed`, errors);
        return result.grid;
      }
      const assigned = await phase("independent settings and widths", async () => {
        await s.run("core.settings.set", { patch: { sets: [...settings.sets, cardSet] }, scope: "common" });
        await s.run("core.settings.link", {
          place: `window-${windowBar.side}`,
          plugin: probe.plugin,
          set: source.id,
          scope: "common",
        });
        await s.run("core.settings.link", {
          place: "card-left",
          plugin: probe.plugin,
          set: cardSet.id,
          scope: "common",
        });
        await s.run("core.card.sidebar.set", { card: target.id, side: "left", set: "inherit" });
        await s.run("core.card.sidebar.size", { card: target.id, side: "left", size: 144 });
        await s.run("core.grid.size", { card: windowBar.sidebar, axis: "x", size: 215 });
        await s.run("core.grid.size", { card: "left", axis: "x", size: 207 });
        await s.presented();
        savedRecords = (await s.get("core.layout")).windowSidebars;
        assert.deepEqual(Object.keys(savedRecords).sort(), ["left", "right"], "only fixed edge widths are stored");
        for (const record of Object.values(savedRecords))
          assert.deepEqual(Object.keys(record), ["width"], "a plugin owner was persisted");
        assert.equal(savedRecords[windowBar.sidebar].width, 215);
        assert.equal(savedRecords.left.width, 207);
        savedSettings = (await s.get("core.settings")).values;
        savedSides = (await s.get("core.layout")).state.cards.find((card) => card.id === target.id).data.sidebars;
        assert.equal(Object.hasOwn(savedSides.left, "set"), false, "derived link became an explicit card assignment");
      });
      await phase(
        "right edge hidden",
        async () => {
          await s.run("core.settings.set", { patch: { right: false }, scope: "common" });
          savedSettings = { ...savedSettings, right: false };
        },
        true,
      );
      const restored = await phase("right edge restored", async () => {
        await s.run("core.settings.set", { patch: { right: true }, scope: "common" });
        savedSettings = { ...savedSettings, right: true };
      });
      restoredGeometry = geometry(restored);
      assert.deepEqual(restoredGeometry, geometry(assigned), "edge restoration changed content or window geometry");
      const project = (await s.get("core.project")).id;
      const reloaded = await phase("saved project reloaded", async () => {
        await s.run("core.projects.flush");
        const origin = (await s.get("core.window.workbench")).start;
        await s.run("host.window.reload");
        await s.until(
          "core.window.workbench",
          (workbench) => workbench.start !== origin && workbench.readyState === "complete",
          "the workbench did not start again",
        );
        await s.until("core.project", (value) => value?.id === project, "reload lost project");
      });
      assert.deepEqual(geometry(reloaded), restoredGeometry, "reload changed configured geometry");
    },
  );
