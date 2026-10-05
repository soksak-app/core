// 고정 좌우 사이드바의 플러그인 오버라이드와 결합 보더를 실제 호스트 기록으로 검사한다.
import assert from "node:assert/strict";
import test from "node:test";
import { rmSync } from "node:fs";
import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";
import { turnOffCardSidebars } from "./card-sidebar-choices.mjs";
import { frames, readFrame, pixel } from "@soksak/window-check/frame.mjs";
import { railPixels } from "./rail.mjs";
const geometry = (grid) =>
  grid.cards.map(({ id, x, y, w, h }) => ({ id, x, y, w, h })).sort((a, b) => a.id.localeCompare(b.id));
function borders(frame, grid, cards) {
  const scale = frame.scale * frame.contentScale;
  for (const card of cards)
    for (const edge of [card.x, card.x + card.w - 1]) {
      const at = edge + grid.plane.x;
      assert.ok(
        [-0.5, 0, 0.5, 1].some((offset) =>
          [-24, -12, 12, 24].every((delta) => {
            const x = Math.floor(frame.content.x * frame.scale + (at + offset) * scale);
            const y = Math.floor(frame.content.y * frame.scale + (grid.plane.y + card.y + card.h / 2 + delta) * scale);
            return pixel(frame, x, y).every((value, index) => Math.abs(value - [43, 46, 61][index]) <= 3);
          }),
        ),
        `window sidebar ${card.id} lost its ${edge === card.x ? "left" : "right"} border at ${frame.time}ms`,
      );
    }
}
for (const app of Object.values(APPS))
  test(`${app.name}: fixed sidebars apply plugin overrides without extra columns`, { timeout: 90000 }, async (t) => {
    console.info(`START ${app.name}: fixed sidebar overrides`);
    const s = await open(t, app);
    assert.ok(s, "required host is not built");
    t.diagnostic(`tested endpoint: ${JSON.stringify(s.client.endpoint)}`);
    await fresh(s);
    await s.run("core.settings.theme", { name: "midnight", mode: "dark" });
    // 터미널 카드에 브라우저 탭을 더해 한 카드에 다른 플러그인의 탭을 둔다.
    const { tab: added } = await s.run("core.card.add-tab", { card: "terminal", plugin: "browser" });
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
      const bars = (await s.get("core.sidebars")).filter((bar) => bar.placement === "window");
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
        assert.ok(
          bar.sections.filter((section) => section.mounted).every((section) => section.text.length > 0),
          "selected sidebar output is empty",
        );
      }
      assert.deepEqual(
        (await s.get("core.verify")).rows.filter((row) => !row.ok),
        [],
      );
      assert.deepEqual((await s.get("core.page.audit")).unbound, []);
      return { grid, rail, plugin: tab.plugin, card: card.id };
    }
    const recording = await s.request("diagnostics.capture.start", {});
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
                grid.cards.find((item) => item.id === card.id)?.focused,
              "tab selection did not settle",
            );
            ({ displayed } = await s.presented());
            observations.push({ ...(await measure(card, tab)), displayed });
          }
      } finally {
        stop = await s.request("diagnostics.capture.stop", { after: displayed ? displayed + 100 : 0 });
      }
      assert.equal(stop.limited, false);
      assert.ok(stop.longestGap <= 100, `recording gap ${stop.longestGap}ms`);
      const captured = frames(recording.frames).map(readFrame);
      assert.ok(captured.length > 2, "incomplete focus/tab recording");
      assert.equal(captured.length, stop.count, "recorded and written frame counts differ");
      for (const frame of captured) borders(frame, baseline, windows);
      const final = captured.at(-1);
      railPixels(final, observations.at(-1).grid, observations.at(-1).rail);
      assert.ok(
        observations.some((item) => item.plugin === "terminal" && item.rail.groups.length === 0),
        "terminal selection did not remove plugin rail",
      );
      assert.ok(
        observations.some((item) => item.plugin === "browser" && item.rail.groups.length === 1),
        "browser override was not measured",
      );
      t.diagnostic(
        `fixed windows=${windows.map((card) => card.id)}; selections=${observations.map((item) => `${item.plugin}:${item.rail.groups.length}`)}; frames=${captured.length}; gap=${stop.longestGap}ms`,
      );
    } finally {
      rmSync(recording.frames, { recursive: true, force: true });
    }
  });

// 탭을 옮기거나 닫아도 고정 사이드바는 초점 카드의 활성 탭으로 문맥을 정하고, 자기 열을 옮기지 않는다.
for (const app of Object.values(APPS))
  test(
    `${app.name}: fixed sidebar context follows tab moves and removal without moving its column`,
    { timeout: 60000 },
    async (t) => {
      const s = await open(t, app);
      assert.ok(s, "required host is not built");
      await fresh(s);
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
                found &&
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
          // 목록 배치는 모든 섹션을, 탭 배치는 고른 탭의 섹션만 그린다(docs/spec/plugins.md).
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
      // 터미널 카드에 탭 하나를 더 둔다. 활성 탭을 옮겨도 카드가 남아 다른 플러그인의 탭이 문맥이 된다.
      const before = (await s.get("core.grid")).cards.find((card) => card.id === "terminal");
      const { tab: kept } = await s.run("core.card.add-tab", { card: "terminal", plugin: "browser" });
      s.cleanup(() => s.run("core.tab.close", { tab: kept }));
      await s.run("core.tab.select", { tab: before.active });
      await s.run("core.card.focus", { card: "terminal" });
      await expectContext("terminal focus");
      const terminal = (await s.get("core.grid")).cards.find((card) => card.id === "terminal");
      const moved = terminal.tabs.find((item) => item.id === terminal.active);
      await s.run("core.tab.move", { tab: moved.id, card: "browser", zone: "centre" });
      await expectContext("tab moved into the browser card");
      await s.run("core.card.focus", { card: "terminal" });
      await expectContext("terminal after the move");
      await s.run("core.tab.close", { tab: moved.id });
      await expectContext("moved tab closed");
      await s.run("core.card.focus", { card: "browser" });
      await expectContext("browser focus");
    },
  );
