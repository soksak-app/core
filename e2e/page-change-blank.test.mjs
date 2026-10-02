// 페이지가 바뀌는 동안 창이 덜 그려진 화면을 보이지 않는지 녹화로 잰다(docs/spec/surface-composition.md). 프레임마다 두 자리를
// 본다. 머리 줄의 로고 글자는 신호등 단추 오른쪽의 제자리에 있어야 하고(앱 스타일이 적용되기 전에는 로고가 단추 쪽으로
// 밀린다), 카드 머리는 카드 색이어야 한다(작업 공간이 비면 창 배경만 보인다).
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import test from "node:test";

import { APPS, fresh, open } from "./app.mjs";
import { frames, pixel, readFrame } from "./frame.mjs";

const near = (a, b, tolerance) => a.every((value, index) => Math.abs(value - b[index]) <= tolerance);

/** 창 좌표(포인트) point 의 프레임 픽셀. */
function sample(frame, point) {
  const scale = frame.scale * frame.contentScale;
  return pixel(frame, Math.floor(frame.content.x * frame.scale + point.x * scale),
    Math.floor(frame.content.y * frame.scale + point.y * scale));
}

/** rect(창 좌표) 안에 background 와 40 넘게 다른 픽셀의 수. */
function ink(frame, rect, background) {
  let count = 0;
  for (let y = rect.y; y < rect.y + rect.height; y++) {
    for (let x = rect.x; x < rect.x + rect.width; x++) {
      if (sample(frame, { x, y }).some((value, index) => Math.abs(value - background[index]) > 40)) count++;
    }
  }
  return count;
}

/**
 * 덜 그려진 프레임. logo 는 제자리의 로고 글자 영역, card 는 카드 색이어야 하는 한 점이다(없으면 보지 않는다). 기준은
 * 녹화의 첫 프레임이다.
 */
function undrawn(captured, logo, card) {
  const first = captured[0];
  const background = sample(first, { x: logo.x - 4, y: logo.y + logo.height / 2 });
  const cardColour = card ? sample(first, card) : null;
  assert.ok(ink(first, logo, background) > 0, "the first frame has no logo text at its place");
  return captured.map((frame, index) => ({ index, logo: ink(frame, logo, background), card: card ? sample(frame, card) : null }))
    .filter((item) => item.logo === 0 || (card && !near(item.card, cardColour, 12)))
    .map((item) => ({ ...item, expected: cardColour }));
}

async function record(s, action) {
  const { displayed } = await s.presented();
  const recording = await s.request("diagnostics.capture.start", {});
  let stopped = false;
  try {
    await action();
    const shown = await s.presented();
    const stop = await s.request("diagnostics.capture.stop", { after: Math.max(displayed, shown.displayed) + 100 });
    stopped = true;
    assert.equal(stop.limited, false, "the recording reached its frame cap");
    return frames(recording.frames).map(readFrame);
  } finally {
    // 동작이 실패해도 녹화를 끝내야 다음 검사가 녹화를 시작할 수 있다.
    if (!stopped) await s.request("diagnostics.capture.stop", { after: displayed });
    rmSync(recording.frames, { recursive: true, force: true });
  }
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: page changes keep the window drawn`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    assert.ok(s, `${app.binary} is not built`);
    await fresh(s);
    // 로고 글자는 창 머리 줄에서 로고 아이콘 오른쪽에 있다. 로고가 신호등 단추 쪽으로 밀리면 이 영역은 빈다.
    const logo = { x: 112, y: 13, width: 48, height: 12 };
    const grid = await s.get("core.grid");
    const content = grid.cards.find((item) => item.tabs?.length);
    assert.ok(content, "no content card");
    const card = { x: grid.plane.x + content.x + content.w / 2, y: grid.plane.y + content.y + 3 };
    const reload = undrawn(await record(s, async () => {
      const before = (await s.get("core.window.document")).timeOrigin;
      await s.run("host.window.reload");
      await s.until("core.window.document", (doc) => doc.timeOrigin !== before && doc.readyState === "complete",
        "the main document did not reload");
    }), logo, card);
    const library = undrawn(await record(s, async () => {
      await s.run("core.projects.browse");
      await s.until("core.screen", (value) => value.screen === "library", "the library did not open");
      await s.run("core.library.return");
      await s.until("core.screen", (value) => value.screen === "workspace", "the library did not return to the workspace");
    }), logo, null);
    t.diagnostic(`reload: ${reload.length} undrawn frames ${JSON.stringify(reload.slice(0, 6))}; library: ${library.length}`);
    assert.deepEqual(reload, [], "a reload showed frames without the logo at its place or without the card");
    assert.deepEqual(library, [], "opening and leaving the library showed frames without the logo at its place");
  });
}
