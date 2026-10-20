// Card four-side assignment check: distinguishes the display by the saved set and the space, and keeps it after a tab switch.
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import test from "node:test";

import { APPS, keepCommonSettings, open } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";
import { checkLinkedPanels } from "./linked-panels.mjs";
import { gripInk, requireCleared, tabSwitchPair } from "./card-panel-checks.mjs";
import { readPng } from "@soksak/window-check/png.mjs";
const geometry=grid=>grid.cards.map(({id,x,y,w,h})=>({id,x,y,w,h})).sort((a,b)=>a.id.localeCompare(b.id));

for (const app of Object.values(APPS)) {
  test(`${app.name}: assigned left and right panels reduce the actual native surface width`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    const card = (await s.get("core.grid")).cards.find((item) => item.tabs?.length);
    assert.ok(card, "no content card to measure");
    const set = (await s.get("core.settings")).values.sets[0];
    for (const side of ["left", "right"]) {
      await s.run("core.card.sidebar.set", { card: card.id, side, set: set.id });
    }
    const grid = await s.get("core.grid");
    const measuredCard = grid.cards.find((item) => item.id === card.id);
    const surface = (await s.surfaces()).find((item) => item.surface === measuredCard.active);
    assert.ok(surface?.applied, `no applied native surface for ${JSON.stringify(measuredCard)}`);
    // Excluding 1 point of card border on each side, the left and right panels must occupy only 190 points each, once.
    const drawn = await s.get("core.sidebars");
    for (const side of ["left", "right"]) {
      assert.equal(drawn.filter((item) => item.sidebar === `${card.id}:${side}`).length, 1,
        `card must have exactly one ${side} region`);
    }
    assert.equal(drawn.filter((item) => item.sidebar === card.id || item.sidebar === `${card.id}:inset`).length, 0,
      "obsolete inset region remained mounted");
    const expectedWidth = measuredCard.w - 380 - 2;
    assert.ok(Math.abs(surface.applied.w - expectedWidth) <= 1,
      `two sides must reserve exactly 380 points without a second inset left: ${JSON.stringify({ expectedWidth, card: measuredCard, surface })}`);
    assert.equal(measuredCard.w, card.w, "assigning panels resized the card");
    for (const side of ["top", "bottom"]) {
      await s.run("core.card.sidebar.set", { card: card.id, side, set: set.id });
    }
    for (const side of ["top", "bottom", "left", "right"]) {
      await s.run("core.card.sidebar.toggle", { card: card.id, side });
    }
    await s.presented();
    for (let index = 0; index < 4; index++) {
      const grip = await s.rect("core.card.sidebar.grip", index);
      assert.ok(grip.width > 0 && grip.height > 0, `folded divider ${index} has no input area: ${JSON.stringify(grip)}`);
    }
    const foldedSurface = (await s.surfaces()).find((item) => item.surface === measuredCard.active);
    assert.ok(Math.abs(foldedSurface.applied.w - (measuredCard.w - 12 - 2)) <= 1,
      `folded sidebars must reserve only two 6-point dividers: ${JSON.stringify(foldedSurface)}`);
    // A collapsed face draws only a short grip of the same length as the divider between cards (library grip length 24 CSS pixels). A line across the whole card width or
    // height looks like one more boundary line.
    const still = (await s.request("diagnostics.capture.still", {})).path;
    const image = readPng(still);
    rmSync(dirname(still), { recursive: true, force: true });
    const ratio = image.width / (await s.get("host.window")).content.width;
    for (let index = 0; index < 4; index++) {
      const grip = await s.rect("core.card.sidebar.grip", index);
      // The vertical band continues to the bottom end of the card. The foot-height section at the very bottom is collapsed and is the place of the empty-state row, and the border of the rounded corner of the card
      // passes through it, so it is excluded from the measurement that looks for the second line.
      const vertical = grip.height > grip.width;
      const ink = gripInk(image, vertical ? { ...grip, height: grip.height - 22 } : grip, ratio);
      // The handle of a collapsed sidebar is three dots, which are distinct from the bar of the card divider (docs/spec/example-model.md).
      assert.ok(ink.runs === 3 && ink.span > 0 && ink.span <= 24 * ratio + 2,
        `folded divider ${index} must show three dots within 24 points: ${JSON.stringify({ grip, ink })}`);
    }
  });

  // In a user release, left/right/top were assigned 190 points each on the shell card, but the native surface was almost as wide as the card
  // (V5-116-4-11-2). The check measures together, for the same assignment, the native rectangle, the grip registration, and the agreement of DOM and native.
  test(`${app.name}: left, right and top panels on the terminal card reserve their space in the native surface`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    const card = (await s.get("core.grid")).cards.find((item) => item.id === "terminal");
    assert.ok(card, "the fixture has no terminal card");
    const set = (await s.get("core.settings")).values.sets[0];
    for (const side of ["left", "right", "top"]) {
      await s.run("core.card.sidebar.set", { card: card.id, side, set: set.id });
      await s.run("core.card.sidebar.size", { card: card.id, side, size: 190 });
    }
    await s.presented();
    const grid = await s.get("core.grid");
    const measured = grid.cards.find((item) => item.id === card.id);
    const surface = (await s.surfaces()).find((item) => item.surface === measured.active);
    assert.ok(surface?.applied, `no applied native surface for ${JSON.stringify(measured)}`);
    const band = (side) => (measured.sidebars[side] ? (measured.sidebars[side].collapsed ? 6 : measured.sidebars[side].size) : 0);
    const expected = {
      x: grid.plane.x + measured.x + 1 + band("left"),
      y: grid.plane.y + measured.y + 1 + 32 + band("top"),
      w: measured.w - 2 - band("left") - band("right"),
      h: measured.h - 2 - 32 - 22 - band("top") - band("bottom"),
    };
    const off = Object.keys(expected).filter((key) => Math.abs(surface.applied[key] - expected[key]) > 1);
    assert.deepEqual(off, [], `the native surface does not leave the panel space: ${JSON.stringify({ expected,
      applied: surface.applied, card: measured, sidebars: measured.sidebars })}`);
    const drawn = (await s.get("core.sidebars")).filter((item) => item.sidebar.startsWith(`${card.id}:`));
    assert.deepEqual(drawn.map((item) => item.sidebar).sort(), ["terminal:left", "terminal:right", "terminal:top"],
      "the terminal card does not draw exactly its three assigned panels");
    // Each card panel has one grip with an input region.
    const panels = (await s.get("core.sidebars")).filter((item) => /:(left|right|top|bottom)$/.test(item.sidebar));
    for (let index = 0; index < panels.length; index++) {
      const grip = await s.rect("core.card.sidebar.grip", index);
      assert.ok(grip.width > 0 && grip.height > 0, `grip ${index} of ${panels.length} has no input area: ${JSON.stringify(grip)}`);
    }
    const failed = (await s.get("core.verify")).rows.filter((row) => !row.ok);
    assert.deepEqual(failed, [], "DOM and native geometry disagree");
    t.diagnostic(`terminal panels ${JSON.stringify({ expected, applied: surface.applied })}`);
  });

  // A drag passes fractional sizes. The card border, the divider, and the prepared surface rectangle use the device pixel grid
  // (docs/spec/native-surfaces.md). Even for a size off the grid, the display is on the grid, and the declaration and the application must be equal (V5-115-1-3).
  test(`${app.name}: fractional panel sizes place the native surface on the device-pixel grid`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    const card = (await s.get("core.grid")).cards.find((item) => item.id === "terminal");
    assert.ok(card, "the fixture has no terminal card");
    const set = (await s.get("core.settings")).values.sets[0];
    const scale = (await s.get("host.window")).scale;
    const sizes = { left: 120.5, top: 130.25, right: 140.75 };
    for (const [side, size] of Object.entries(sizes)) {
      await s.run("core.card.sidebar.set", { card: card.id, side, set: set.id });
      await s.run("core.card.sidebar.size", { card: card.id, side, size });
    }
    await s.presented();
    const measured = (await s.get("core.grid")).cards.find((item) => item.id === card.id);
    for (const [side, size] of Object.entries(sizes)) assert.equal(measured.sidebars[side].size, size, `${side} size was not kept`);
    const surface = (await s.surfaces()).find((item) => item.surface === measured.active);
    assert.ok(surface?.applied, "the terminal surface is not presented");
    const onGrid = (value) => Math.abs(value * scale - Math.round(value * scale)) < 1e-6;
    const edges = { left: surface.applied.x, top: surface.applied.y, right: surface.applied.x + surface.applied.w,
      bottom: surface.applied.y + surface.applied.h };
    assert.deepEqual(Object.entries(edges).filter(([, value]) => !onGrid(value)).map(([key]) => key), [],
      `native surface edges are off the ${scale}x device-pixel grid: ${JSON.stringify(surface)}`);
    const failed = (await s.get("core.verify")).rows.filter((row) => !row.ok);
    assert.deepEqual(failed, [], `DOM and native geometry disagree at ${scale}x with fractional panel sizes`);
    t.diagnostic(`fractional panels at ${scale}x ${JSON.stringify({ declared: surface.declared, applied: surface.applied })}`);
  });

  // Reported state: top and bottom panels of a card of height 342pt. A face collapsed for lack of space opens by click, and when a collapsed face is dragged, it opens at the place where the pointer
  // reaches the minimum size (docs/spec/example-model.md).
  test(`${app.name}: a click opens a side folded for lack of space and a drag opens a folded side under the pointer`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    await keepCommonSettings(s);
    const card = (await s.get("core.grid")).cards.find((item) => item.tabs?.some((tab) => tab.plugin === "terminal"));
    assert.ok(card, "no terminal card");
    const set = (await s.get("core.settings")).values.sets[0];
    for (const side of ["top", "bottom"]) await s.run("core.card.sidebar.set", { card: card.id, side, set: set.id });
    const panelsOf = (grid) => grid.cards.find((item) => item.id === card.id).sidebars;
    let grid = await s.until("core.grid", (value) => panelsOf(value).bottom?.autoCollapsed === true,
      "the bottom panel did not fold for lack of space");
    const room = grid.cards.find((item) => item.id === card.id).h - 2 - 54 - 96;
    assert.ok(room < 380 && room - 6 >= 120, `the fixture card must fit one 190-point side but not two: room ${room}`);
    assert.equal(panelsOf(grid).top.collapsed, false, "the top panel must open while the bottom folds");
    await s.presented();
    // core.card.sidebar.grip is the handle in the drawn order (top, bottom).
    const gripOf = async (side) => {
      const grips = [];
      for (let index = 0; index < 2; index++) grips.push(await s.rect("core.card.sidebar.grip", index));
      grips.sort((a, b) => a.y - b.y);
      return side === "top" ? grips[0] : grips[1];
    };
    const bottom = await gripOf("bottom");
    await s.click(bottom.x + bottom.width / 2, bottom.y + bottom.height / 2);
    grid = await s.until("core.grid", (value) => panelsOf(value).bottom.collapsed === false,
      "a click on the bottom panel folded for lack of space did not open it");
    const opened = panelsOf(grid);
    assert.ok(Math.abs(opened.bottom.shownSize - Math.min(190, room - 6)) <= 1.5, `bottom shown size ${opened.bottom.shownSize}`);
    assert.equal(opened.top.autoCollapsed, true, "the top panel must fold when the clicked bottom panel opens");
    assert.equal(opened.top.size, 190, "the stored size changed");
    await s.presented();
    // Dragging the collapsed top by 30pt does not reach the minimum size, so it stays collapsed; dragging it by 150pt opens it at 6 + 150 = 156pt.
    const top = await gripOf("top");
    const x = top.x + top.width / 2, y = top.y + top.height / 2;
    await s.pointer(x, y, "down");
    for (const dy of [10, 20, 30]) await s.pointer(x, y + dy, "drag");
    await s.presented();
    assert.equal(panelsOf(await s.get("core.grid")).top.collapsed, true, "a drag shorter than the minimum opened the top panel");
    for (const dy of [60, 90, 120, 150]) await s.pointer(x, y + dy, "drag");
    await s.pointer(x, y + 150, "up");
    // A drag sends several size commands in sequence, so the check waits until the size at the last pointer position.
    grid = await s.until("core.grid", (value) => panelsOf(value).top.collapsed === false && Math.abs(panelsOf(value).top.size - 156) <= 1,
      "a drag past the minimum did not open the top panel at the pointer");
    const dragged = panelsOf(grid);
    assert.ok(Math.abs(dragged.top.size - 156) <= 1 && Math.abs(dragged.top.shownSize - 156) <= 1,
      `the top edge must follow the pointer at 156 points: ${JSON.stringify(dragged.top)}`);
    t.diagnostic(`room ${room}; click: ${JSON.stringify(opened)}; drag: ${JSON.stringify(dragged)}`);
  });

  test(`${app.name}: a card carries assigned panels on all four sides regardless of the active tab`, {timeout:60000}, async (t) => {
    const s = await open(t, app);
    t.diagnostic(`tested endpoint: ${JSON.stringify(s.client.endpoint)}`);
    await fresh(s);
    const settings = await s.get("core.settings");
    const set = settings.values.sets[0];
    assert.ok(set, "the fixture has no set to assign");

    const grid0 = await s.get("core.grid");
    let card0 = grid0.cards.find((item) => item.tabs.length);
    assert.ok(card0, "no content card to hold panels");
    // The tab switch check always uses a tab of another plugin. If the card has none, it adds a browser tab instead of moving a tab of another card.
    // Moving it would leave that card empty, remove it, and change the layout.
    if (!card0.tabs.some((tab) => tab.plugin !== card0.tabs.find((item) => item.id === card0.active).plugin)) {
      const { tab } = await s.run("core.card.add-tab", { card: card0.id, plugin: "browser" });
      s.cleanup(() => s.run("core.tab.close", { tab }));
      await s.run("core.tab.select", { tab: card0.active });
    }
    card0 = (await s.get("core.grid")).cards.find((item) => item.id === card0.id);
    const { original, other } = tabSwitchPair(card0, [card0]);

    // Four-side assignment: it is card data, so any card accepts it.
    for (const side of ["top", "bottom", "left", "right"]) {
      await s.run("core.card.sidebar.set", { card: card0.id, side, set: set.id });
    }
    const grid = await s.until("core.grid",
      (value) => value.cards.find((item) => item.id === card0.id)?.sidebars
        && Object.keys(value.cards.find((item) => item.id === card0.id).sidebars).length === 4,
      "the four panels did not appear in core.grid");
    const panels = grid.cards.find((item) => item.id === card0.id).sidebars;
    const assigned=grid.cards.find(item=>item.id===card0.id);
    assert.ok(assigned.h-56-380<96,'the normal fixture must have insufficient height for two 190-point sides');
    assert.ok(assigned.w-2-380>=96,'the normal fixture must retain sufficient width for two 190-point sides');
    const saved=(await s.get('core.layout')).state.cards.find(item=>item.id===card0.id).data.sidebars;
    // In this height two 190 panels do not fit even at the minimum size, so the top, which has priority before any manual operation, opens at the size that fits and only the bottom collapses
    // (docs/spec/example-model.md). The height space is the card height minus 2 for the border, 54 for the head and foot, and 96 for the minimum content.
    const room=assigned.h-2-54-96;
    for (const side of ["top", "bottom", "left", "right"]) {
      const autoCollapsed=side==='bottom';
      const shownSize=side==='top'?Math.min(190,room-6):side==='bottom'?null:190;
      // The drawn card height lies on the device pixel grid, so the visible size is compared within 1pt.
      const { shownSize: shown, ...panel } = panels[side];
      assert.deepEqual(panel, { set: set.id, size: 190, collapsed: autoCollapsed,
        requestedCollapsed:false,autoCollapsed,collapseReason:autoCollapsed?'insufficient-height':null },
        `side ${side} did not take the assignment with the default size`);
      assert.ok(shownSize===null?shown===null:Math.abs(shown-shownSize)<=1, `side ${side} shown size ${shown}, expected ${shownSize}`);
      assert.equal(saved[side].set,set.id,`${side} assignment was not saved`);
      assert.equal(Object.hasOwn(saved[side],'autoCollapsed'),false,'automatic presentation was saved');
    }

    // Link blocking: even when the active tab is changed to another plugin, the assigned set stays the same.
    await s.run("core.tab.select", { tab: other.id });
    await s.until("core.grid", (value) => value.cards.find((item) => item.id === card0.id)?.active === other.id,
      "the tab did not switch");
    const afterGrid=await s.get('core.grid');
    assert.deepEqual(geometry(afterGrid),geometry(grid),'tab selection changed internal or external card geometry');
    assert.deepEqual(afterGrid.cards.find(item=>item.id===card0.id).sidebars,panels,'tab selection changed assigned sets or presentation');
    assert.deepEqual((await s.get('core.layout')).state.cards.find(item=>item.id===card0.id).data.sidebars,saved,'tab selection changed saved assignments');
    // The native surface of the switched tab sits at the same place too (V7a/V7b/V7c).
    await s.presented();
    assert.deepEqual((await s.get("core.verify")).rows.filter((row) => !row.ok), [], "tab selection left DOM and native geometry apart");
    t.diagnostic(`normal card ${assigned.w}x${assigned.h}; top opens at the room, bottom auto-folds, left/right open; different-plugin tabs ${original.plugin}/${other.plugin} preserve all geometry`);

    // A panel is reported in core.sidebars with the card:side id (specification: sidebar identification).
    const drawn = await s.until("core.sidebars",
      (value) => ["top", "bottom", "left", "right"].every((side) =>
        value.some((item) => item.sidebar === `${card0.id}:${side}` && item.set === set.id)),
      "the drawn panels did not appear in core.sidebars");
    assert.ok(drawn.length >= 4, "core.sidebars reports the four panels");

    // Pressing the top that appears open saves the collapse.
    const beforeLayout = (await s.get("core.grid")).cards.find((item) => item.id === card0.id);
    await s.run("core.card.sidebar.toggle", { card: card0.id, side: "top" });
    const folded = await s.until("core.grid",
      (value) => value.cards.find((item) => item.id === card0.id)?.sidebars?.top?.requestedCollapsed === true,
      "the top panel did not fold");
    assert.equal(folded.cards.find((item) => item.id === card0.id).sidebars.top.size, 190,
      "folding keeps the stored size");
    assert.equal(folded.cards.find(item=>item.id===card0.id).sidebars.top.autoCollapsed,false,'manual fold remained classified as automatic');
    assert.equal((await s.get('core.layout')).state.cards.find(item=>item.id===card0.id).data.sidebars.top.collapsed,true,'manual fold was not saved');
    await s.run("core.card.sidebar.size", { card: card0.id, side: "right", size: 260 });
    const resized = await s.until("core.grid",
      (value) => value.cards.find((item) => item.id === card0.id)?.sidebars?.right?.size === 260,
      "the right panel did not take the new size");
    assert.deepEqual(
      ["x", "y", "w", "h"].map((key) => resized.cards.find((item) => item.id === card0.id)[key]),
      ["x", "y", "w", "h"].map((key) => beforeLayout[key]),
      "panels changed the card itself — panels live inside the card");
    await assert.rejects(s.run("core.card.sidebar.size", { card: card0.id, side: "right", size: 60 }), /120 to 480/);
    await assert.rejects(s.run("core.card.sidebar.set", { card: card0.id, side: "middle", set: set.id }), /invalid params/);

    // Release: only that side disappears.
    await s.run("core.card.sidebar.set", { card: card0.id, side: "top", set: "off" });
    const cleared = await s.until("core.grid",
      (value) => value.cards.find((item) => item.id === card0.id)?.sidebars
        && !("top" in value.cards.find((item) => item.id === card0.id).sidebars),
      "the turned-off panel did not disappear");
    assert.ok("right" in cleared.cards.find((item) => item.id === card0.id).sidebars,
      "turning off one side removed another");
    // off does not follow the default set and turns the given side off explicitly.
    for (const side of ["bottom", "left", "right"]) {
      await s.run("core.card.sidebar.set", { card: card0.id, side, set: "off" });
    }
    // The card must remain and have no panel. A card that disappeared is not a cleanup.
    const clearedAll = await s.until("core.grid", (value) => {
      const item = value.cards.find((candidate) => candidate.id === card0.id);
      return Boolean(item) && Object.keys(item.sidebars).length === 0;
    }, "the card sidebars did not clear");
    requireCleared(clearedAll.cards.find((item) => item.id === card0.id).sidebars);
  });
}

