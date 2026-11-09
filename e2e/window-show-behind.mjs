// Measures where the first window of an application of a check stands among the windows of the screen
// (docs/spec/hosts.md#launch-activation).
import { runProcesses as runningCheckProcesses } from "@soksak/window-check/app.mjs";
import { frontmostApp as frontApp, windowPlace as placeOf, windowsBehind as behindOf } from "@soksak/window-check/frontmost.mjs";

/**
 * Relaunches the application of s in the background and reads the front application, the place of the front window of the new
 * process and the number of windows of other applications behind it, without the windows of the other applications of the run.
 * The rule places a window when it shows, and earlier checks and other applications move the windows of a running process
 * afterwards, so the place of the first window follows from the rule only right after a launch. The probes read the window list
 * of the screen unless a test gives its own.
 */
export async function firstWindowPlace(s, { frontmostApp = frontApp, windowPlace = placeOf, windowsBehind = behindOf,
  runProcesses = runningCheckProcesses } = {}) {
  await s.relaunch();
  const pid = s.client.endpoint.pid;
  const front = frontmostApp();
  const first = windowPlace(pid);
  const behind = windowsBehind(pid, runProcesses().filter((item) => item !== pid));
  return { pid, front, first, behind };
}
