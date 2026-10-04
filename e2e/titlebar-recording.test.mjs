// 프레임 글자 배율이 바뀌는 동안 녹화한 모든 프레임에서 창 단추가 첫 행의 가운데에 있는지 잰다
// (docs/spec/native-surfaces.md#title-bar-height). 배율이 1 에서 3 까지 한 단계씩 오르고 1 까지 내려오는 동안과,
// 다른 창이 배율을 바꾼 뒤 이 창을 다시 읽는 동안을 녹화한다. 단추와 첫 행은 프레임의 픽셀로 잰다
// (titlebar-measurement.mjs). DOM 의 값은 그 프레임이 보인 화면을 말하지 않는다.
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import test from "node:test";

import { APPS, coveredBy, fresh, open } from "./app.mjs";
import { missingPoses } from "./card-panel-checks.mjs";
import { frames, readFrame } from "./frame.mjs";
import { TOLERANCE, measureTitlebar, misaligned, rowHeight } from "./titlebar-measurement.mjs";

// 1 에서 3 까지 오르는 배율 단계(docs/spec/text-size.md).
const UP = [1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
const DOWN = [2.5, 2, 1.75, 1.5, 1.25, 1.1, 1];

/** 프레임 배율을 factor 로 정하고 그 화면이 표시될 때까지 기다린다. */
async function setFrame(s, factor) {
  await s.run("core.settings.set", { patch: { textSize: factor }, scope: "common" });
  await s.until("core.text", (value) => value.frame === factor, `the frame factor did not become ${factor}`);
  await s.presented();
}

/** 녹화할 창의 단추 사각형과 화면 갱신 빈도. 가려진 창은 WebKit 이 덜 그리므로 재지 않는다. */
async function recordable(s) {
  const window = await s.get("host.window");
  if (window.occluded) {
    throw new Error(`${s.app.name}'s window is completely covered by ${coveredBy(s, window)}, so WebKit renders it less often. ` +
      "Nothing was measured: uncover the window, without activating the application, and run the check again.");
  }
  assert.equal(window.controls.length, 3, `the window reports ${window.controls.length} buttons`);
  assert.ok(window.controls.every((button) => !button.hidden), "a window button is hidden");
  return { buttons: window.controls, refreshRate: window.refreshRate };
}

/**
 * 창을 녹화하는 동안 action(displayed) 를 실행한다. action 은 녹화 동안 표시된 상태 { displayed, at }(표시 시각,
 * 첫 행의 높이)를 순서대로 반환한다. 프레임마다 단추와 첫 행을 재고 녹화 폴더는 지운다.
 */
async function record(s, buttons, action) {
  const { displayed } = await s.presented();
  const recording = await s.request("diagnostics.capture.start", {});
  let stopped = false;
  try {
    const poses = await action(displayed);
    const stop = await s.request("diagnostics.capture.stop", { after: poses.at(-1).displayed + 100 });
    stopped = true;
    assert.equal(stop.limited, false, "the recording reached its frame cap");
    // 프레임을 하나씩 읽고 잰다. 녹화 전체를 메모리에 두지 않는다.
    const measured = frames(recording.frames).map((path, index) => ({ index, ...measureTitlebar(readFrame(path), buttons) }));
    return { poses, stop, measured };
  } finally {
    // 동작이 실패해도 녹화를 끝내야 다음 검사가 녹화를 시작할 수 있다.
    if (!stopped) await s.request("diagnostics.capture.stop", { after: displayed });
    rmSync(recording.frames, { recursive: true, force: true });
  }
}

/**
 * 모든 프레임에서 단추 가운데와 첫 행 가운데가 TOLERANCE 안에 있고, 표시된 모든 상태가 표시 뒤 화면 두 프레임 안에
 * 녹화되었는지 판정한다.
 */
function judge(t, label, { poses, stop, measured }, refreshRate) {
  assert.ok(measured.length > 1, `${label}: the recording has ${measured.length} frames`);
  const off = misaligned(measured);
  const recorded = measured.filter((frame) => frame.row !== undefined).map((frame) => ({ time: frame.time, edges: [frame.row] }));
  const missing = recorded.length ? missingPoses(recorded, poses, refreshRate) : poses;
  const largest = Math.max(...measured.filter((frame) => frame.difference !== undefined).map((frame) => Math.abs(frame.difference)));
  t.diagnostic(`${label}: ${measured.length} frames, rows ${[...new Set(recorded.map((frame) => frame.edges[0]))].join(",")}, ` +
    `largest difference ${largest.toFixed(2)}px, longest gap ${stop.longestGap}ms, ${stop.layouts.length} layout transactions`);
  assert.equal(off.length, 0, `${label}: ${off.length} of ${measured.length} frames have the window button centre more than ` +
    `${TOLERANCE}px from the first-row centre or cannot be measured: ${JSON.stringify(off.slice(0, 12))}`);
  assert.deepEqual(missing, [], `${label}: displayed first rows missing from the recording at ${refreshRate}Hz`);
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: every recorded frame keeps the window buttons centred in the first row while the frame factor steps from 1 to 3 and back`,
    { timeout: 120000 }, async (t) => {
      const s = await open(t, app);
      assert.ok(s, `${app.binary} is not built`);
      await fresh(s);
      s.cleanup(() => setFrame(s, 1));
      await setFrame(s, 1);
      // 프레임을 누르면 글자 크기 명령의 범위가 프레임이 된다.
      const spaceTab = await s.rect("core.space-tab", 0);
      await s.click((spaceTab.document?.x ?? 0) + spaceTab.x + spaceTab.width / 2,
        (spaceTab.document?.y ?? 0) + spaceTab.y + spaceTab.height / 2);
      await s.until("core.text", (value) => value.scope.kind === "frame", "pressing the frame did not make it the text size scope");
      const { buttons, refreshRate } = await recordable(s);
      for (const [label, from, steps, command] of [["up", 1, UP, "core.text.larger"], ["down", 3, DOWN, "core.text.smaller"]]) {
        judge(t, label, await record(s, buttons, async (displayed) => {
          const poses = [{ displayed, at: rowHeight(from) }];
          for (const factor of steps) {
            await s.run(command);
            await s.until("core.text", (value) => value.frame === factor, `the frame factor did not reach ${factor}`);
            poses.push({ displayed: (await s.presented()).displayed, at: rowHeight(factor) });
          }
          return poses;
        }), refreshRate);
      }
    });

  test(`${app.name}: every recorded frame of a reload after another window changed the frame factor keeps the window buttons centred`,
    { timeout: 120000 }, async (t) => {
      const s = await open(t, app);
      assert.ok(s, `${app.binary} is not built`);
      await fresh(s);
      s.cleanup(() => setFrame(s, 1));
      await setFrame(s, 1);
      await s.run("core.window.new");
      const list = await s.windows(2, "the new window did not open");
      const other = s.on(list.find((w) => w.window !== s.window).window);
      s.cleanup(() => other.close());
      await other.until("core.screen", (value) => value.screen === "library", "the new window did not show the library");
      const { buttons, refreshRate } = await recordable(s);
      const before = (await s.get("core.window.document")).timeOrigin;
      // 다른 창의 설정이 공통 배율을 바꾸고, 이 창은 그 알림을 그리기 전이나 뒤에 다시 읽는다. 어느 쪽이든 모든 프레임이
      // 기준을 지켜야 한다.
      judge(t, "reload", await record(s, buttons, async (displayed) => {
        await other.run("core.settings.change", { key: "textSize", value: 2, scope: "common" });
        await other.until("core.text", (value) => value.frame === 2, "the other window did not take frame factor 2");
        await s.run("host.window.reload");
        await s.until("core.window.document", (doc) => doc.timeOrigin !== before && doc.readyState === "complete",
          "the main document did not reload");
        await s.until("core.text", (value) => value.frame === 2, "the reloaded page did not take frame factor 2");
        return [{ displayed, at: rowHeight(1) }, { displayed: (await s.presented()).displayed, at: rowHeight(2) }];
      }), refreshRate);
    });
}
