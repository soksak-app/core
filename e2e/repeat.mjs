// 창 검사 하나를 정한 횟수만큼 차례로 실행하고, 처음 실패한 실행에서 멈춘다.
//
//   pnpm -F @soksak/e2e run repeat --file terminal.test.mjs --name "<검사 이름>" --count 16
//
// 간헐 실패의 재현과 수용은 이 대상으로 한다. 실행마다 새 node:test 프로세스를 쓰며, 앱을 실행하지
// 않는다. SOKSAK_APP 으로 호스트 하나를 고를 수 있다.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const USAGE = "usage: repeat.mjs --file <test file> --name <test name pattern> --count <n>";
const options = {};
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 2) {
  const key = args[i];
  const value = args[i + 1];
  if (!["--file", "--name", "--count"].includes(key) || value === undefined || key.slice(2) in options) {
    console.error(USAGE);
    process.exit(2);
  }
  options[key.slice(2)] = value;
}
const count = Number(options.count);
if (!options.file || !options.name || !Number.isInteger(count) || count < 1) {
  console.error(USAGE);
  process.exit(2);
}

const directory = fileURLToPath(new URL(".", import.meta.url));
const pattern = new RegExp(options.name);
for (let run = 1; run <= count; run++) {
  // 실행한 검사 수는 기계 형식인 TAP 에서 센다. 사람이 읽는 출력은 환경에 따라 색 코드가 붙는다. 이름이
  // 맞는 검사가 없으면 파일 자체가 결과 한 줄로 보고되므로, 제목이 이름 패턴에 맞고 건너뛰지 않은 결과만 센다.
  const result = spawnSync(process.execPath,
    ["--test", "--test-concurrency=1", "--test-reporter=tap", `--test-name-pattern=${options.name}`, options.file],
    { cwd: directory, encoding: "utf8" });
  const output = `${result.stdout}${result.stderr}`;
  const passed = result.stdout.split("\n")
    .map((line) => /^\s*ok \d+ - (.*)$/.exec(line)?.[1])
    .filter((title) => title !== undefined && !/# SKIP/.test(title) && pattern.test(title)).length;
  if (result.status !== 0) {
    process.stdout.write(output);
    console.error(`FAIL run ${run} of ${count}: ${options.file} "${options.name}"`);
    process.exit(1);
  }
  if (passed === 0) {
    console.error(`FAIL run ${run} of ${count}: no test ran for "${options.name}" in ${options.file} (none matched or all were skipped)`);
    process.exit(1);
  }
  console.log(`PASS run ${run} of ${count}: ${passed} tests`);
}
console.log(`PASS ${count} runs: ${options.file} "${options.name}"`);
