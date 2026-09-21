import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

for (const [directory, crate] of [
  ["vt-alacritty", "soksak-sidecar-vt-alacritty"],
  ["vt-core", "soksak-sidecar-vt-core"],
]) {
  test(`${directory}: package test executes Rust tests and propagates failure`, { timeout: 10000 }, (t) => {
    const fixture = mkdtempSync(join(tmpdir(), "package-test-command-"));
    t.after(() => rmSync(fixture, { recursive: true, force: true }));
    const resultPath = join(fixture, "arguments.json");
    // 패키지 명령 연결만 검사한다. 실제 엔진 단언 통과로 세지 않는다.
    writeFileSync(join(fixture, "cargo"), `#!${process.execPath}\nconst {writeFileSync} = require('node:fs'); writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify(process.argv.slice(2))); process.exit(17);\n`, { mode: 0o755 });
    const result = spawnSync("pnpm", ["test"], {
      cwd: fileURLToPath(new URL(`../../sidecars/${directory}/`, import.meta.url)),
      env: { ...process.env, PATH: `${fixture}${delimiter}${process.env.PATH}` },
      encoding: "utf8", timeout: 5000,
    });
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0, "the test script must not report success without running tests");
    assert.deepEqual(JSON.parse(readFileSync(resultPath, "utf8")), ["test", "--manifest-path", "../Cargo.toml", "-p", crate]);
  });
}
