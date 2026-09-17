// 최대화와 녹화 종료 후 네이티브 창 버튼의 실제 좌표를 검사한다.
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, drag, fresh, open } from "./app.mjs";

const PLAN = { axis: "x", line: 2, dx: -250, dy: 0, ms: 48, times: 3 };

/** 창 버튼 세 개가 보이고 창 머리 행의 가운데에 있는지 확인한다. */
async function centred(s, when) {
  const state = await s.get("host.window");
  const bar = await s.rect("core.chrome.bar");
  assert.equal(state.controls.length, 3);
  for (const button of state.controls) {
    assert.equal(button.hidden, false, `a native button is hidden ${when}`);
    const offset = button.y + button.height / 2 - (bar.y + bar.height / 2);
    assert.ok(Math.abs(offset) <= 0.25,
      `native button is ${offset}pt from the row centre ${when}: ${JSON.stringify(button)}, row ${JSON.stringify(bar)}`);
  }
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: maximising the window leaves its own buttons in place`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    const before = (await s.get("host.window")).frame;
    await s.run("host.window.maximize", { on: true });
    try {
      await s.until("host.window", (w) => w.frame.width !== before.width || w.frame.height !== before.height,
        "the window did not maximise");
      await s.presented();
      await centred(s, "after maximising");
    } finally {
      await s.run("host.window.maximize", { on: false });
      await s.until("host.window", (w) => w.frame.width === before.width && w.frame.height === before.height,
        "the window did not return to its size");
      await s.presented();
    }
  });

  test(`${app.name}: stopping a window recording leaves the native buttons centred`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    await drag(t, s, PLAN, { capture: true });
    await centred(s, "after recording");
  });
}
