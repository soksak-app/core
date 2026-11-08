// Checks that a real press of the close button ends a window and leaves the application open. The press of the endpoint goes
// directly to the view under the point of the content view (docs/spec/exposure.md), and the buttons of the title bar are views of
// the window frame outside the content view that track their press in their own event loop, so only the window-server path of a
// person's pointer reaches them.
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh } from "../fixture.mjs";
import { appPid, click, frontWindowAt, requireTrusted } from "@soksak/window-check/hid.mjs";

for (const app of Object.values(APPS)) {
  test(`${app.name}: a real press of the close button ends a window and leaves the application open`, { timeout: 90000 }, async (t) => {
    requireTrusted();
    const s = await open(t, app);
    await fresh(s);
    s.cleanup(() => s.windows(1, "the check left an extra window"));
    const known = new Set((await s.get("host.windows")).map((entry) => entry.window));
    await s.run("core.window.new");
    const isNew = (entry) => entry.ready && !known.has(entry.window);
    const list = await s.until("host.windows", (windows) => windows.some(isNew), "core.window.new opened no window that became ready");
    const w = s.on(list.find(isNew).window);
    const { controls } = await w.get("host.window");
    const button = controls[0];
    assert.equal(button?.hidden, false, `the close button of window ${w.window} is not shown: ${JSON.stringify(controls)}`);
    const [x, y] = [button.x + button.width / 2, button.y + button.height / 2];
    await w.pointer(x, y, "move", { activate: true });
    const { frame, content } = await w.until("host.window", (window) => window.active === true && window.key === true,
      "the window did not become the key window of the active application");
    const point = { x: frame.x + content.x + x, y: frame.y + content.y + y };
    const front = frontWindowAt(point.x, point.y);
    assert.equal(front?.pid, appPid(app), `the frontmost window at ${point.x},${point.y} belongs to ${front?.owner} (${front?.pid}), not ${app.name}`);
    click(point.x, point.y);
    await s.until("host.windows", (windows) => !windows.some((entry) => entry.window === w.window),
      `a real press of the close button at ${JSON.stringify(button)} did not end window ${w.window}`);
    assert.ok((await s.get("host.windows")).some((entry) => entry.window === s.window), "the close button ended the window of the check as well");
  });
}
