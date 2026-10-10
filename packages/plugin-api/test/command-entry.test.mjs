import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// A package manager places a package as a link in the node_modules of the plugin repository. The command must run the check even when it starts with that link path
// (docs/spec/installation.md). The link is a temporary fixture that this check creates.
test("the plugin commands run their check when started through a linked package", () => {
  const root = mkdtempSync(join(tmpdir(), "soksak-command-entry-"));
  try {
    const linked = join(root, "node_modules", "@soksak", "plugin-api");
    mkdirSync(join(root, "node_modules", "@soksak"), { recursive: true });
    symlinkSync(new URL("..", import.meta.url).pathname, linked);
    writeFileSync(join(root, "package.json"), JSON.stringify({ engines: { soksak: "^0.0.1" } }));
    assert.throws(() => execFileSync(process.execPath, [join(linked, "engines-check.js"), root], { encoding: "utf8", stdio: "pipe" }),
      (error) => error.status === 1 && /engines\.soksak \^0\.0\.1 must be/.test(error.stderr));
    writeFileSync(join(root, "plugin.json"), JSON.stringify({ id: "probe" }));
    const output = execFileSync(process.execPath, [join(linked, "exposure-check.js"), root], { encoding: "utf8", stdio: "pipe" });
    assert.equal(output, "Exposure checks passed: plugin probe\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