// A new card position must also be accepted by the input contract of the public link command (V5-116-4).
for (const app of Object.values(APPS)) {
  test(`${app.name}: sidebar link commands accept all four card places`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    assert.ok(s, `${app.binary} is missing; sidebar link behavior was not observed`);
    t.diagnostic(`tested endpoint: ${JSON.stringify(s.client.endpoint)}`);
    await fresh(s);
    await keepCommonSettings(s);
    const { values } = await s.get("core.settings");
    const card = (await s.get("core.grid")).cards.find((item) => item.tabs?.some((tab) => tab.id === item.active && tab.plugin));
    assert.ok(card, "no card with a declared active plugin");
    const plugin = card.tabs.find((tab) => tab.id === card.active).plugin;
    const set = values.sets[0]?.id;
    assert.ok(set, "no sidebar set in the fixture");
    const failures = [];
    for (const place of ["card-left", "card-right", "card-top", "card-bottom"]) {
      const start = performance.now();
      t.diagnostic(`start ${app.name}/${place}/core.settings.link`);
      try {
        await s.run("core.settings.link", { place, plugin, set, scope: "common" });
        await s.until("core.settings", (value) => !value.saving && value.values.links.some((link) =>
          link.place === place && link.plugin === plugin && link.set === set), `link ${place} was not saved`);
        t.diagnostic(`pass ${app.name}/${place}/core.settings.link ${Math.round(performance.now() - start)}ms`);
      } catch (error) {
        const failure = `${app.name}/${place}/core.settings.link: ${error.message}`;
        failures.push(failure);
        t.diagnostic(`fail ${failure} ${Math.round(performance.now() - start)}ms`);
      }
    }
    assert.deepEqual(failures, [], "the public link command must accept all four declared card places");
  });
}

