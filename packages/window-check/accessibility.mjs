// Reads what the accessibility API reports of the windows of an application, for the benchmarks that count those elements. It reads
// only: it posts no input and brings no window to the front. The terminal that runs it needs the Accessibility permission.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Runs a script as osascript JavaScript and returns the JSON result.
function jxa(body) {
  const script = `ObjC.import("ApplicationServices");
function run(argv) { const input = JSON.parse(argv[0]); ${body} }`;
  return (input = {}) => {
    const output = execFileSync("osascript", ["-l", "JavaScript", "-e", script, JSON.stringify(input)], { encoding: "utf8" });
    return output.trim() === "" ? null : JSON.parse(output);
  };
}

/** Whether the process that runs this script has the Accessibility permission; it reads the permission and asks for nothing. */
export const trusted = jxa(`return JSON.stringify($.AXIsProcessTrusted());`);

/** The application process that endpoint.json of the configuration directory names. */
function appPid(app) {
  return JSON.parse(readFileSync(join(app.configDir, "endpoint.json"), "utf8")).pid;
}

const windowRoles = jxa(`
const found = Application("System Events").processes.whose({ unixId: input.pid });
if (found.length === 0) return JSON.stringify(null);
const windows = found[0].windows();
const roles = [];
for (const window of windows) {
  roles.push(window.role());
  for (const element of window.entireContents()) roles.push(element.role());
}
return JSON.stringify({ windows: windows.length, roles });`);

/**
 * The accessibility elements of the windows of an application as the accessibility API reads them (`read` is the reply of System
 * Events: the number of windows and the role of each window and of each element in it): { windows, elements, roles }, where roles counts
 * the elements of each role. `name` names the application in the errors.
 */
export function windowElementsOf(read, name) {
  if (read === null) throw new Error(`System Events has no process with the pid of ${name}`);
  if (read.windows === 0) throw new Error(`${name} has no window that the accessibility API reads`);
  const roles = {};
  for (const role of read.roles) roles[role] = (roles[role] ?? 0) + 1;
  return { windows: read.windows, elements: read.roles.length, roles };
}

/** The accessibility elements of the windows of the application `app` (windowElementsOf). */
export function readWindowElements(app) {
  assert.equal(trusted(), true, "the terminal that reads the accessibility elements has no Accessibility permission");
  return windowElementsOf(windowRoles({ pid: appPid(app) }), app.name);
}
