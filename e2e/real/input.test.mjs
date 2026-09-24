// 실제 입력 등급 창 검사: 입력 도구가 사용자와 같은 경로로 이벤트를 보내는지 검사한다.
//
// 이 등급은 CGEventPost 로 HID 이벤트를 보내므로 사용자의 포인터와 키보드를 쓰고 앱을 활성화한다. 기본 창 검사에
// 포함하지 않고, 사용자가 승인한 실행에서 pnpm -F @soksak/e2e verify:real 로만 실행한다.
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, fresh, open } from "../app.mjs";
import { ensureTerminals } from "../terminal-screen.mjs";
import { bringFront, click, keepPasteboard, post, readPasteboard, requireTrusted, writePasteboard } from "./hid.mjs";

for (const app of Object.values(APPS)) {
  test(`${app.name}: a posted HID click reaches the terminal region through the window server`, { timeout: 60000 }, async (t) => {
    requireTrusted();
    const s = await open(t, app);
    assert.ok(s, `${app.binary} is not built`);
    await fresh(s);
    const [terminal] = await ensureTerminals(s, 1);
    const surface = terminal.surface;
    await s.presented();
    const view = await s.rect("terminal.view", undefined, surface);
    const point = await bringFront(s, app, view);

    post([{ type: "move", x: point.x, y: point.y }]);
    await s.until("host.window", (window) => Math.abs(window.pointer.x - point.x) < 1 && Math.abs(window.pointer.y - point.y) < 1,
      `the system pointer did not move to the posted point ${point.x},${point.y}`);
    click(point.x, point.y);
    await s.until("host.window", (window) => window.regions.some((region) => region.surface === surface && region.focused),
      "a posted click did not give the terminal region native focus");
  });

  test(`${app.name}: the real-input pasteboard helpers restore every item type`, { timeout: 30000 }, async (t) => {
    const s = await open(t, app);
    assert.ok(s, `${app.binary} is not built`);
    keepPasteboard(s);
    const items = [{
      "public.utf8-plain-text": Buffer.from("real input").toString("base64"),
      "public.png": Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64"),
    }];
    writePasteboard(items);
    assert.deepEqual(readPasteboard().items, items);
  });
}