// A linked default panel receives the same collapse and size commands (V5-116-4).
for (const app of Object.values(APPS)) {
  test(`${app.name}: linked card panels accept fold and size without an explicit assignment`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    assert.ok(s, `${app.binary} is missing; linked-panel behavior was not observed`);
    t.diagnostic(`tested endpoint: ${JSON.stringify(s.client.endpoint)}`);
    await fresh(s);
    await keepCommonSettings(s);
    await checkLinkedPanels(s, t, app.name);
  });
}

for (const app of Object.values(APPS)) {
  // The card sidebar ends at its own bottom row, and the content bottom row of the card occupies only the content column at the bottom end of the card
  // (docs/spec/example-model.md).
  test(`${app.name}: a card sidebar ends in its own status line and the content footer spans only the content`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    const set = (await s.get("core.settings")).values.sets[0];
    await s.run("core.card.sidebar.set", { card: "terminal", side: "left", set: set.id });
    await s.run("core.card.sidebar.size", { card: "terminal", side: "left", size: 190 });
    await s.presented();
    const grid = await s.get("core.grid");
    const card = grid.cards.find((item) => item.id === "terminal");
    const box = { x: grid.plane.x + card.x, y: grid.plane.y + card.y, w: card.w, h: card.h };
    const within = (r) => r.x >= box.x - 0.5 && r.x + r.width <= box.x + box.w + 0.5 && r.y >= box.y - 0.5 && r.y + r.height <= box.y + box.h + 0.5;
    const footers = [];
    for (let index = 0; index < grid.cards.filter((item) => item.tabs.length > 0).length; index++) footers.push(await s.rect("core.card.status", index));
    const footer = footers.find(within);
    assert.ok(footer, `the terminal card has no content footer: ${JSON.stringify({ box, footers })}`);
    const content = box.x + 1 + 190;
    assert.ok(Math.abs(footer.x - content) <= 1 && Math.abs(footer.x + footer.width - (box.x + box.w - 1)) <= 1
      && Math.abs(footer.y + footer.height - (box.y + box.h - 1)) <= 1,
      `the content footer does not span only the content column: ${JSON.stringify({ footer, content, box })}`);
    const status = await s.rect("core.card.sidebar.status", 0);
    assert.ok(within(status) && Math.abs(status.y + status.height - (box.y + box.h - 1)) <= 1 && status.x + status.width <= content + 0.5,
      `the left sidebar does not end in its status line at the bottom of the card: ${JSON.stringify({ status, box })}`);
    assert.ok(Math.abs(status.y - footer.y) <= 0.5 && status.height === footer.height,
      `the sidebar status line and the content footer are not one row: ${JSON.stringify({ status, footer })}`);
    const text = (await s.get("core.sidebars")).find((item) => item.sidebar === "terminal:left");
    assert.ok(text, "the left card sidebar is not drawn");
  });
}

