// A window that an application shows while it is not active stays behind the front window, and the front application
// stays (docs/spec/hosts.md#launch-activation). The application of a check is launched without activation and a person
// uses another application in front, so the first window and a new window of the check stay behind that application.
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, open, runProcesses } from "@soksak/window-check/app.mjs";
import { frontmostApp, windowPlace, windowsBehind } from "@soksak/window-check/frontmost.mjs";
import { fresh } from "./fixture.mjs";

for (const app of Object.values(APPS)) {
  test(`${app.name}: a window of a check opens behind the front window and the front application stays`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    if (!s) return;
    const pid = s.client.endpoint.pid;
    const front = frontmostApp();
    const first = windowPlace(pid);
    const others = runProcesses().filter((item) => item !== pid);
    const behind = windowsBehind(pid, others);
    t.diagnostic(`front application ${front}; application ${pid}; first window at place ${first}, ${behind} windows of other applications behind it`);
    assert.notEqual(front, pid, `${app.name} is the front application, so the check ran without another application in front`);
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
      const place = windowPlace(pid);
      const shown = await child.get("host.window");
      t.diagnostic(`new window at place ${place}; active ${shown.active}; front application ${frontmostApp()}`);
      // The new window goes over the other windows of its application and stays behind the front application.
      assert.equal(place, first, `the new window of ${app.name} is at place ${place}, not in front of its own windows at place ${first}`);
      assert.equal(frontmostApp(), front, `the new window of ${app.name} took the front from ${front}`);
      assert.equal(shown.active, false, `the new window of ${app.name} is active`);
    } finally {
      if (child) await child.close();
    }
  });
}
