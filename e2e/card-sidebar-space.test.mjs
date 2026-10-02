// 공간 조건, 수동 접힘과 세트 조합의 실제 표시·저장·녹화 좌표를 검사한다.
import assert from "node:assert/strict";
import test from "node:test";
import { rmSync } from "node:fs";
import { APPS, fresh, open } from "./app.mjs";
import { requireFullWidth } from "./card-panel-checks.mjs";
import { frames, readFrame, pixel } from "./frame.mjs";
const sides = ["top", "bottom", "left", "right"];
const near = (a, b, label) => assert.ok(Math.abs(a - b) <= 1, `${label}: actual ${a}, expected ${b}`);
/**
 * 명세(docs/spec/example-model.md)대로 계산한 한 카드의 표시: 면마다 { shown, auto }. 축의 공간은 카드 크기에서
 * 테두리 2, (높이는) 머리와 발 54, 내용 최소 96, 선택으로 접은 면의 손잡이 6 을 뺀 값이다. last 는 축마다 마지막으로
 * 조작한 면이다.
 */
function expectedPresentation(card, choices, last) {
  const result = {};
  for (const [axis, pair] of [["width", ["left", "right"]], ["height", ["top", "bottom"]]]) {
    const chosen = pair.filter((side) => choices[side].collapsed);
    const open = pair.filter((side) => !choices[side].collapsed);
    const room = (axis === "width" ? card.w - 2 : card.h - 2 - 54) - 96 - chosen.length * 6;
    const total = open.reduce((sum, side) => sum + choices[side].size, 0);
    const shown = {};
    if (total <= room) for (const side of open) shown[side] = choices[side].size;
    else if (open.every((side) => choices[side].size * room / total >= 120))
      for (const side of open) shown[side] = choices[side].size * room / total;
    else {
      const first = open.includes(last[axis]) ? last[axis] : open[0];
      const alone = Math.min(choices[first].size, room - (open.length - 1) * 6);
      if (alone >= 120) shown[first] = alone;
    }
    for (const side of pair) result[side] = { shown: shown[side] ?? null, auto: !choices[side].collapsed && !(side in shown) };
  }
  return result;
}
function recorded(frame, rect) {
  const scale = frame.scale * frame.contentScale;
  const sample = (x, y) =>
    pixel(
      frame,
      Math.floor(frame.content.x * frame.scale + x * scale),
      Math.floor(frame.content.y * frame.scale + y * scale),
    );
  // 축소된 1포인트 선은 인접 배경과 혼합된다. 손잡이 중앙 표시를 제외하고 선의 혼합 비율을 검사한다.
  const edge = (vertical, coordinate, cross) =>
    [-1, -0.5, 0, 0.5, 1].some((offset) =>
      [-24, -18, -12, 12, 18, 24].every((delta) => {
        const x = vertical ? coordinate + offset : cross + delta,
          y = vertical ? cross + delta : coordinate + offset;
        const rgb = sample(x, y),
          before = sample(x - (vertical ? 4 : 0), y - (vertical ? 0 : 4)),
          after = sample(x + (vertical ? 4 : 0), y + (vertical ? 0 : 4));
        const background = before.map((value, index) => (value + after[index]) / 2),
          target = [43, 46, 61];
        const contrast = target.map((value, index) => value - background[index]);
        const norm = contrast.reduce((sum, value) => sum + value * value, 0);
        if (norm < 25) return false;
        const alpha = rgb.reduce((sum, value, index) => sum + (value - background[index]) * contrast[index], 0) / norm;
        return (
          alpha >= 0.35 &&
          alpha <= 1.2 &&
          rgb.every((value, index) => Math.abs(value - background[index] - alpha * contrast[index]) <= 3)
        );
      }),
    );
  return [
    edge(true, rect.x - 1, rect.y + rect.h / 2),
    edge(true, rect.x + rect.w, rect.y + rect.h / 2),
    edge(false, rect.y - 1, rect.x + rect.w / 2),
  ];
}
for (const app of Object.values(APPS))
  test(
    `${app.name}: card sidebar space conditions preserve manual choices through size and fullscreen changes`,
    { timeout: 120000 },
    async (t) => {
      console.info(`START ${app.name}: sidebar space acceptance`);
      const s = await open(t, app);
      assert.ok(s, "required host is not built");
      t.diagnostic(`tested endpoint: ${JSON.stringify(s.client.endpoint)}`);
      await fresh(s);
      await s.run("core.settings.theme", { name: "midnight", mode: "dark" });
      const card = (await s.get("core.grid")).cards.find((c) => c.tabs.some((tab) => tab.plugin === "terminal"));
      assert.ok(card, "terminal card absent");
      await s.run("core.tab.select", { tab: card.tabs.find((tab) => tab.plugin === "terminal").id });
      const settings = (await s.get("core.settings")).values;
      const original = settings.sets.find(
        (set) => set.sections.includes("files.tree") && set.sections.includes("files.bookmarks"),
      );
      assert.ok(original, "file set absent");
      const sets = [
        ...settings.sets,
        { ...original, id: "space-list", title: "Space list", layout: "list" },
        { ...original, id: "space-tabs", title: "Space tabs", layout: "tabs" },
      ];
      await s.run("core.settings.set", { patch: { sets }, scope: "common" });
      const choices = Object.fromEntries(
        sides.map((side) => [
          side,
          { set: side === "right" ? "space-tabs" : "space-list", size: 120, collapsed: false },
        ]),
      );
      // 축마다 마지막으로 조작한 면. 두 면이 함께 들어가지 않을 때 그 면이 열린다.
      const last = {};
      for (const side of sides) {
        await s.run("core.card.sidebar.set", { card: card.id, side, set: choices[side].set });
        await s.run("core.card.sidebar.size", { card: card.id, side, size: 120 });
        last[side === "left" || side === "right" ? "width" : "height"] = side;
      }
      const windowCards = (await s.get("core.grid")).cards
        .filter((item) => item.tabs.length === 0)
        .map((item) => item.id)
        .sort();
      // 녹화는 창의 장치 픽셀 크기를 따라가므로 현재 크기에서 시작한다(docs/spec/endpoint.md).
      await s.presented();
      let recordingStopped = false;
      let recording = await s.request("diagnostics.capture.start", {});
      const audit = await s.collect("core.verify");
      const errors = [];
      let displayed;
      async function check(label) {
        const began = performance.now();
        console.info(`START ${app.name}: ${label}`);
        ({ displayed } = await s.presented());
        const host = await s.get("host.window");
        assert.equal(host.active, false);
        assert.equal(host.occluded, false);
        const grid = await s.get("core.grid");
        const current = grid.cards.find((item) => item.id === card.id);
        assert.deepEqual(
          grid.cards
            .filter((item) => item.tabs.length === 0)
            .map((item) => item.id)
            .sort(),
          windowCards,
          `${label}: configured external columns changed`,
        );
        t.diagnostic(
          `${label}: window ${host.content.width}x${host.content.height}, card ${current.w}x${current.h}, saved requests ${JSON.stringify(choices)}, presentation ${JSON.stringify(current.sidebars)}`,
        );
        const layout = await s.get("core.layout");
        const saved = layout.state.cards.find((item) => item.id === card.id).data.sidebars;
        const bars = await s.until(
          "core.sidebars",
          (all) =>
            sides.every((side) => {
              const bar = all.find((item) => item.sidebar === `${card.id}:${side}`);
              return (
                bar &&
                bar.sections.every(
                  (section) =>
                    section.error === null &&
                    (bar.layout === "tabs" ? section.mounted === (section.id === bar.tab) : section.mounted),
                )
              );
            }),
          `${label}: section modules did not settle`,
        );
        const bands = {};
        const expectedShown = expectedPresentation(current, choices, last);
        let sectionIndex = 0;
        for (const [barIndex, bar] of bars.entries()) {
          const offset = sectionIndex;
          sectionIndex += bar.sections.length;
          if (!bar.sidebar.startsWith(`${card.id}:`)) continue;
          const side = bar.sidebar.slice(card.id.length + 1),
            state = current.sidebars[side];
          // 펼친 top 과 bottom 패널은 카드의 안쪽 폭 전체를 차지한다.
          if ((side === "top" || side === "bottom") && !state.collapsed) {
            requireFullWidth(await s.rect("core.sidebar", barIndex), current, 1, `${label}: ${side}`);
          }
          const autoCollapsed = expectedShown[side].auto;
          if (expectedShown[side].shown !== null) near(state.shownSize, expectedShown[side].shown, `${label}: ${side} shown size`);
          assert.deepEqual(
            {
              set: state.set,
              size: state.size,
              requestedCollapsed: state.requestedCollapsed,
              autoCollapsed: state.autoCollapsed,
              collapsed: state.collapsed,
              collapseReason: state.collapseReason,
            },
            {
              ...choices[side],
              requestedCollapsed: choices[side].collapsed,
              autoCollapsed,
              collapsed: choices[side].collapsed || autoCollapsed,
              collapseReason: autoCollapsed
                ? `insufficient-${side === "left" || side === "right" ? "width" : "height"}`
                : null,
            },
            `${label}: ${side} presentation`,
          );
          assert.equal(saved[side].set, choices[side].set);
          assert.equal(saved[side].size, choices[side].size);
          assert.equal(Object.hasOwn(saved[side], "autoCollapsed"), false, "automatic presentation was saved");
          if (choices[side].collapsed) assert.equal(saved[side].collapsed, true);
          else
            assert.ok(
              !Object.hasOwn(saved[side], "collapsed") || saved[side].collapsed === false,
              "automatic fold changed user choice",
            );
          bands[side] = state.collapsed ? 6 : state.shownSize;
          for (let i = 0; i < bar.sections.length; i++) {
            const box = await s.rect("core.sidebar.section", offset + i);
            const visible = !state.collapsed && (bar.layout === "list" || bar.sections[i].id === bar.tab);
            if (visible)
              assert.ok(
                box.width > 0 && box.height > 0,
                `${label} ${side}: visible section has no area ${JSON.stringify(box)}`,
              );
            else
              assert.ok(
                box.width === 0 && box.height === 0,
                `${label} ${side}: folded/unselected section remains visible`,
              );
          }
        }
        const surface = (await s.surfaces()).find((item) => item.surface === current.active);
        assert.ok(surface?.applied, "native surface absent");
        const expected = {
          x: grid.plane.x + current.x + 1 + bands.left,
          y: grid.plane.y + current.y + 33 + bands.top,
          w: current.w - 2 - bands.left - bands.right,
          h: current.h - 56 - bands.top - bands.bottom,
        };
        for (const key of Object.keys(expected)) near(surface.applied[key], expected[key], `${label} native ${key}`);
        assert.ok(surface.applied.w >= 96 && surface.applied.h >= 96, `${label}: content minimum not retained`);
        ({ displayed } = await s.presented());
        const stop = await s.request("diagnostics.capture.stop", { after: displayed + 100 });
        recordingStopped = true;
        assert.equal(stop.limited, false);
        assert.ok(stop.longestGap <= 100, `missing frames: ${stop.longestGap}ms`);
        const captured = frames(recording.frames).map(readFrame);
        assert.ok(captured.length > 4, "incomplete recording");
        assert.ok(
          recorded(captured.at(-1), surface.applied).every(Boolean),
          `${label}: measured native borders are absent from recording ${JSON.stringify(surface.applied)}`,
        );
        t.diagnostic(`${label}: ${captured.length} frames, maximum gap ${stop.longestGap}ms`);
        rmSync(recording.frames, { recursive: true, force: true });
        recording = null;
        t.diagnostic(`${label}: ${JSON.stringify(surface.applied)}, bands ${JSON.stringify(bands)}`);
        console.info(`PASS ${app.name}: ${label} (${Math.round(performance.now() - began)}ms)`);
      }
      try {
        await s.run("host.window.resize", { width: 1200, height: 754 });
        await s.until("host.window", (window) => window.content.height === 754, "window did not reach short height");
        await check("short normal");
        // 작은 창에서 녹화를 시작하고 큰 창으로 바뀌는 전환을 기록한다.
        recording = await s.request("diagnostics.capture.start", {});
        recordingStopped = false;
        await s.run("host.window.resize", { width: 1200, height: 880 });
        await s.until("host.window", (window) => window.content.height === 880, "window did not grow");
        await check("tall normal");
        recording = await s.request("diagnostics.capture.start", {});
        recordingStopped = false;
        for (const side of ["left", "right"]) {
          await s.run("core.card.sidebar.size", { card: card.id, side, size: 480 });
          choices[side].size = 480;
          last.width = side;
        }
        await check("wide sidebars normal");
        recording = await s.request("diagnostics.capture.start", {});
        recordingStopped = false;
        await s.run("core.card.fullscreen", { card: card.id });
        await check("wide sidebars fullscreen");
        recording = await s.request("diagnostics.capture.start", {});
        recordingStopped = false;
        await s.run("core.card.fullscreen", { card: card.id });
        await check("wide sidebars restored");
        recording = await s.request("diagnostics.capture.start", {});
        recordingStopped = false;
        // 왼쪽이 열려 보이면 클릭은 접힘을 저장한다. 접혀 보이면 펼침을 저장하므로 먼저 보이는 상태를 확인한다.
        const leftShown = (await s.get("core.grid")).cards.find((item) => item.id === card.id).sidebars.left;
        assert.equal(leftShown.collapsed, false, "the left panel must be shown open before the manual fold");
        await s.run("core.card.sidebar.toggle", { card: card.id, side: "left" });
        choices.left.collapsed = true;
        last.width = "left";
        // 접은 왼쪽은 divider 폭(6)만 쓰므로 762pt 카드에서 내용 폭은 762 - 2(경계) - 6 - 480 = 274pt 로 최소
        // 96pt 보다 크다. 오른쪽 요청은 공간이 충분하여 자동으로 접히지 않는다(docs/spec/example-model.md).
        await check("manual left fold");
        recording = await s.request("diagnostics.capture.start", {});
        recordingStopped = false;
        await s.run("host.window.resize", { width: 1220, height: 880 });
        await s.until("host.window", (window) => window.content.width === 1220, "window did not reach wider width");
        await check("manual fold wider normal");
        recording = await s.request("diagnostics.capture.start", {});
        recordingStopped = false;
        await s.run("core.card.fullscreen", { card: card.id });
        await check("manual fold fullscreen");
        recording = await s.request("diagnostics.capture.start", {});
        recordingStopped = false;
        await s.run("core.card.fullscreen", { card: card.id });
        await s.run("host.window.resize", { width: 1200, height: 754 });
        await s.until("host.window", (window) => window.content.height === 754, "window did not restore height");
        // 폭은 manual left fold 와 같으므로 오른쪽은 펼쳐지고, 높이만 부족하다.
        await check("manual fold short restore");
      } catch (error) {
        errors.push(error);
      } finally {
        if (recording) {
          try {
            if (!recordingStopped)
              await s.request("diagnostics.capture.stop", { after: displayed === undefined ? 0 : displayed + 100 });
          } catch (error) {
            errors.push(error);
          }
          try {
            rmSync(recording.frames, { recursive: true, force: true });
          } catch (error) {
            errors.push(error);
          }
        }
        try {
          for (const value of await audit.stop()) {
            assert.ok(value && Array.isArray(value.rows), "invalid verification notification");
            assert.deepEqual(
              value.rows.filter((row) => !row.ok),
              [],
            );
          }
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length) throw new AggregateError(errors, "sidebar space acceptance failed");
    },
  );
