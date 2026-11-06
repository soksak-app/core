// A person who opens the application through Launch Services sees it come to the front: the activation of the open brings the
// window that the host showed behind the front application forward, and the window becomes the active key window
// (docs/spec/hosts.md#launch-activation). The run starts each application without activation, so its window waits behind what
// a person uses; the check opens the bundle of the running process through Launch Services as a person does, which activates
// the application, so it needs the activation that only a run that a person starts gives.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { windowPlace } from "@soksak/window-check/frontmost.mjs";
import { fresh } from "../fixture.mjs";

/** The bundle folder that holds the executable. */
function bundleOf(executable) {
  const end = executable.indexOf(".app/");
  assert.ok(end > 0, `the executable ${executable} is not inside a bundle`);
  return executable.slice(0, end + ".app".length);
}

/** The other processes whose command line holds the executable. Launch Services opens one instance of a bundle of its choice. */
function otherInstances(executable, pid) {
  try {
    return execFileSync("pgrep", ["-f", executable], { encoding: "utf8" }).split("\n").filter(Boolean).map(Number)
      .filter((item) => item !== pid);
  } catch (error) {
    // pgrep answers 1 when no process matches.
    if (error.status === 1) return [];
    throw error;
  }
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: an open through Launch Services brings the window to the front`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    const { pid, executable } = s.client.endpoint;
    assert.equal((await s.get("host.window")).active, false, `${app.name} is active before the open`);
    assert.deepEqual(otherInstances(executable, pid), [],
      `other processes run ${executable}, so Launch Services could open one of them instead of process ${pid}`);
    const before = windowPlace(pid);
    t.diagnostic(`process ${pid}: the window is at place ${before} before the open`);
    assert.ok(before > 0, `the window of ${app.name} is already at the front before the open`);
    execFileSync("open", ["-a", bundleOf(executable)]);
    await s.until("host.window", (w) => w.active && w.key, "the open through Launch Services did not make the window the active key window");
    await s.presented();
    const after = windowPlace(pid);
    t.diagnostic(`process ${pid}: the window is at place ${after} after the open`);
    assert.equal(after, 0, `the window of ${app.name} is at place ${after} after the open, not in front of every window`);
  });
}
