// A person who opens the application through the application launcher of the system sees it come to the front: the activation of
// the open brings the window that the host showed behind the front application forward, and the window becomes the active key window
// (docs/spec/hosts.md#launch-activation). The run starts each application without activation, so its window waits behind what
// a person uses; the check opens the running application through the launcher as a person does (openApplication, a platform
// operation), which activates the application, so it needs the activation that only a run that a person starts gives.
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { windowPlace } from "@soksak/window-check/frontmost.mjs";
import { fresh } from "../fixture.mjs";
import { listProcesses, openApplication } from "../platform/platform.js";

/** The other processes whose command line holds the executable. The launcher opens one instance of an application of its choice. */
async function otherInstances(executable, pid) {
  return (await listProcesses()).filter((item) => item.pid !== pid && item.arguments.includes(executable)).map((item) => item.pid);
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: an open through the application launcher brings the window to the front`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    const { pid, executable } = s.client.endpoint;
    assert.equal((await s.get("host.window")).active, false, `${app.name} is active before the open`);
    assert.deepEqual(await otherInstances(executable, pid), [],
      `other processes run ${executable}, so the launcher could open one of them instead of process ${pid}`);
    const before = windowPlace(pid);
    t.diagnostic(`process ${pid}: the window is at place ${before} before the open`);
    assert.ok(before > 0, `the window of ${app.name} is already at the front before the open`);
    await openApplication(executable);
    await s.until("host.window", (w) => w.active && w.key, "the open through the application launcher did not make the window the active key window");
    await s.presented();
    const after = windowPlace(pid);
    t.diagnostic(`process ${pid}: the window is at place ${after} after the open`);
    assert.equal(after, 0, `the window of ${app.name} is at place ${after} after the open, not in front of every window`);
  });
}
