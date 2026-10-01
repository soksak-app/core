// 카드 사방 손잡이의 네이티브 포인터 입력과 녹화한 경계 좌표를 검사한다.
import assert from "node:assert/strict";
import test from "node:test";
import { rmSync } from "node:fs";
import { APPS, fresh, open } from "./app.mjs";
import { frames, readFrame } from "./frame.mjs";
import { recordedEdges } from "./sidebar-gesture-recording.mjs";

const sides = ["top", "bottom", "left", "right"];
const sign = (side) => (side === "top" || side === "left" ? 1 : -1);
function near(actual, expected, label) {
  assert.ok(Math.abs(actual - expected) <= 1, `${label}: actual ${actual}, expected ${expected}`);
}
async function measure(s, id) {
  const grid = await s.get("core.grid");
  const card = grid.cards.find((c) => c.id === id);
  const surface = (await s.surfaces()).find((item) => item.surface === card.active);
  assert.ok(surface?.applied, "active native surface is not presented");
  const bands = Object.fromEntries(
    sides.map((side) => [side, card.sidebars[side].collapsed ? 6 : card.sidebars[side].size]),
  );
  near(surface.applied.x, grid.plane.x + card.x + 1 + bands.left, "native left");
  near(surface.applied.y, grid.plane.y + card.y + 1 + 32 + bands.top, "native top");
  near(surface.applied.w, card.w - 2 - bands.left - bands.right, "native width");
  near(surface.applied.h, card.h - 2 - 32 - 22 - bands.top - bands.bottom, "native height");
  return { grid, card, surface };
}

