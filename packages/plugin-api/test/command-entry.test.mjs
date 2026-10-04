import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// package manager 는 plugin repository 의 node_modules 에 package 를 link 로 둔다. 명령은 그 link 경로로 시작해도
// 검사를 실행해야 한다(docs/spec/installation.md). link 는 이 검사가 만드는 임시 fixture 다.
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
