// Checks the display geometry of card full screen and the restoration of the original layout through the public contract.
import assert from "node:assert/strict";
import test from "node:test";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { readPng } from "@soksak/window-check/png.mjs";
import { frames, readFrame, pixel } from "@soksak/window-check/frame.mjs";
import { APPS, judgeShownChanges, keepCommonSettings, open, owe } from "@soksak/window-check/app.mjs";
import { fresh, probeSidebarSets } from "./fixture.mjs";
import { tabElementIndex } from "./input-probe.mjs";

/** The card of the grid that holds the tab surface. */
const cardOf = (grid, surface) => grid.cards.find((item) => item.tabs?.some((tab) => tab.id === surface)).id;

async function clickFullscreen(t, s, card, expected) {
  const control = await s.rect("core.card.fullscreen", card.pane);
  const { frames: directory } = await s.request("diagnostics.capture.start", {});
  // The session removes the recording when the check passes and keeps it when the check fails.
  s.trackRecording(directory);
  let displayed = 0;
  let stopped;
  // The click toggles the full screen of the card: the recording owes frames from the click to the display of the full screen
  // (judgeShownChanges).
  const owed = [];
  try {
    const from = await owe(s);
    await s.click(control.x + control.width / 2, control.y + control.height / 2);
    await s.until("core.grid", grid => grid.fullscreen === expected, "fullscreen button did not toggle its card");
    ({ displayed } = await s.presented());
    owed.push({ from, to: displayed });
  } finally { stopped = await s.request("diagnostics.capture.stop", { after: displayed ? displayed + 100 : 0 }); }
  const captured = frames(directory).map(readFrame);
  assert.ok(captured.length > 1, "fullscreen click recording is incomplete");
  assert.equal(stopped.limited, false, "fullscreen recording reached its bounded buffer");
  judgeShownChanges(stopped, owed, { what: "fullscreen click" });
  const grid = await s.get("core.grid");
  const shown = grid.cards.find(item => item.id === card.id);
  const last = captured.at(-1);
  const ratio = last.scale * last.contentScale;
  const y = Math.floor((grid.plane.y + shown.y + shown.h / 2) * ratio);
  const edges = [];
  for (let x = Math.floor(grid.plane.x * ratio); x < Math.floor((grid.plane.x + grid.width) * ratio); x++) {
    const [r, g, b] = pixel(last, x, y);
    if (r > 140 && r > g + 35 && g > b + 15) edges.push(x / ratio);
  }
  assert.ok(edges.length >= 2, "recording has no measured focused card edges");
  assert.ok(Math.abs(edges[0] - (grid.plane.x + shown.x)) <= 1, `recorded left edge ${edges[0]}`);
  assert.ok(Math.abs(edges.at(-1) - (grid.plane.x + shown.x + shown.w)) <= 1, `recorded right edge ${edges.at(-1)}`);
  t.diagnostic(`fullscreen=${expected}: ${captured.length} frames, gap=${stopped.longestGap}ms, measured edges=${edges[0]},${edges.at(-1)}`);
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: card fullscreen fills the work area and restores live surfaces`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    t.diagnostic(`tested endpoint: ${JSON.stringify(s.client.endpoint)}`);
    const { plugin } = await fresh(s);
    const initial = await s.get("core.grid");
    const target = initial.cards.find((card) => card.tabs.some((tab) => tab.plugin === plugin));
    assert.ok(target, `no ${plugin} card for native fullscreen observation`);
    const tab = target.tabs.find((tab) => tab.plugin === plugin);
    await s.run("core.tab.select", { tab: tab.id });
    for (const side of ["top", "bottom", "left", "right"]) {
      await s.run("core.card.sidebar.set", { card: target.id, side, set: "off" });
    }
    await s.presented();
    const before = await s.get("core.grid");
    const beforeSurfaces = await s.get("core.surfaces");
    const windowBefore = await s.get("host.window");
    await clickFullscreen(t, s, target, target.id);
    const full = await s.get("core.grid");
    const shown = full.cards.find((card) => card.id === target.id);
    assert.equal(full.fullscreen, target.id);
    assert.equal(shown.fullscreen, true);
    assert.deepEqual([shown.x, shown.y, shown.w, shown.h], [0, 0, full.width, full.height]);
    for (const card of full.cards.filter((card) => card.id !== target.id)) {
      assert.equal(card.w * card.h, 0, `sibling card ${card.id} still has a presented area`);
    }
    const surfaces = await s.get("core.surfaces");
    assert.deepEqual(surfaces.map((surface) => surface.surface).sort(), beforeSurfaces.map((surface) => surface.surface).sort(),
      "fullscreen disposed a live sibling surface");
    assert.deepEqual(surfaces.filter((surface) => surface.visible).map((surface) => surface.surface), [tab.id]);
    const nativeFacts = (await s.get("host.window")).surfaces.filter(surface => surface.visible);
    assert.equal(nativeFacts.length, 1, "fullscreen left sibling native views visible");
    assert.equal(nativeFacts[0].id, tab.id, "fullscreen presented the wrong native view");
    const native = surfaces.find((surface) => surface.surface === tab.id);
    assert.ok(Math.abs(native.applied.w - (shown.w - 2)) <= 1, `native fullscreen width: ${JSON.stringify(native)}`);
    assert.ok(Math.abs(native.applied.h - (shown.h - 56)) <= 1, `native fullscreen height: ${JSON.stringify(native)}`);
    const icon = await s.rect("core.card.fullscreen", shown.pane);
    const close = await s.rect("core.card.close", shown.pane);
    assert.ok(icon.x + icon.width <= close.x && icon.y === close.y, "fullscreen icon does not precede close X");
    // A pressed toggle is drawn with the focus color (--focus), like the toggle in the window head. The close icon beside it does not have that color.
    const still = (await s.request("diagnostics.capture.still", {})).path;
    const image = readPng(still);
    rmSync(dirname(still), { recursive: true, force: true });
    const ratio = image.width / (await s.get("host.window")).content.width;
    const focus = [255, 179, 107];
    const focusInk = (rect) => {
      let count = 0;
      for (let x = Math.ceil(rect.x * ratio); x < Math.floor((rect.x + rect.width) * ratio); x++) {
        for (let y = Math.ceil(rect.y * ratio); y < Math.floor((rect.y + rect.height) * ratio); y++) {
          if (image.pixel(x, y).slice(0, 3).every((value, index) => Math.abs(value - focus[index]) <= 40)) count++;
        }
      }
      return count;
    };
    assert.ok(focusInk(icon) > 0 && focusInk(close) === 0,
      `the pressed fullscreen toggle is not drawn in the focus color: icon ${focusInk(icon)} px, close ${focusInk(close)} px`);
    assert.deepEqual((await s.get("core.workbench.audit")).unbound, []);
    assert.deepEqual((await s.get("host.window")).frame, windowBefore.frame, "card fullscreen changed the OS window");
    await assert.rejects(s.run("core.card.fullscreen", { card: "missing-card" }), /no card/);
    assert.equal((await s.get("core.grid")).fullscreen, target.id);
    await assert.rejects(s.run("core.tab.move", { tab: "missing-tab", card: target.id, zone: "centre" }), /no tab/);
    await s.presented();
    assert.equal((await s.get("core.grid")).fullscreen, target.id, "an invalid tab move changed fullscreen presentation");
    const content = windowBefore.content;
    try {
      await s.run("host.window.resize", { width: content.width - 100, height: content.height - 60 });
      await s.until("core.grid", grid => grid.width < full.width && grid.height < full.height,
        "fullscreen layout did not follow the smaller window");
      await s.presented();
      const resized = await s.get("core.grid");
      const resizedCard = resized.cards.find(card => card.id === target.id);
      assert.equal(resized.fullscreen, target.id);
      assert.deepEqual([resizedCard.x, resizedCard.y, resizedCard.w, resizedCard.h], [0, 0, resized.width, resized.height]);
      const resizedNative = (await s.get("core.surfaces")).find(surface => surface.surface === tab.id);
      assert.ok(Math.abs(resizedNative.applied.w - (resizedCard.w - 2)) <= 1);
      assert.ok(Math.abs(resizedNative.applied.h - (resizedCard.h - 56)) <= 1);
    } finally {
      await s.run("host.window.resize", { width: content.width, height: content.height });
      await s.until("core.grid", grid => grid.width === full.width && grid.height === full.height,
        "fullscreen layout did not follow the restored window");
      await s.presented();
    }
    await clickFullscreen(t, s, shown, null);
    const restored = await s.get("core.grid");
    assert.equal(restored.fullscreen, null);
    assert.deepEqual(restored.cards.map(({ id, x, y, w, h, tabs, active, sidebars }) => ({ id, x, y, w, h, tabs, active, sidebars })),
      before.cards.map(({ id, x, y, w, h, tabs, active, sidebars }) => ({ id, x, y, w, h, tabs, active, sidebars })));
    const restoredSurfaces = await s.get("core.surfaces");
    for (const surface of beforeSurfaces) {
      const current = restoredSurfaces.find((item) => item.surface === surface.surface);
      assert.equal(current.visible, surface.visible);
      assert.deepEqual(current.applied, surface.applied, `surface ${surface.surface} did not restore its native geometry`);
    }
    const sibling = before.cards.find(card => card.id !== target.id && card.active);
    assert.ok(sibling, "no sibling card for selection restoration");
    await s.run("core.card.fullscreen", { card: target.id });
    await s.presented();
    await s.run("core.tab.select", { tab: sibling.active });
    await s.presented();
    assert.equal((await s.get("core.grid")).fullscreen, null, "selecting another card left fullscreen active");
  });
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: sidebar settings apply to fullscreen and restored cards`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    const { plugin } = await fresh(s);
    await keepCommonSettings(s);
    const originalLinks = (await s.get("core.settings")).values.links;
    const observations = await s.collect("core.verify");
    s.cleanup(() => observations.stop());
    const target = (await s.get("core.grid")).cards.find(card => card.tabs.some(tab => tab.plugin === plugin));
    assert.ok(target);
    const tab = target.tabs.find(tab => tab.plugin === plugin);
    await s.run("core.tab.select", { tab: tab.id });
    for (const side of ["top", "bottom", "left", "right"]) {
      await s.run("core.card.sidebar.set", { card: target.id, side, set: "inherit" });
    }
    // The sets of the configuration take the sections of the layout probe, so a set and the sections that it shows are the same.
    const stored = await probeSidebarSets(s);
    const sets = ["list", "tabs"].map(layout => stored.find(set => set.layout === layout));
    await s.run("core.card.fullscreen", { card: target.id });
    for (const [mode, set] of [["fullscreen", sets[0]], ["restored", sets[1]]]) {
      if (mode === "restored") await s.run("core.card.fullscreen", { card: target.id });
      await s.run("core.settings.link", { place: "card-left", plugin, set: set.id, scope: "common" });
      await s.presented();
      const settings = await s.get("core.settings");
      const grid = await s.get("core.grid");
      const card = grid.cards.find(card => card.id === target.id);
      const region = (await s.get("core.sidebars")).find(sidebar => sidebar.sidebar === `${target.id}:left`);
      const native = (await s.get("core.surfaces")).find(surface => surface.surface === tab.id);
      assert.ok(settings.values.links.some(link => link.place === "card-left" && link.plugin === plugin && link.set === set.id), `${mode}: setting was not saved`);
      assert.equal(grid.fullscreen, mode === "fullscreen" ? target.id : null);
      assert.equal(card.sidebars.left?.set, set.id, `${mode}: card did not adopt its settings`);
      assert.equal(region?.set, set.id, `${mode}: sections did not redraw`);
      assert.deepEqual(region.sections.map(section => section.id), set.sections, `${mode}: section DOM differs from saved set`);
      const expected = card.w - card.sidebars.left.size - 2;
      assert.ok(Math.abs(native.applied.w - expected) <= 1, `${mode}: native width ${native.applied.w}, expected ${expected}`);
      t.diagnostic(`${mode}: saved=${set.id}, effective=${card.sidebars.left.set}, drawn=${region.set}, nativeWidth=${native.applied.w}, cardWidth=${card.w}`);
      const verification = await s.get("core.verify");
      assert.deepEqual(verification.rows.filter(row => !row.ok), [], `${mode}: layout verification failed`);
    }
    await s.run("core.settings.set", { patch: { links: originalLinks }, scope: "common" });
    await s.presented();
    const failures = observations.values.flatMap(value => value?.rows ?? []).filter(row => !row.ok);
    assert.deepEqual(failures, [], "setting changes produced an intermediate placement failure");
  });
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: a native click on another tab of a fullscreen card switches the tab and keeps fullscreen`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    const { surface, plugin } = await fresh(s);
    const own = cardOf(await s.get("core.grid"), surface);
    await s.run("core.card.add-tab", { card: own, plugin });
    const added = await s.until("core.grid", grid => grid.cards.find(item => item.id === own)?.tabs.length === 2,
      "the second tab did not appear");
    const card = added.cards.find(item => item.id === own);
    const other = card.tabs.find(tab => tab.id !== card.active);
    await s.run("core.card.fullscreen", { card: own });
    await s.until("core.grid", grid => grid.fullscreen === own, "the card did not become fullscreen");
    const recording = await s.record();
    let displayed = 0;
    let stopped;
    // Each click selects the other tab of the card: the recording owes frames from the click to the display of the tab
    // (judgeShownChanges).
    const owed = [];
    try {
      for (const selected of [other.id, card.active]) {
        // The tab elements are numbered across every card in the order of core.grid, the hidden cards of fullscreen too.
        const rect = await s.rect("core.card.tab", tabElementIndex(added, selected));
        const from = await owe(s);
        await s.click((rect.document?.x ?? 0) + rect.x + rect.width / 2,
          (rect.document?.y ?? 0) + rect.y + rect.height / 2);
        await s.until("core.grid", grid => grid.cards.find(item => item.id === own).active === selected,
          "the click did not switch the tab");
        ({ displayed } = await s.presented());
        owed.push({ from, to: displayed });
        const after = await s.get("core.grid");
        assert.equal(after.fullscreen, own, "the tab click left fullscreen");
        const visible = (await s.get("host.window")).surfaces.filter(surface => surface.visible);
        assert.deepEqual(visible.map(surface => surface.id), [selected],
          "presentation completed without the selected native view");
        assert.ok(visible[0].frame.width > 0 && visible[0].frame.height > 0,
          "the selected native view has no presented area");
      }
    } finally { stopped = await recording.stop({ after: displayed ? displayed + 100 : 0 }); }
    const captured = frames(recording.frames).map(readFrame);
    assert.equal(captured.length, stopped.count, "tab recording has missing frame files");
    assert.ok(captured.length > 1, "tab switching recording is incomplete");
    assert.equal(stopped.limited, false, "tab recording reached its bounded buffer");
    judgeShownChanges(stopped, owed, { what: "tab click" });
    t.diagnostic(`two tab presentation waits completed: ${captured.length} decoded frames`);
    await s.run("core.card.fullscreen", { card: own });
    await s.until("core.grid", grid => grid.fullscreen === null, "fullscreen did not end");
  });
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: a fullscreen card disables the tools that change the layout and refuses their commands`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    const { surface, plugin } = await fresh(s);
    const own = cardOf(await s.get("core.grid"), surface);
    await s.run("core.card.fullscreen", { card: own });
    s.cleanup(async () => {
      if ((await s.get("core.grid")).fullscreen !== null) await s.run("core.card.fullscreen", { card: own });
    });
    const grid = await s.until("core.grid", (value) => value.fullscreen === own, "the card did not become fullscreen");
    const acts = grid.cards.find((item) => item.id === own).acts;
    const enabled = Object.fromEntries(Object.entries(acts).filter(([, value]) => typeof value === "object").map(([key, value]) => [key, value.enabled]));
    assert.deepEqual(enabled, { add: false, "split-x": false, "split-y": false, fullscreen: true, close: false },
      `the tools of the fullscreen card: ${JSON.stringify(acts)}`);
    const refusal = new RegExp(`card ${own}: the layout does not change while card ${own} is fullscreen; restore the arrangement first`);
    await assert.rejects(s.run("core.card.split", { card: own, side: "right", plugin }), refusal);
    await assert.rejects(s.run("core.card.add-tab", { card: own, plugin }), refusal);
    await assert.rejects(s.run("core.card.close", { card: own }), refusal);
    assert.equal((await s.get("core.grid")).fullscreen, own, "a refused command left fullscreen");
  });
}
