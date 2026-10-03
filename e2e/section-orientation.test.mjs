// 선언된 섹션 방향·출력과 실제 DOM·네이티브 좌표를 전체화면과 복귀 상태에서 검사한다.
import assert from "node:assert/strict";
import test from "node:test";
import { rmSync } from "node:fs";
import { frames, readFrame, pixel } from "./frame.mjs";
import { APPS, fresh, open } from "./app.mjs";

for (const app of Object.values(APPS))
  test(
    `${app.name}: section orientations and output follow card sides in fullscreen and restore`,
    { timeout: 120000 },
    async (t) => {
      const s = await open(t, app);
      assert.ok(s, "required host is not built");
      t.diagnostic(`tested endpoint: ${JSON.stringify(s.client.endpoint)}`);
      await fresh(s);
      await s.run("core.settings.theme", { name: "midnight", mode: "dark" });
      const card = (await s.get("core.grid")).cards.find((c) => c.tabs.some((tab) => tab.plugin === "terminal"));
      assert.ok(card, "terminal card is absent");
      await s.run("core.tab.select", { tab: card.tabs.find((tab) => tab.plugin === "terminal").id });
      const set = (await s.get("core.settings")).values.sets.find(
        (v) => v.sections.includes("files.tree") && v.sections.includes("files.bookmarks"),
      );
      assert.ok(set, "the declared file section set is absent");
      for (const side of ["top", "bottom", "left", "right"]) {
        await s.run("core.card.sidebar.set", { card: card.id, side, set: set.id });
        await s.run("core.card.sidebar.size", { card: card.id, side, size: 120 });
      }
      await s.presented();
      const initialGrid = await s.get("core.grid");
      const initialCard = initialGrid.cards.find((c) => c.id === card.id);
      const initialNative = (await s.surfaces()).find((v) => v.surface === initialCard.active).applied;
      const capture = await s.request("diagnostics.capture.start", {});
      const audit = await s.collect("core.verify");
      const failures = [];
      const measured = [initialNative];
      let displayed;
      try {
        for (const fullscreen of [true, false]) {
          const state = await s.get("host.window");
          assert.equal(state.active, false, `the application is active before the fullscreen click: ${JSON.stringify({ active: state.active, key: state.key })}`);
          assert.equal(state.occluded, false, "the window is occluded before the fullscreen click");
          const button = await s.rect("core.card.fullscreen", initialCard.pane);
          await s.click(button.x + button.width / 2, button.y + button.height / 2);
          ({ displayed } = await s.presented());
          await s.until(
            "core.sidebars",
            (all) =>
              ["top", "bottom", "left", "right"].every((side) => {
                const sidebar = all.find((item) => item.sidebar === `${card.id}:${side}`);
                return sidebar && sidebar.sections.every((section) => section.mounted && section.error === null);
              }),
            "all orientation implementations did not mount",
          );
          const grid = await s.get("core.grid");
          const current = grid.cards.find((c) => c.id === card.id);
          const all = await s.get("core.sidebars");
          let sectionIndex = 0;
          for (let index = 0; index < all.length; index++) {
            const sidebar = all[index];
            const offset = sectionIndex;
            sectionIndex += sidebar.sections.length;
            if (!sidebar.sidebar.startsWith(`${card.id}:`)) continue;
            const side = sidebar.sidebar.slice(card.id.length + 1);
            const orientation = side === "top" || side === "bottom" ? "horizontal" : "vertical";
            assert.equal(sidebar.orientation, orientation);
            assert.ok(sidebar.sections.find((v) => v.id === "files.bookmarks").text.includes("북마크 없음"));
            const boxes = [];
            for (let i = 0; i < sidebar.sections.length; i++)
              boxes.push(await s.rect("core.sidebar.section", offset + i));
            const presentation = current.sidebars[side];
            assert.equal(presentation.requestedCollapsed, false, "automatic folding changed the user choice");
            // 일반 카드 높이에는 위와 아래가 함께 들어가지 않으므로 한 면만 들어가는 크기로 열리고 다른 면은 접힌다. 어느
            // 면이 열리는지는 그 카드에서 마지막으로 조작한 면이 정하므로(docs/spec/example-model.md) 열린 면을 표시에서 읽는다.
            const opposite = current.sidebars[side === "top" ? "bottom" : "top"];
            const autoCollapsed = !fullscreen && (side === "top" || side === "bottom") && !opposite.autoCollapsed;
            assert.equal(presentation.autoCollapsed, autoCollapsed, `${side} automatic folding: ${JSON.stringify(presentation)}`);
            assert.equal(presentation.collapsed, autoCollapsed, `${side} folding: ${JSON.stringify(presentation)}`);
            assert.equal(presentation.collapseReason, autoCollapsed ? "insufficient-height" : null);
            if (presentation.collapsed) {
              assert.ok(
                boxes.every((rect) => rect.width === 0 && rect.height === 0),
                "folded section remains visible",
              );
              t.diagnostic(`restored ${side}: automatically folded for insufficient height`);
              continue;
            }
            const [first, second] = boxes;
            assert.ok(
              first.width > 0 && first.height > 0 && second.width > 0 && second.height > 0,
              `${fullscreen ? "fullscreen" : "restored"} ${side}: section has no area: ${JSON.stringify(boxes)}`,
            );
            if (orientation === "horizontal") {
              assert.ok(second.x >= first.x + first.width - 1, "horizontal sections overlap or remain stacked");
              assert.ok(Math.abs(first.y - second.y) <= 1, "horizontal section tops differ");
              assert.ok(Math.abs(first.height - second.height) <= 1, "horizontal section heights differ");
            } else assert.ok(second.y >= first.y + first.height - 1, "vertical sections overlap or lie side by side");
            t.diagnostic(
              `${fullscreen ? "fullscreen" : "restored"} ${side}: ${orientation}, section rectangles ${JSON.stringify(boxes)}`,
            );
          }
          assert.equal(grid.fullscreen, fullscreen ? card.id : null);
          const native = (await s.surfaces()).find((v) => v.surface === current.active).applied;
          const bands = Object.fromEntries(
            Object.entries(current.sidebars).map(([side, state]) => [side, state.collapsed ? 6 : state.size]),
          );
          const expected = {
            x: grid.plane.x + current.x + 1 + bands.left,
            y: grid.plane.y + current.y + 33 + bands.top,
            w: current.w - 2 - bands.left - bands.right,
            h: current.h - 56 - bands.top - bands.bottom,
          };
          for (const key of ["x", "y", "w", "h"])
            assert.ok(
              Math.abs(native[key] - expected[key]) <= 1,
              `${key}: native ${native[key]} expected ${expected[key]}`,
            );
          measured.push(native);
          t.diagnostic(`${fullscreen ? "fullscreen" : "restored"} native ${JSON.stringify(native)}`);
        }
      } catch (error) {
        failures.push(error);
      } finally {
        try {
          const stopped = await s.request("diagnostics.capture.stop", {
            after: displayed === undefined ? 0 : displayed + 100,
          });
          assert.equal(stopped.limited, false, "recording buffer exhausted");
          assert.ok(stopped.longestGap <= 100, `missing transition frames: ${stopped.longestGap}ms`);
          if (failures.length === 0) {
            const captured = frames(capture.frames).map(readFrame);
            assert.ok(captured.length > 4, "incomplete fullscreen/restore recording");
            const border = (frame, rect) => {
              const scale = frame.scale * frame.contentScale;
              return [-1, -0.5, 0, 0.5, 1].some((offset) =>
                [-12, -6, 0, 6, 12].every((dx) => {
                  const rgb = pixel(
                    frame,
                    Math.floor((rect.x + rect.w / 2 + dx) * scale),
                    Math.floor((rect.y - 1 + offset) * scale),
                  );
                  return rgb.every((value, index) => Math.abs(value - [43, 46, 61][index]) <= 3);
                }),
              );
            };
            assert.ok(border(captured[0], measured[0]), "initial folded border is absent from recording");
            assert.ok(
              captured.some((frame) => border(frame, measured[1])),
              "fullscreen expanded border is absent from recording",
            );
            assert.ok(border(captured.at(-1), measured[2]), "restored folded border is absent from recording");
            t.diagnostic(
              `fullscreen/restore recording: ${captured.length} frames, maximum gap ${stopped.longestGap}ms`,
            );
          }
        } catch (error) {
          failures.push(error);
        }
        try {
          rmSync(capture.frames, { recursive: true, force: true });
        } catch (error) {
          failures.push(error);
        }
        try {
          const records = await audit.stop();
          for (const value of records) {
            assert.ok(value && Array.isArray(value.rows), "invalid verification notification");
            const failed = value.rows.filter((row) => !row.ok);
            assert.equal(failed.length, 0, JSON.stringify(failed));
          }
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length) throw new AggregateError(failures, "orientation presentation check failed");
    },
  );
