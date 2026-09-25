// 검사 창 자리: fresh 가 두 검사 앱을 서로 완전히 가리지 않는 자리에 둔다.
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, fresh, open } from "./app.mjs";

test("fresh places the two check windows so that neither covers the other", async (t) => {
  const sessions = [];
  for (const app of Object.values(APPS)) {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    sessions.push(s);
  }
  if (sessions.length < 2) return t.skip("only one check application is selected");
  // 두 창을 같은 자리에 겹친 뒤 fresh 가 각자의 자리로 되돌리는지 본다.
  const { frame } = await sessions[0].get("host.window");
  await sessions[1].run("host.window.move", { x: frame.x, y: frame.y });
  await sessions[1].until("host.window", (w) => w.frame.x === frame.x && w.frame.y === frame.y, "the second window did not move onto the first");
  for (const s of sessions) await fresh(s);
  const frames = [];
  for (const s of sessions) {
    const w = await s.until("host.window", (value) => value.occluded === false,
      `${s.app.name}'s window is completely covered after fresh`);
    frames.push(w.frame);
  }
  assert.notEqual(frames[0].x, frames[1].x, `both check windows stand at x ${frames[0].x}`);
});
