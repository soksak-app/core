// A window that an application shows while it is not active stays behind the front window, and the application stays inactive
// (docs/spec/hosts.md#launch-activation). The application of a check is launched without activation, so its first window and a
// new window stay behind the windows of other applications. The check relaunches the application in the background and measures
// its first window right after that show. A person who uses other applications meanwhile only puts windows in front of the windows
// of the check, so the check judges the activation of the application and the windows of other applications behind its windows,
// never the front application or the place of a window (AGENTS.md).
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";
import { firstWindowPlace, newWindowPlace } from "./window-show-behind.mjs";

for (const app of Object.values(APPS)) {
  test(`${app.name}: a window of a check opens behind the front window and the front application stays`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    if (!s) return;
    const { pid, front, first, behind } = await firstWindowPlace(s);
    t.diagnostic(`front application ${front}; application ${pid}; first window at place ${first}, ${behind} windows of other applications behind it`);
    // The first window of an application that shows no other window goes behind every window. The other applications of the run
    // open behind every window after it, so their windows are not counted.
    assert.equal(behind, 0, `the first window of ${app.name} is at place ${first}, in front of ${behind} windows of other applications`);
    assert.equal((await s.get("host.window")).active, false, `${app.name} is active`);
    await fresh(s);
    let child;
    try {
      await s.run("core.window.new");
      const list = await s.windows(2, "the new window did not open");
      child = s.on(list.find((w) => w.window !== s.window).window);
      await child.presented();
      const shown = await child.get("host.window");
      const { behind: under, front: now } = await newWindowPlace(pid);
      t.diagnostic(`new window: ${under} windows of other applications behind the front window of ${pid}; active ${shown.active}; front application ${now}`);
      // The new window goes over the other windows of its application, which stand behind every window of other applications, so
      // no window of another application stands behind it.
      assert.equal(under, 0, `the new window of ${app.name} is in front of ${under} windows of other applications`);
      assert.equal(shown.active, false, `the new window of ${app.name} is active`);
    } finally {
      if (child) await child.close();
    }
  });
}
