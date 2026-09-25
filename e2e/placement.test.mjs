// 검사 창 자리: fresh 가 두 검사 앱을 정해진 자리에 두고, 가려진 창은 가림 상태를 감시자에게 알린다.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { APPS, fresh, open } from "./app.mjs";

test("fresh places the two check windows at their own frames", async (t) => {
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

// 창 서버의 앞뒤 순서대로 나열한 일반 층 창의 소유 프로세스 번호.
function windowOrder() {
  const script = `ObjC.import("CoreGraphics");
const list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1 | 16, 0)));
JSON.stringify(list.filter((item) => item.kCGWindowLayer === 0).map((item) => item.kCGWindowOwnerPID));`;
  return JSON.parse(execFileSync("osascript", ["-l", "JavaScript", "-e", script], { encoding: "utf8" }));
}

test("a check window that another window covers reports occluded to its watchers", async (t) => {
  const sessions = [];
  for (const app of Object.values(APPS)) {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    sessions.push(s);
  }
  if (sessions.length < 2) return t.skip("only one check application is selected");
  for (const s of sessions) await fresh(s);
  // 창은 활성화하지 않으므로 앞뒤 순서를 바꿀 수 없다. 앞 창을 뒤 창보다 크게 해 뒤 창 전체와 그 그림자를 덮는다.
  const pid = (s) => JSON.parse(readFileSync(join(s.app.configDir, "endpoint.json"), "utf8")).pid;
  const order = windowOrder();
  const [front, rear] = [...sessions].sort((a, b) => order.indexOf(pid(a)) - order.indexOf(pid(b)));
  const covered = (await rear.get("host.window")).frame;
  await front.run("host.window.resize", { width: covered.width + 200, height: covered.height + 100 });
  await front.run("host.window.move", { x: covered.x - 100, y: covered.y });
  await rear.until("host.window", (w) => w.occluded === true,
    `${rear.app.name} was not reported occluded under ${front.app.name}`, { timeout: 2000 });
  // 가린 창을 되돌리면 다시 보인다.
  for (const s of sessions) await fresh(s);
  await rear.until("host.window", (w) => w.occluded === false,
    `${rear.app.name} was still reported occluded after ${front.app.name} moved away`, { timeout: 2000 });
});
