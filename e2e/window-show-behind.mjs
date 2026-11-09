// Measures where the first window of an application of a check stands among the windows of the screen
// (docs/spec/hosts.md#launch-activation).
import { runProcesses as runningCheckProcesses } from "@soksak/window-check/app.mjs";
import { frontmostApp as frontApp, windowPlace as placeOf, windowsBehind as behindOf } from "@soksak/window-check/frontmost.mjs";

/**
 * The front application, the place of the front window of the application of s and the number of windows of other applications
 * behind it, without the windows of the other applications of the run. The probes read the window list of the screen unless a test
 * gives its own.
 */
export async function firstWindowPlace(s, { frontmostApp = frontApp, windowPlace = placeOf, windowsBehind = behindOf,
  runProcesses = runningCheckProcesses } = {}) {
  const pid = s.client.endpoint.pid;
  const front = frontmostApp();
  const first = windowPlace(pid);
  const behind = windowsBehind(pid, runProcesses().filter((item) => item !== pid));
  return { pid, front, first, behind };
}
