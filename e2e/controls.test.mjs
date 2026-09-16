// 최대화와 녹화 종료 후 네이티브 창 버튼의 실제 좌표를 검사한다.
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, ask, shake, nativeProbe } from "./app.mjs";

const DRIVE = "5000,x,2,-250,0,48,3";

for (const [name, binary] of Object.entries(APPS)) {
  test(`${name}: maximising the window leaves its own buttons in place`, async (t) => {
    const log = await ask(binary, ["transcript on", "zoom on"],
      (text) => /host presentSurfaces .*"settled":true.* ->/.test(text));
    if (!log) return t.skip(`${binary} is not built`);
    const state = await nativeProbe(binary, { op: "state" });
    const bar = await nativeProbe(binary, { op: "eval", match: "main", script:
      'document.querySelector(".chrome-bar").getBoundingClientRect().toJSON()' });
    assert.equal(state.controls.length, 3);
    for (const button of state.controls) {
      assert.ok(Math.abs(button.y + button.h / 2 - (bar.top + bar.height / 2)) <= 0.25,
        `native button is outside the row centre after maximising: ${JSON.stringify(button)}`);
    }
  });

  test(`${name}: stopping a window recording leaves the native buttons centred`, async (t) => {
    const run = await shake(binary, DRIVE);
    if (!run) return t.skip(`${binary} is not built`);
    try {
      const state = await nativeProbe(binary, { op: "state" });
      const bar = await nativeProbe(binary, { op: "eval", match: "main", script:
        'document.querySelector(".chrome-bar").getBoundingClientRect().toJSON()' });
      assert.equal(state.controls.length, 3);
      for (const button of state.controls) {
        assert.equal(button.hidden, false);
        assert.ok(Math.abs(button.y + button.h / 2 - (bar.top + bar.height / 2)) <= 0.25,
          `native button is outside the row centre after recording: ${JSON.stringify(button)}`);
      }
    } finally {
      run.clean();
    }
  });
}
