// 터미널 카드를 실제로 누를 때 browser 카드의 주소창이 순간 초점을 받지 않는지 검사한다(V5-114, V5-114-1).
// 터미널 영역은 클릭 투명이라 누르면 메인 문서가 초점을 되찾을 수 있고, activeElement 로 남은 주소창이 그 순간
// 초점을 받아 보였다. 실제 HID 클릭의 전 과정을 녹화하고, 그 동안의 core.focus 변화를 모두 모아 주소창으로 들어온
// 초점 전이가 없는지, 네이티브 first responder 가 누른 터미널로 가는지 확인한다.
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh } from "../fixture.mjs";
import { frames } from "@soksak/window-check/frame.mjs";
import { ensureTerminals } from "../terminal-screen.mjs";
import { bringFront, click, requireTrusted, screenCenter } from "./hid.mjs";

for (const app of Object.values(APPS)) {
  test(`${app.name}: a real terminal press never moves focus to the browser address field`, { timeout: 120000 }, async (t) => {
    requireTrusted();
    const s = await open(t, app);
    assert.ok(s, `${app.binary} is not built`);
    await fresh(s);
    const terminals = await ensureTerminals(s, 2);
    const card = (await s.get("core.grid")).cards.find((item) => item.tabs.some((tab) => tab.id === terminals[1].surface));
    const { tab: browser } = await s.run("core.card.split", { card: card.id, axis: "y", plugin: "browser" });
    s.cleanup(() => s.run("core.tab.close", { tab: browser }));
    await s.until("core.surfaces", (list) => list.some((item) => item.surface === browser && item.exposes.includes("dom browser.address")),
      "the browser surface did not register its address field");
    await s.presented();

    // 주소창을 실제로 눌러 초점을 준다. 문서의 activeElement 는 그 뒤로 주소창에 남는다.
    const field = await s.rect("browser.address", undefined, browser);
    const point = await bringFront(s, app, field);
    click(point.x, point.y);
    await s.until("core.focus", (focus) => focus?.name === "browser.address" && focus.surface === browser,
      "a real click on the address field did not give it focus in core.focus");

    const { frames: directory } = await s.request("diagnostics.capture.start", {});
    let stopped = null;
    s.cleanup(async () => {
      if (!stopped) await s.request("diagnostics.capture.stop", { after: 0 });
      rmSync(directory, { recursive: true, force: true });
    });
    const focus = await s.collect("core.focus");
    for (const terminal of terminals) {
      const target = await screenCenter(s, await s.rect("terminal.view", undefined, terminal.surface));
      click(target.x, target.y);
      await s.until("host.window", (window) => window.responder?.surface === terminal.surface,
        `${terminal.surface} did not become the native first responder after a real click`);
    }
    const { displayed } = await s.presented();
    stopped = await s.request("diagnostics.capture.stop", { after: displayed });
    const values = await focus.stop();

    assert.equal(stopped.limited, false, "the recording reached its frame limit");
    assert.ok(frames(directory).length > 0, "the recording has no frames");
    assert.ok(stopped.longestGap <= 100, `the recording has a ${stopped.longestGap}ms gap`);
    // 첫 값은 감시를 시작할 때의 상태(주소창)다. 그 뒤 주소창으로 다시 들어온 초점은 모두 전이다.
    const transitions = values.slice(1).filter((value, index) => value?.name === "browser.address" &&
      values[index]?.name !== "browser.address");
    assert.deepEqual(transitions, [], `focus moved to the address field during the terminal presses: ${JSON.stringify(values)}`);
    const host = await s.get("host.window");
    assert.equal(host.responder?.surface, terminals[1].surface, "the last pressed terminal is not the native first responder");
    assert.deepEqual(host.regions.filter((region) => region.focused).map((region) => region.surface), [terminals[1].surface]);
    t.diagnostic(`core.focus values ${JSON.stringify(values)}; ${stopped.count} frames, maximum gap ${stopped.longestGap}ms`);
  });
}
