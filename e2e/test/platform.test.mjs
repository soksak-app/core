// The platform operations of the window checks are explicit contracts: importing the selector never depends on the operating system,
// and an operation that the platform does not implement rejects with its named error when it is called. Input sources are selected by
// role, so no window check names an input source of a platform.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as selector from "../platform/platform.js";
import { debugBinaries, PlatformOperationNotImplemented } from "../platform/platform.js";

const E2E = fileURLToPath(new URL("../", import.meta.url));

// The debug executables of the macOS applications are checked by test/platform/darwin/system/debug-binaries.test.mjs.
test("the window-check selector exports its operations and the named error", () => {
  assert.deepEqual(Object.keys(selector).sort(), ["PlatformOperationNotImplemented", "debugBinaries", "listProcesses", "openApplication"]);
  assert.equal(typeof debugBinaries, "function");
  assert.equal(typeof PlatformOperationNotImplemented, "function");
});

/** The .mjs files of the window checks, without the unit tests of the checks and their fixtures. */
function windowCheckFiles(folder = E2E) {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const path = join(folder, entry.name);
    const name = relative(E2E, path);
    if (entry.isDirectory()) return ["node_modules", "test", "fixtures"].includes(name) ? [] : windowCheckFiles(path);
    return entry.name.endsWith(".mjs") || entry.name.endsWith(".js") ? [name] : [];
  });
}

test("window checks select input sources by role and name no input source of a platform", () => {
  const files = windowCheckFiles();
  assert.ok(files.includes(join("activation", "ime.test.mjs")), files.join("\n"));
  const named = files.filter((file) => /com\.apple\.(keylayout|inputmethod)|inputSources/.test(readFileSync(join(E2E, file), "utf8")));
  assert.deepEqual(named, []);
  // Every literal value of select is an input source role.
  const roles = new Set(["latin", "korean", "japanese"]);
  const selected = files.flatMap((file) => [...readFileSync(join(E2E, file), "utf8")
    .matchAll(/(?:\{ select: |selectInputSource\(|\{ source: )"([^"]*)"/g)].map((match) => `${file}: ${match[1]}`));
  assert.ok(selected.length > 0, "the window checks select no input source");
  assert.deepEqual(selected.filter((entry) => !roles.has(entry.split(": ")[1])), []);
});
