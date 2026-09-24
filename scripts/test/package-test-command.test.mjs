import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { loadavg, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

for (const [directory, crate] of [
  ["vt-alacritty", "soksak-sidecar-vt-alacritty"],
  ["vt-core", "soksak-sidecar-vt-core"],
]) {
  test(`${directory}: package test executes Rust tests and propagates failure`, { timeout: 60000 }, (t) => {
    const fixture = mkdtempSync(join(tmpdir(), "package-test-command-"));
    t.after(() => rmSync(fixture, { recursive: true, force: true }));
    const resultPath = join(fixture, "arguments.json");
    // 패키지 명령 연결만 검사한다. 실제 엔진 단언 통과로 세지 않는다.
    writeFileSync(join(fixture, "cargo"), `#!${process.execPath}\nconst {writeFileSync} = require('node:fs'); writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify(process.argv.slice(2))); process.exit(17);\n`, { mode: 0o755 });
    // 가짜 cargo 는 컴파일하지 않으므로 걸리는 시간은 pnpm 의 시작 시간이다. 다른 패키지의 테스트와 함께 돌면
    // 부하에 따라 길어지므로, 한도는 멈춤만 막고 실패하면 걸린 시간을 보고한다.
    const started = Date.now();
    const result = spawnSync("pnpm", ["test"], {
      cwd: fileURLToPath(new URL(`../../sidecars/${directory}/`, import.meta.url)),
      env: { ...process.env, PATH: `${fixture}${delimiter}${process.env.PATH}` },
      encoding: "utf8", timeout: 30000,
    });
    const elapsed = Date.now() - started;
    assert.equal(result.error, undefined, `pnpm test did not finish: ${result.error?.message} after ${elapsed} ms ` +
      `(load average ${loadavg().map((value) => value.toFixed(1)).join(" ")})`);
    t.diagnostic(`${directory}: pnpm test with the fixture cargo took ${elapsed} ms`);
    assert.notEqual(result.status, 0, "the test script must not report success without running tests");
    assert.deepEqual(JSON.parse(readFileSync(resultPath, "utf8")), ["test", "--manifest-path", "../Cargo.toml", "-p", crate]);
  });
}
