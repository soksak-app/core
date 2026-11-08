// The platform operations of the window checks are explicit contracts: importing the selector never depends on the operating system,
// and an operation that the platform does not implement throws its named error when it is called.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { debugBinaries, inputSources, PlatformOperationNotImplemented } from "../platform/platform.js";

const E2E = fileURLToPath(new URL("../", import.meta.url));

for (const platform of ["linux", "win32"]) {
  test(`${platform}: importing the window-check platform selector does not throw, and its unimplemented operations name themselves when called`, { timeout: 10000 }, () => {
    const selector = new URL("../platform/platform.js", import.meta.url).href;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
      Object.defineProperty(process, "platform", { value: ${JSON.stringify(platform)} });
      const selected = await import(${JSON.stringify(selector)});
      const messages = [];
      for (const call of [() => selected.debugBinaries("/work/target"), () => selected.inputSources()]) {
        try { call(); messages.push("passed"); }
        catch (error) { messages.push(error.name + ": " + error.message); }
      }
      process.stdout.write(JSON.stringify(messages));
    `], { encoding: "utf8", timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), [
      `PlatformOperationNotImplemented: application artifact is not implemented on ${platform}`,
      `PlatformOperationNotImplemented: keyboard input sources is not implemented on ${platform}`,
    ]);
  });
}

test("an injected platform without an implementation throws the named error only when the operation is called", () => {
  for (const platform of ["linux", "win32", "unknown"]) {
    assert.throws(() => debugBinaries("/work/target", { platform }),
      { name: "PlatformOperationNotImplemented", message: `application artifact is not implemented on ${platform}` });
    assert.throws(() => inputSources({ platform }), PlatformOperationNotImplemented);
    assert.throws(() => inputSources({ platform }), { message: `keyboard input sources is not implemented on ${platform}` });
  }
});

test("the macOS platform declares the debug executables and the input sources of the activation checks", () => {
  assert.deepEqual(debugBinaries("/work/target", { platform: "darwin" }), {
    SOKSAK_BINARY_WAILSV3: "/work/target/debug/sok-wailsv3.app/Contents/MacOS/sok-wailsv3",
    SOKSAK_BINARY_TAURIV2: "/work/target/debug/sok-tauriv2.app/Contents/MacOS/sok-tauriv2",
    SOKSAK_BINARY_MYGO: "/work/target/debug/sok-mygo.app/Contents/MacOS/sok-mygo",
  });
  assert.deepEqual(inputSources({ platform: "darwin" }), {
    latin: "com.apple.keylayout.ABC",
    korean: "com.apple.inputmethod.Korean.2SetKorean",
    japanese: "com.apple.inputmethod.Kotoeri.RomajiTyping.Japanese",
  });
});

/** The .mjs files of the window checks, without the platform owners and the unit tests of the checks. */
function windowCheckFiles(folder = E2E) {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const path = join(folder, entry.name);
    const name = relative(E2E, path);
    if (entry.isDirectory()) return ["node_modules", "platform", "test", "fixtures"].includes(name) ? [] : windowCheckFiles(path);
    return entry.name.endsWith(".mjs") ? [name] : [];
  });
}

test("activation checks name no Apple input-source identifier outside the macOS platform owner", () => {
  const files = windowCheckFiles();
  assert.ok(files.includes(join("activation", "ime.test.mjs")), files.join("\n"));
  const named = files.filter((file) => /com\.apple\.(keylayout|inputmethod)\./.test(readFileSync(join(E2E, file), "utf8")));
  assert.deepEqual(named, []);
});