for (const app of Object.values(APPS)) {
  // The card head has a collapse/expand button for each face that the card shows. A collapsed face is opened again with the button of the head (docs/spec/example-model.md).
  test(`${app.name}: the card header has a fold control for each sidebar the card shows`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    const listed = (await s.request("exposure.list")).dom.find((entry) => entry.name === "core.card.sidebar.fold");
    assert.ok(listed, "the card header fold control is not declared");
    const set = (await s.get("core.settings")).values.sets[0];
    for (const side of ["top", "left"]) await s.run("core.card.sidebar.set", { card: "terminal", side, set: set.id });
    await s.presented();
    const grid = await s.get("core.grid");
    const card = grid.cards.find((item) => item.id === "terminal");
    const header = { x: grid.plane.x + card.x, y: grid.plane.y + card.y, w: card.w, h: 32 };
    const controls = [];
    // The number of buttons in the head is the number of faces that all cards show.
    const shown = grid.cards.reduce((sum, item) => sum + Object.keys(item.sidebars).length, 0);
    for (let index = 0; index < shown; index++) {
      const rect = await s.rect("core.card.sidebar.fold", index);
      if (rect.x >= header.x && rect.x + rect.width <= header.x + header.w && rect.y >= header.y && rect.y + rect.height <= header.y + header.h) controls.push(rect);
    }
    assert.equal(controls.length, 2, `the terminal card header shows ${controls.length} fold controls for two sides`);
    const left = controls[1];
    await s.click(left.x + left.width / 2, left.y + left.height / 2);
    await s.until("core.grid", (value) => value.cards.find((item) => item.id === "terminal")?.sidebars.left?.collapsed === true,
      "the header control did not fold the left sidebar");
    await s.click(left.x + left.width / 2, left.y + left.height / 2);
    await s.until("core.grid", (value) => value.cards.find((item) => item.id === "terminal")?.sidebars.left?.collapsed === false,
      "the header control did not open the folded left sidebar again");
  });
}

