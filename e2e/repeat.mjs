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
for (let run = 1; run <= count; run++) {
  const result = spawnSync(process.execPath,
    ["--test", "--test-concurrency=1", `--test-name-pattern=${options.name}`, options.file],
    { cwd: directory, encoding: "utf8" });
  const output = `${result.stdout}${result.stderr}`;
  const passed = (output.match(/^ℹ pass (\d+)$/m) ?? [])[1];
  if (result.status !== 0) {
    process.stdout.write(output);
    console.error(`FAIL run ${run} of ${count}: ${options.file} "${options.name}"`);
    process.exit(1);
  }
  if (!passed || Number(passed) === 0) {
    console.error(`FAIL run ${run} of ${count}: no test ran for "${options.name}" in ${options.file} (none matched or all were skipped)`);
    process.exit(1);
  }
  console.log(`PASS run ${run} of ${count}: ${passed} tests`);
}
console.log(`PASS ${count} runs: ${options.file} "${options.name}"`);
