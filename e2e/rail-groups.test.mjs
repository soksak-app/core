// 고정 사이드바와 오버라이드 카드의 레일이 인접할 때 한 고리, 떨어질 때 두 고리로 그려지고, 카드 전체 화면과 복원에서
// 같은 규칙을 지키는지 녹화로 검사한다(docs/spec/external-sidebars.md). 전체 화면은 고정 사이드바를 숨기므로 레일이 없다.
import assert from "node:assert/strict";
import test from "node:test";
import { rmSync } from "node:fs";
import { APPS, keepCommonSettings, open } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";
import { frames, readFrame } from "@soksak/window-check/frame.mjs";
import { railPixels } from "./rail.mjs";

for (const app of Object.values(APPS)) test(`${app.name}: rail groups follow adjacent, detached, fullscreen and restored cards`, { timeout: 90000 }, async (t) => {
  const s = await open(t, app);
  assert.ok(s, "required host is not built");
  await fresh(s);
  await keepCommonSettings(s);
  await s.run("core.settings.theme", { name: "midnight", mode: "dark" });
  // 터미널 플러그인의 오른쪽 오버라이드가 오른쪽 고정 사이드바를 터미널 카드에 묶는다.
  await s.run("core.settings.link", { place: "window-right", plugin: "terminal", set: "set-install", scope: "common" });

  // 상태를 바꾸는 동안 녹화하고, 녹화가 완전한지와 마지막 프레임의 레일 색을 잰다.
  const record = async (label, change, loops) => {
    const recording = await s.record();
    const directory = recording.frames;
    await change();
    const { displayed } = await s.presented();
    const stopped = await recording.stop({ after: displayed });
    try {
      assert.equal(stopped.limited, false, `${label}: the recording reached its frame limit`);
      assert.ok(stopped.count > 0, `${label}: the recording has no frames`);
      assert.ok(stopped.longestGap <= 100, `${label}: the recording has a ${stopped.longestGap}ms gap`);
      const rail = await s.get("core.rail");
      // 전체 화면은 다른 카드와 함께 고정 사이드바를 숨기므로 레일이 없다(loops 0).
      assert.equal(rail.groups.length, loops === 0 ? 0 : 1, `${label}: ${rail.groups.length} rail groups`);
      if (loops > 0) assert.equal(rail.groups[0].loops.length, loops, `${label}: ${rail.groups[0].loops.length} rail loops, expected ${loops}`);
      const verify = (await s.get("core.verify")).rows.filter((row) => !row.ok);
      assert.deepEqual(verify, [], `${label}: layout verification failed`);
      try {
        railPixels(readFrame(frames(directory).at(-1)), await s.get("core.grid"), rail);
      } catch (error) {
        throw new Error(`${label}: ${error.message}; loops ${JSON.stringify(rail.groups.map((group) => group.loops))}`, { cause: error });
      }
      t.diagnostic(`${label}: ${stopped.count} frames, maximum gap ${stopped.longestGap}ms, ${loops} loop(s)`);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  };

  // 기본 배치에서 터미널 카드는 오른쪽 고정 사이드바와 맞닿는다.
  await record("adjacent", () => s.run("core.card.focus", { card: "terminal" }), 1);
  const { tab } = await s.run("core.card.split", { card: "terminal", side: "right", plugin: "terminal" });
  const split = (await s.get("core.grid")).cards.find((card) => card.tabs.some((item) => item.id === tab));
  assert.ok(split, "the split card is missing");
  s.cleanup(async () => {
    if ((await s.get("core.grid")).fullscreen !== null) await s.run("core.card.fullscreen", { card: "terminal" });
    await s.run("core.tab.close", { tab });
    await s.presented();
  });
  // 나뉜 오른쪽 카드가 사이에 서므로 왼쪽 터미널 카드는 사이드바와 떨어진다.
  await record("detached", () => s.run("core.card.focus", { card: "terminal" }), 2);
  await record("adjacent split", () => s.run("core.card.focus", { card: split.id }), 1);
  await record("fullscreen", async () => {
    await s.run("core.card.focus", { card: "terminal" });
    await s.run("core.card.fullscreen", { card: "terminal" });
  }, 0);
  await record("restored", () => s.run("core.card.fullscreen", { card: "terminal" }), 2);
});