for (const app of Object.values(APPS)) {
  test(
    `${app.name}: native pointer drags all four card sidebar borders by their displacement`,
    { timeout: 120000 },
    async (t) => {
      console.info(`START ${app.name}: sidebar gesture`);
      const s = await open(t, app);
      assert.ok(s, `${app.binary} is not built`);
      t.diagnostic(`tested endpoint: ${JSON.stringify(s.client.endpoint)}`);
      await fresh(s);
      await s.run("core.settings.theme", { name: "midnight", mode: "dark" });
      const card = (await s.get("core.grid")).cards.find((c) => c.tabs.some((tab) => tab.plugin === "terminal"));
      assert.ok(card, "no terminal card");
      await s.run("core.tab.select", { tab: card.tabs.find((tab) => tab.plugin === "terminal").id });
      await s.run("core.card.fullscreen", { card: card.id });
      const set = (await s.get("core.settings")).values.sets[0].id;
      for (const side of sides) {
        await s.run("core.card.sidebar.set", { card: card.id, side, set });
        await s.run("core.card.sidebar.size", { card: card.id, side, size: 120 });
      }
      await s.presented();
      const baseline = await measure(s, card.id);
      const audit = await s.collect("core.verify");
      const failures = [];
      async function inactive() {
        const state = await s.get("host.window");
        assert.equal(
          state.active,
          false,
          `synthetic pointer measurement refused: active window, pointer ${JSON.stringify(state.pointer)}`,
        );
        assert.equal(state.occluded, false, "synthetic pointer measurement refused: occluded window");
      }
      try {
        for (const side of sides) {
          const began = performance.now();
          console.info(`START ${app.name}: ${side} sidebar gesture`);
          await inactive();
          const before = await measure(s, card.id);
          const index = sides.indexOf(side);
          const grip = await s.rect("core.card.sidebar.grip", index);
          assert.ok(grip.width > 0 && grip.height > 0, `${side}: no grip input area`);
          const x = grip.x + grip.width / 2,
            y = grip.y + grip.height / 2;
          const vertical = side === "left" || side === "right";
          const applied = before.surface.applied;
          const initial =
            side === "left"
              ? applied.x - 1
              : side === "right"
                ? applied.x + applied.w
                : side === "top"
                  ? applied.y - 1
                  : applied.y + applied.h;
          const cross = vertical ? applied.y + applied.h / 2 : applied.x + applied.w / 2;
          const initialPresentation = await s.presented();
          const poses = [{ phase: "initial", displayed: initialPresentation.displayed, size: 120, applied }];
          const recordingWindow = await s.get("host.window");
          const { frames: directory } = await s.request("diagnostics.capture.start", {});
          let down = false;
          let stopped;
          const elapsed = [];
          const gestureErrors = [];
          try {
            try {
              await s.pointer(x, y, "down");
              down = true;
              for (const distance of [10, 20, 30, 40, 30, 20, 10, 0]) {
                await inactive();
                const began = performance.now();
                await s.pointer(
                  x + (vertical ? sign(side) * distance : 0),
                  y + (vertical ? 0 : sign(side) * distance),
                  "drag",
                );
                await s.until(
                  "core.grid",
                  (grid) => grid.cards.find((c) => c.id === card.id)?.sidebars?.[side]?.size === 120 + distance,
                  `${side}: drag did not save ${120 + distance} points`,
                );
                const { displayed } = await s.presented();
                await inactive();
                const current = await measure(s, card.id);
                poses.push({
                  phase: "drag",
                  distance,
                  displayed,
                  size: current.card.sidebars[side].size,
                  applied: current.surface.applied,
                });
                assert.equal(current.card.sidebars[side].collapsed, false, "drag folded the sidebar");
                assert.deepEqual(
                  [current.card.x, current.card.y, current.card.w, current.card.h],
                  [baseline.card.x, baseline.card.y, baseline.card.w, baseline.card.h],
                  "drag changed card geometry",
                );
                const moved = await s.rect("core.card.sidebar.grip", index);
                near(
                  vertical ? moved.x - grip.x : moved.y - grip.y,
                  sign(side) * distance,
                  `${side} divider displacement`,
                );
                elapsed.push(Math.round(performance.now() - began));
              }
            } catch (error) {
              gestureErrors.push(error);
            } finally {
              try {
                if (down) await s.pointer(x, y, "up");
              } catch (error) {
                gestureErrors.push(error);
              }
              let displayed;
              try {
                ({ displayed } = await s.presented());
              } catch (error) {
                gestureErrors.push(error);
              }
              try {
                const current = await measure(s, card.id);
                poses.push({
                  phase: "release",
                  displayed,
                  size: current.card.sidebars[side].size,
                  applied: current.surface.applied,
                });
              } catch (error) {
                gestureErrors.push(error);
              }
              try {
                stopped = await s.request("diagnostics.capture.stop", {
                  after: displayed === undefined ? 0 : displayed + 100,
                });
              } catch (error) {
                gestureErrors.push(error);
              }
            }
            if (gestureErrors.length)
              throw new AggregateError(gestureErrors, `${side}: pointer input or capture failed`);
            const captured = frames(directory).map(readFrame);
            captured.forEach((frame, index) => {
              // 실패하면 그 프레임의 버퍼 크기, 창 사각형, 배율을 적는다.
              const measuredFrame = `frame ${index + 1} of ${captured.length}: buffer ${frame.width}x${frame.height}, ` +
                `content ${JSON.stringify(frame.content)} at content scale ${frame.contentScale}, scale ${frame.scale}`;
              assert.equal(
                frame.width,
                recordingWindow.content.width * recordingWindow.scale,
                `recording device-pixel width; ${measuredFrame}`,
              );
              assert.equal(
                frame.height,
                recordingWindow.content.height * recordingWindow.scale,
                `recording device-pixel height; ${measuredFrame}`,
              );
            });
            assert.ok(captured.length > 4, `${side}: incomplete gesture recording`);
            assert.equal(stopped.limited, false, "recording exhausted its buffer");
            assert.ok(stopped.longestGap <= 100, `${side}: missing frames, gap ${stopped.longestGap}ms`);
            assert.ok(
              Array.isArray(stopped.layouts) && stopped.layouts.length > 0,
              `${side}: missing layout transaction timeline`,
            );
            const measured = recordedEdges(captured, side, initial, cross, poses, stopped.layouts);
            assert.ok(
              measured[0].some((at) => Math.abs(at - initial) <= 1),
              `${side}: initial border not recorded`,
            );
            const final = initial + sign(side) * 40;
            assert.ok(
              measured.some((matches) => matches.some((at) => Math.abs(at - final) <= 1)),
              `${side}: far border not recorded`,
            );
            assert.ok(
              measured.at(-1).some((at) => Math.abs(at - initial) <= 1),
              `${side}: restored border not recorded`,
            );
            assert.ok(
              measured.some((matches) =>
                matches.some((at) => Math.abs(at - initial) >= 8 && Math.abs(at - final) >= 8),
              ),
              `${side}: no intermediate movement frame`,
            );
            t.diagnostic(
              `${side}: 120 -> 160 -> 120 points, ${captured.length} frames at ${captured[0].width}x${captured[0].height}, ${stopped.layouts.length} layout transactions, gap ${stopped.longestGap}ms, input/presentation steps ${elapsed.join(",")}ms`,
            );
            console.info(`PASS ${app.name}: ${side} sidebar gesture (${Math.round(performance.now() - began)}ms)`);
          } finally {
            try {
              rmSync(directory, { recursive: true, force: true });
            } catch (error) {
              failures.push(error);
            }
          }
          await s.run("core.card.sidebar.size", { card: card.id, side, size: 120 });
          await s.presented();
        }
        await s.run("core.card.fullscreen", { card: card.id });
        await s.presented();
        await measure(s, card.id);
      } catch (error) {
        failures.push(error);
      } finally {
        try {
          const records = await audit.stop();
          for (const value of records)
            assert.ok(value && Array.isArray(value.rows), `invalid verification notification ${JSON.stringify(value)}`);
          const failed = records.flatMap((value) => value.rows).filter((row) => !row.ok);
          if (failed.length)
            failures.push(new Error(`${failed.length} intermediate verification failures: ${JSON.stringify(failed)}`));
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length) throw new AggregateError(failures, "sidebar gesture measurement failed");
    },
  );
}