for (const app of Object.values(APPS)) {
  // When a collapsed sidebar band and the card divider touch, the divider receives the gap and the sidebar receives the band inside the card
  // (docs/spec/example-model.md).
  test(`${app.name}: a folded sidebar strip next to a card divider keeps each input to its own control`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    // Splits the terminal card to the right so that two ordinary cards share a vertical boundary, and collapses the right sidebar of the left card.
    await s.run("core.card.split", { card: "terminal", side: "right", plugin: "terminal" });
    const set = (await s.get("core.settings")).values.sets[0];
    await s.run("core.card.sidebar.set", { card: "terminal", side: "right", set: set.id });
    const fold = async () => {
      await s.run("core.card.sidebar.toggle", { card: "terminal", side: "right" });
      await s.until("core.grid", (value) => value.cards.find((item) => item.id === "terminal").sidebars.right.collapsed === true,
        "the right sidebar did not fold");
      await s.presented();
    };
    await fold();
    const grid = await s.get("core.grid");
    const card = grid.cards.find((item) => item.id === "terminal");
    const edge = grid.plane.x + card.x + card.w;
    const y = grid.plane.y + card.y + card.h / 2;
    // The divider receives the area up to the outer border of the card (the gap), and the sidebar handle receives the collapsed band inside it. Pressing the band expands the sidebar.
    const press = async (x) => {
      const before = (await s.get("core.pointer")).sequence;
      await s.click(x, y);
      const pointer = await s.until("core.pointer", (value) => value.sequence > before && value.up !== null, `the press at ${x} did not arrive`);
      const open = (await s.get("core.grid")).cards.find((item) => item.id === "terminal").sidebars.right.collapsed === false;
      if (open) await fold();
      return [pointer.down, open];
    };
    const measured = {};
    for (const offset of [grid.gap / 2, 1, -0.5, -1.5, -3, -5]) measured[offset] = await press(edge + offset);
    assert.deepEqual(measured, {
      [grid.gap / 2]: ["core.divider", false], 1: ["core.divider", false], "-0.5": ["core.divider", false],
      "-1.5": ["core.card.sidebar.grip", true], "-3": ["core.card.sidebar.grip", true], "-5": ["core.card.sidebar.grip", true],
    }, `the gap and the folded strip do not keep their own input: ${JSON.stringify({ edge, gap: grid.gap, measured })}`);
  });
}
