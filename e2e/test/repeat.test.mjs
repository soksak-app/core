// 창 검사 반복 도구가 실행한 검사 수를 출력 색과 무관하게 세는지 검사한다.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repeat = fileURLToPath(new URL("../repeat.mjs", import.meta.url));

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "soksak-repeat-"));
  t.after(() => rmSync(dir, { recursive: true }));
  const file = join(dir, "probe.test.mjs");
  writeFileSync(file, 'import test from "node:test";\ntest("probe passes", () => {});\n');
  return file;
}

// 반복 도구는 최상위 명령으로 실행된다. 이 검사의 node:test 실행 문맥(NODE_TEST_CONTEXT)은 넘기지 않는다.
const { NODE_TEST_CONTEXT, ...environment } = process.env;
const run = (file, name, color = "3") => spawnSync(process.execPath, [repeat, "--file", file, "--name", name, "--count", "2"],
  { encoding: "utf8", timeout: 20000, env: { ...environment, FORCE_COLOR: color } });

test("repeat counts passing runs when the test reporter writes colors", { timeout: 30000 }, (t) => {
  const result = run(fixture(t), "probe passes");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /PASS 2 runs/);
});

for (const color of ["3", "0"]) {
  test(`repeat rejects a name pattern that runs no test with FORCE_COLOR=${color}`, { timeout: 30000 }, (t) => {
    // 이름이 맞는 검사가 없어도 node:test 는 파일 자체를 통과 결과 하나로 보고한다.
    const result = run(fixture(t), "missing probe", color);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /no test ran for "missing probe"/);
  });
}

test("repeat prints the diagnostics of each passing run", { timeout: 30000 }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), "soksak-repeat-"));
  t.after(() => rmSync(dir, { recursive: true }));
  const file = join(dir, "probe.test.mjs");
  writeFileSync(file, 'import test from "node:test";\ntest("probe measures", (t) => { t.diagnostic("measured 5ms"); });\n');
  const result = run(file, "probe measures");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /PASS run 1 of 2: 1 tests\n {2}measured 5ms\nPASS run 2 of 2: 1 tests\n {2}measured 5ms\n/);
});
