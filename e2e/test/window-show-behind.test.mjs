import assert from "node:assert/strict";
import test from "node:test";

import { firstWindowPlace, newWindowPlace } from "../window-show-behind.mjs";

// A session whose relaunch starts a new process, and probes that record when they read the window list of the screen.
function scene() {
  const steps = [];
  const s = {
    client: { endpoint: { pid: 100 } },
    async relaunch() {
      steps.push("relaunch");
      this.client = { endpoint: { pid: 200 } };
    },
  };
  const probes = {
    frontmostApp: () => { steps.push("front"); return 1; },
    windowPlace: (pid) => { steps.push(`place ${pid}`); return 4; },
    windowsBehind: (pid, except) => { steps.push(`behind ${pid} without ${except.join(",")}`); return 0; },
    runProcesses: () => [200, 300],
  };
  return { s, probes, steps };
}

test("the first window is measured at its show, after a relaunch that starts the application in the background", async () => {
  // The rule places a window when it shows, and earlier checks and other applications move the windows of a running process
  // afterwards, so the place of its first window only follows from the rule right after a launch (docs/spec/hosts.md#launch-activation).
  const { s, probes, steps } = scene();
  const measured = await firstWindowPlace(s, probes);
  assert.deepEqual(steps, ["relaunch", "front", "place 200", "behind 200 without 300"]);
  assert.deepEqual(measured, { pid: 200, front: 1, first: 4, behind: 0 });
});

test("a new window is judged by the windows of other applications behind it, which a person cannot change", async () => {
  // A person who brings another application forward or opens windows puts windows in front of the windows of the check, so the
  // front application and the place of a window change with the person. The windows of other applications behind the front
  // window of the check process change only when that process orders its own window over them, so the measurement reads only
  // them, and the front application only for the diagnostic (AGENTS.md, docs/spec/hosts.md#launch-activation).
  const steps = [];
  const probes = {
    frontmostApp: () => { steps.push("front"); return 7; },
    windowsBehind: (pid, except) => { steps.push(`behind ${pid} without ${except.join(",")}`); return 0; },
    runProcesses: () => [200, 300],
  };
  const measured = await newWindowPlace(200, probes);
  assert.deepEqual(steps, ["behind 200 without 300", "front"]);
  assert.deepEqual(measured, { behind: 0, front: 7 });
});
