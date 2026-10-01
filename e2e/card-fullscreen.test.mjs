// 카드 전체 화면의 표시 기하와 원래 배치 복원을 공개 계약으로 검사한다.
import assert from "node:assert/strict";
import test from "node:test";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { readPng } from "./png.mjs";
import { frames, readFrame, pixel } from "./frame.mjs";
import { APPS, fresh, keepCommonSettings, open } from "./app.mjs";

async function clickFullscreen(t, s, card, expected) {
  const control = await s.rect("core.card.fullscreen", card.pane);
  const { frames: directory } = await s.request("diagnostics.capture.start", {});
  try {
    let displayed = 0;
    let stopped;
    try {
      await s.click(control.x + control.width / 2, control.y + control.height / 2);
      await s.until("core.grid", grid => grid.fullscreen === expected, "fullscreen button did not toggle its card");
      ({ displayed } = await s.presented());
    } finally { stopped = await s.request("diagnostics.capture.stop", { after: displayed ? displayed + 100 : 0 }); }
    const captured = frames(directory).map(readFrame);
    assert.ok(captured.length > 1, "fullscreen click recording is incomplete");
    assert.equal(stopped.limited, false, "fullscreen recording reached its bounded buffer");
    assert.ok(stopped.longestGap <= 100, `fullscreen recording gap ${stopped.longestGap}ms`);
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
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: card fullscreen fills the work area and restores live surfaces`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    assert.ok(s, `${app.binary} is not built`);
    t.diagnostic(`tested endpoint: ${JSON.stringify(s.client.endpoint)}`);
    await fresh(s);
    const initial = await s.get("core.grid");
    const target = initial.cards.find((card) => card.tabs.some((tab) => tab.plugin === "terminal"));
    assert.ok(target, "no terminal card for native fullscreen observation");
    const tab = target.tabs.find((tab) => tab.plugin === "terminal");
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
    // 눌린 토글은 창 머리의 토글처럼 초점 색(--focus)으로 그린다. 옆의 닫기 아이콘은 그 색이 아니다.
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
    assert.deepEqual((await s.get("core.page.audit")).unbound, []);
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
    assert.ok(s, `${app.binary} is not built`);
    await fresh(s);
    await keepCommonSettings(s);
    const originalLinks = (await s.get("core.settings")).values.links;
    const observations = await s.collect("core.verify");
    s.cleanup(() => observations.stop());
    const target = (await s.get("core.grid")).cards.find(card => card.tabs.some(tab => tab.plugin === "terminal"));
    assert.ok(target);
    const tab = target.tabs.find(tab => tab.plugin === "terminal");
    await s.run("core.tab.select", { tab: tab.id });
    for (const side of ["top", "bottom", "left", "right"]) {
      await s.run("core.card.sidebar.set", { card: target.id, side, set: "inherit" });
    }
    const sets = (await s.get("core.settings")).values.sets;
    assert.ok(sets.length >= 2, "two distinct section sets are required");
    await s.run("core.card.fullscreen", { card: target.id });
    for (const [mode, set] of [["fullscreen", sets[0]], ["restored", sets[1]]]) {
      if (mode === "restored") await s.run("core.card.fullscreen", { card: target.id });
      await s.run("core.settings.link", { place: "card-left", plugin: "terminal", set: set.id, scope: "common" });
      await s.presented();
      const settings = await s.get("core.settings");
      const grid = await s.get("core.grid");
      const card = grid.cards.find(card => card.id === target.id);
      const region = (await s.get("core.sidebars")).find(sidebar => sidebar.sidebar === `${target.id}:left`);
      const native = (await s.get("core.surfaces")).find(surface => surface.surface === tab.id);
      assert.ok(settings.values.links.some(link => link.place === "card-left" && link.plugin === "terminal" && link.set === set.id), `${mode}: setting was not saved`);
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
