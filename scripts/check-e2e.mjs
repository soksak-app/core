// Checks that window checks use neither arbitrary code execution nor the former observation channels.
//
// Window checks use only the declared entries of the local endpoint (status, command, dom) and native input.
// There is no way to send code to a document and run it, and a check that writes such a call is rejected.
// State is awaited through status.watch notifications. Waits of a fixed duration and repeated queries are
// rejected. setTimeout may be used only as the upper bound of a wait (the wait is rejected when the time passes),
// or to record an observation through report (the record never settles the wait). The timer rule does not apply to
// the tests of the harness: they run on mocked time, and their timers simulate the input of a request.
// Checks every .mjs file under e2e and the window check harness (packages/window-check) (node_modules excluded).
//
//   node scripts/check-e2e.mjs
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = new URL("../", import.meta.url).pathname;
const DIRS = [join(ROOT, "e2e"), join(ROOT, "packages", "window-check")];

const RULES = [
  { what: "eval", pattern: /\beval(Async)?\b/ },
  { what: "Function constructor", pattern: /\bnew\s+Function\s*\(/ },
  { what: "native probe", pattern: /\bnativeProbe\b|["'`]native ["'`]\s*\+/ },
  { what: "TCP control port", pattern: /\b4973[1-3]\b|node:net/ },
  { what: "a repeating timer", pattern: /\bsetInterval\s*\(/ },
  { what: "a fixed sleep", pattern: /\b(sleep|delay|pause)\s*\(|timers\/promises/, inputPacing: true },
  { what: "application activation that takes user focus", pattern: /\bactivate\s*:\s*true\b/, activationTier: true },
  // The cleanup of a window check goes into session.cleanup. When the cleanup of open fails, a t.after registered after it does not run,
  // so a server or process remains and the check process does not end. The cleanup of a session runs every step even when one fails.
  { what: "t.after for cleanup; register it with session.cleanup", pattern: /\bt\.after\s*\(/, sessionCleanup: true },
  // A window check does not read source paths of other components and receives values through declared status entries.
  { what: "a source path of another repository component", pattern: /(["'`/]|\.\.\/)(packages|plugins|sidecars|native|apps)\// },
];

// The checks of e2e/activation and e2e/real run only in runs the user approved and may activate the app.
const ACTIVATION_DIRS = ["e2e/activation/", "e2e/real/"];
// The real input tool leaves an interval between HID events at the speed of a human movement. It is not a wait for state, and
// the window server coalesces drag events sent without an interval. A fixed wait is not allowed outside this file.
const INPUT_PACING_FILE = "e2e/real/hid.mjs";
// app.mjs of the harness, which creates sessions, and unit checks that are not window checks use t.after.
const SESSION_CLEANUP_EXEMPT = ["packages/window-check/app.mjs", "packages/window-check/test/", "e2e/test/"];

/* setTimeout is allowed only as the upper bound that the callback rejects. */
const TIMEOUT = /\bsetTimeout\s*\(/g;
const DEADLINE_WINDOW = 240;

function* sources(dir) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* sources(path);
    else if (name.endsWith(".mjs")) yield path;
  }
}

export function auditE2ESource(text, file) {
  const errors = [];
  text.split("\n").forEach((line, index) => {
    for (const rule of RULES) {
      if (rule.activationTier && ACTIVATION_DIRS.some((dir) => file.startsWith(dir))) continue;
      if (rule.inputPacing && file === INPUT_PACING_FILE) continue;
      if (rule.sessionCleanup && SESSION_CLEANUP_EXEMPT.some((exempt) => file === exempt || file.startsWith(exempt))) continue;
      if (rule.pattern.test(line)) errors.push(`${file}:${index + 1}: uses ${rule.what}`);
    }
  });
  const harnessTest = file.startsWith(join("packages", "window-check", "test") + sep);
  for (const match of text.matchAll(TIMEOUT)) {
    const deadband = text.slice(match.index, match.index + DEADLINE_WINDOW);
    if (/\breject\s*\(/.test(deadband)) continue;
    if (/\breport\s*\(/.test(deadband)) continue;
    if (harnessTest) continue;
    const line = text.slice(0, match.index).split("\n").length;
    errors.push(`${file}:${line}: uses setTimeout as a wait; a timeout must reject`);
  }
  return errors;
}

const errors = [];
for (const path of DIRS.flatMap((dir) => [...sources(dir)])) {
  errors.push(...auditE2ESource(readFileSync(path, "utf8"), relative(ROOT, path)));
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else {
    console.log("Window check sources use only the endpoint");
  }
}
