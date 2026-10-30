#!/usr/bin/env node
// Finds Tauri commands of the Tauri host whose body runs on a worker of the async runtime. Tauri runs a command marked
// `async`, and every `async fn` command, as a task of its async runtime, which has one worker for each processor. A body
// that waits there (for a reply of a page, a lock or the main thread) holds a worker, so on a computer with few processors
// a few waiting commands stop every other command and reply until the waits end. Each async command therefore is an
// `async fn` whose body runs through `blocking(move || ...)`, which runs it on the blocking threads of the runtime, or
// awaits an async function of its module.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BINDINGS = "packages/host/tauriv2/src/bindings.rs";
const COMMAND = /#\[tauri::command(\(async\))?\]\n(async )?fn (\w+)\([^{]*\{\n\s*([^\n]*)/g;

/** Each async command of the source whose body does not run on the blocking threads, as { line, name, reason }. */
export function findWorkerBodies(source) {
  const found = [];
  for (const match of source.matchAll(COMMAND)) {
    const [, asyncAttribute, asyncFn, name, first] = match;
    const line = source.slice(0, match.index).split("\n").length;
    if (asyncAttribute && !asyncFn) found.push({ line, name, reason: "a synchronous body runs on a worker of the async runtime" });
    else if (asyncFn) {
      // An async command runs its body through blocking, or ends with the await of an async function of its module,
      // which owns the waits of its own.
      const body = source.slice(match.index, source.indexOf("\n}\n", match.index));
      if (!body.includes("blocking(move ||") && !/\n {4}\w+::\w+\([^\n]*\)\.await$/.test(body)) {
        found.push({ line, name, reason: "the body of an async command does not run through blocking(move || ...)" });
      }
    }
  }
  return found;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const found = findWorkerBodies(readFileSync(join(ROOT, BINDINGS), "utf8"));
  for (const item of found) console.error(`${BINDINGS}:${item.line}: ${item.name}: ${item.reason}`);
  if (found.length) {
    console.error(`Tauri command checks failed: ${found.length} commands run on a worker of the async runtime`);
    process.exit(1);
  }
  console.log("Tauri command checks passed");
}
