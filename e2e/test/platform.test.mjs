// The platform operations of the window checks are explicit contracts: importing the selector never depends on the operating system,
// and an operation that the platform does not implement rejects with its named error when it is called. Input sources are selected by
// role, so no window check names an input source of a platform.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as selector from "../platform/platform.js";
import { debugBinaries, PlatformOperationNotImplemented } from "../platform/platform.js";

const E2E = fileURLToPath(new URL("../", import.meta.url));

for (const platform of ["linux", "win32"]) {
  test(`${platform}: importing the window-check platform selector does not throw, and its unimplemented operations name themselves when called`, { timeout: 10000 }, () => {
    const url = new URL("../platform/platform.js", import.meta.url).href;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
      Object.defineProperty(process, "platform", { value: ${JSON.stringify(platform)} });
      const selected = await import(${JSON.stringify(url)});
      let message;
      try { await selected.debugBinaries("/work/target"); message = "passed"; }
      catch (error) { message = error.name + ": " + error.message; }
      process.stdout.write(JSON.stringify(message));
    `], { encoding: "utf8", timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout), `PlatformOperationNotImplemented: applicationArtifact is not implemented on ${platform}`);
  });
}

test("an injected platform without an implementation rejects with the named error only when the operation is called", async () => {
  for (const platform of ["linux", "win32", "unknown"]) {
    await assert.rejects(() => debugBinaries("/work/target", { platform }), PlatformOperationNotImplemented);
    await assert.rejects(() => debugBinaries("/work/target", { platform }),
      { message: `applicationArtifact is not implemented on ${platform}` });
  }
});

test("the window-check selector declares the debug executables and no input source of a platform", async () => {
  assert.deepEqual(Object.keys(selector).sort(), ["PlatformOperationNotImplemented", "debugBinaries", "listProcesses", "openApplication"]);
  assert.deepEqual(await debugBinaries("/work/target", { platform: "darwin" }), {
    SOKSAK_BINARY_WAILSV3: "/work/target/debug/sok-wailsv3.app/Contents/MacOS/sok-wailsv3",
    SOKSAK_BINARY_TAURIV2: "/work/target/debug/sok-tauriv2.app/Contents/MacOS/sok-tauriv2",
    SOKSAK_BINARY_MYGO: "/work/target/debug/sok-mygo.app/Contents/MacOS/sok-mygo",
  });
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
