#!/usr/bin/env node
// Finds Objective-C windows of the native package that close without an owner. NSWindow releases itself when it closes
// unless releasedWhenClosed is NO, so a window that its creator also releases, directly or through an autorelease pool,
// is released twice, and the second release reaches a deallocated object when AppKit has let the window go. The
// statement right after each NSWindow allocation sets releasedWhenClosed to NO, so the creator owns the window alone.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = /^native\/darwin\/.*\.mm?$/;
const ALLOCATION = /\[NSWindow alloc\]/g;

/** The end of the statement that starts before index: the next semicolon outside brackets and parentheses. */
function statementEnd(source, index) {
  let depth = 0;
  for (let i = index; i < source.length; i++) {
    const c = source[i];
    if (c === "[" || c === "(") depth++;
    else if (c === "]" || c === ")") depth--;
    else if (c === ";" && depth <= 0) return i + 1;
  }
  return source.length;
}

/** Each NSWindow allocation of the files whose next statement does not set releasedWhenClosed of the window to NO. */
export function findUnownedWindows(files, read) {
  const found = [];
  for (const file of files) {
    if (!SOURCE.test(file)) continue;
    const source = read(file);
    for (const match of source.matchAll(ALLOCATION)) {
      const start = source.lastIndexOf("\n", match.index) + 1;
      const head = source.slice(start, match.index);
      const line = source.slice(0, match.index).split("\n").length;
      const assigned = /([A-Za-z_][\w.]*(?:\[\w+\])?)\s*=\s*\[*\s*$/.exec(head);
      if (!assigned) {
        found.push({ file, line, reason: "the window is not assigned to a name" });
        continue;
      }
      const name = assigned[1];
      const end = statementEnd(source, match.index);
      const next = source.slice(end, statementEnd(source, end)).trim();
      const owned = next === `${name}.releasedWhenClosed = NO;` || next === `[${name} setReleasedWhenClosed:NO];`;
      if (!owned) found.push({ file, line, reason: `the next statement does not set ${name}.releasedWhenClosed = NO` });
    }
  }
  return found;
}

function trackedFiles() {
  return execFileSync("git", ["ls-files", "native/darwin"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const found = findUnownedWindows(trackedFiles(), (file) => readFileSync(join(ROOT, file), "utf8"));
  for (const item of found) console.error(`${item.file}:${item.line}: ${item.reason}`);
  if (found.length) {
    console.error(`Native window checks failed: ${found.length} windows without an owner`);
    process.exit(1);
  }
  console.log("Native window checks passed");
}
