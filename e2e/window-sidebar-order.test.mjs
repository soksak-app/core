// Checks the window sidebars of the four sides and their order on the rebuilt applications (docs/spec/external-sidebars.md#verification):
// in each of the 24 orders the grid, core.sidebars and the plane checks show one sidebar of each side where
// the order places it; the chrome switches hide and show their sides by a click, and the places hold through full screen and a reload.
import assert from "node:assert/strict";
import test from "node:test";
import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";
import { SIDES, orders, placeMismatches, reportMismatches, thicknesses } from "./window-sidebar-places.mjs";

/** The rectangles of the window sidebars of a grid by side. */
const places = (grid) => Object.fromEntries(grid.cards.filter((card) => SIDES.includes(card.id)).map(({ id, x, y, w, h }) => [id, { x, y, w, h }]));

for (const app of Object.values(APPS))
  test(`${app.name}: the window sidebars of the four sides stand where each order places them`, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    // A window that leaves native full screen stays in front of the windows of other applications, so the check ends with a
    // relaunch, as the full screen check of the chrome does (docs/spec/hosts.md#launch-activation).
    s.cleanup(() => s.relaunch());
    await s.run("core.settings.theme", { name: "midnight", mode: "dark" });
    const { values, overridden } = await s.get("core.settings");
    // The chrome switches change the common scope of a project without overrides.
    assert.deepEqual(overridden, [], "the fixture project overrides settings");
    const set = values.sets[0]?.id;
    assert.ok(set, "a sidebar set is required");
    const initial = { links: values.links, sidebarOrder: values.sidebarOrder, left: values.left, right: values.right, top: values.top, bottom: values.bottom };
    s.cleanup(() => s.run("core.settings.set", { patch: initial, scope: "common" }));
    for (const side of SIDES) await s.run("core.settings.link", { place: side, plugin: null, set, scope: "common" });
    await s.run("core.settings.set", { patch: { left: true, right: true, top: true, bottom: true, sidebarOrder: [...SIDES] }, scope: "common" });

    /**
     * Waits until the grid holds the sidebars of `held` where the order places them, then checks core.sidebars and the plane
     * checks of the presented window, and returns the grid.
     */
    async function standing(label, order, held, thickness) {
      let last = [];
      const grid = await s.until("core.grid", (now) => now !== null && (last = placeMismatches(now, order, held, thickness)).length === 0,
        `${label}: the window sidebars do not stand where the order ${order.join(", ")} places ${held.join(", ")}`).catch((error) => {
        error.message += `; last mismatches: ${last.join("; ")}`;
        throw error;
      });
      let reported = [];
      await s.until("core.sidebars", (bars) => (reported = reportMismatches(bars, grid, held)).length === 0,
        `${label}: core.sidebars does not report the window sidebars of ${held.join(", ")}`).catch((error) => {
        error.message += `; last mismatches: ${reported.join("; ")}`;
        throw error;
      });
      await s.presented();
      const shown = await s.get("core.grid");
      assert.deepEqual(placeMismatches(shown, order, held, thickness), [], `${label}: the presented grid moved a window sidebar`);
      assert.deepEqual(places(shown), places(grid), `${label}: the presented grid differs from the arranged one`);
      assert.deepEqual((await s.get("core.verify")).rows.filter((row) => !row.ok), [], `${label}: a plane check fails`);
      t.diagnostic(`${label}: ${order.join(">")} ${JSON.stringify(places(shown))}`);
      return shown;
    }

    // The default order gives the thickness of each side, which every other order keeps.
    const first = await standing("default order", SIDES, SIDES);
    const thickness = thicknesses(first);
    for (const order of orders()) {
      await s.run("core.settings.change", { key: "sidebarOrder", value: order, scope: "common" });
      await s.until("core.settings", (settings) => JSON.stringify(settings.values.sidebarOrder) === JSON.stringify(order),
        `core.settings does not hold the order ${order.join(", ")}`);
      await standing(`order ${order.join(", ")}`, order, SIDES, thickness);
    }

    // The chrome switches stand in the order left, right, top, bottom, and a click hides and shows their side.
    const order = ["top", "left", "bottom", "right"];
    await s.run("core.settings.change", { key: "sidebarOrder", value: order, scope: "common" });
    await standing("switch order", order, SIDES, thickness);
    const switches = [];
    for (const side of SIDES) switches.push(await s.rect(`core.chrome.${side}`, 0));
    for (let index = 1; index < switches.length; index++)
      assert.ok(switches[index].x >= switches[index - 1].x + switches[index - 1].width,
        `the chrome switch ${SIDES[index]} does not stand right of ${SIDES[index - 1]}: ${JSON.stringify(switches)}`);
    for (const side of SIDES) {
      for (const shown of [false, true]) {
        const rect = await s.rect(`core.chrome.${side}`, 0);
        const point = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        await s.click(point.x, point.y);
        await s.until("core.settings", (settings) => settings.values[side] === shown,
          `core.settings does not hold ${side} ${shown} after a click at ${JSON.stringify(point)} on core.chrome.${side}`);
        await standing(`${side} switch ${shown ? "on" : "off"}`, order, shown ? SIDES : SIDES.filter((other) => other !== side), thickness);
      }
    }

    // Full screen: the sidebars stand in the larger plane with the same thickness and return to their rectangles after it.
    const before = await s.get("host.window");
    const plane = await s.get("core.grid");
    const windowed = places(plane);
    await s.run("host.window.fullscreen", { on: true });
    try {
      await s.until("host.window", (w) => w.content.height > before.content.height, "the window did not enter full screen");
      const full = await standing("full screen", order, SIDES, thickness);
      assert.ok(full.width > plane.width || full.height > plane.height,
        `full screen did not enlarge the plane of ${plane.width} by ${plane.height}: ${full.width} by ${full.height}`);
    } finally {
      await s.run("host.window.fullscreen", { on: false });
      await s.until("host.window", (w) => w.content.height === before.content.height && w.content.width === before.content.width,
        "the window did not leave full screen");
    }
    const restored = await standing("after full screen", order, SIDES, thickness);
    assert.deepEqual(places(restored), windowed, "the window sidebars did not return to their rectangles after full screen");

    // A reload of the workbench keeps the order and the places.
    await s.run("host.window.reload");
    await s.until("host.windows", (list) => list.some((item) => item.window === s.window && item.ready), "the reloaded page did not report ready");
    assert.deepEqual((await s.get("core.settings")).values.sidebarOrder, order, "the reload lost the order");
    const reloaded = await standing("after reload", order, SIDES, thickness);
    assert.deepEqual(places(reloaded), windowed, "the window sidebars moved across the reload");
  });
