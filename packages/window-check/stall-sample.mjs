// 답하지 않는 호스트의 그 순간 thread stack 을 남긴다(F69). 요청이 한도 안에 답하지 않은 동안 main thread 가 무엇을
// 했는지는 그때만 볼 수 있으므로, 검사는 그 순간 macOS 의 sample 로 호스트 프로세스의 모든 thread 를 기록한다. 같은
// 사용자의 프로세스는 권한 없이 sample 할 수 있다.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** sample 이 호스트를 지켜보는 초. 한 번의 짧은 기록으로 막힌 main thread 의 stack 이 드러난다. */
const SECONDS = 2;

/**
 * 프로세스 pid 의 thread stack 을 file 에 쓰고 file 을 반환한다. sample 이 실패하면 그 까닭으로 실패한다.
 *
 *   run(command, args)  spawnSync 와 같은 결과({status, stderr})를 반환하는 실행기. 검사가 바꿔 넣는다.
 */
export function sampleProcess(pid, file, run = (command, args) => spawnSync(command, args, { encoding: "utf8" })) {
  const result = run("/usr/bin/sample", [String(pid), String(SECONDS), "-file", file]);
  if (result.error) throw new Error(`sample ${pid}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`sample ${pid} exited with ${result.status}: ${String(result.stderr).trim()}`);
  return file;
}

/**
 * 호스트가 기록한 WebKit 자식(설정 폴더의 webkit-children.json) 중 page 를 실행하는 WebContent 프로세스. page 가 답하지
 * 않은 동안 그 JavaScript 는 호스트가 아니라 이 프로세스에서 실행되므로 함께 기록한다. 기록이 없거나 형식이 다르면 실패한다.
 */
export function pageProcesses(configDir) {
  const file = join(configDir, "webkit-children.json");
  let record;
  try {
    record = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${file}: ${error.message}`);
  }
  if (!Array.isArray(record.children)) throw new Error(`${file}: children is not a list`);
  return record.children.filter((child) => child.kind === "WebContent").map((child) => child.pid);
}

/**
 * 답하지 않은 호스트 host 와 그 page 프로세스 pages 의 thread 를 directory 에 기록하고, 프로세스마다 그 파일이나 기록하지
 * 못한 까닭을 반환한다. 기록은 페이지를 다시 읽은 뒤 끝난 WebContent 도 담을 수 있으므로, 한 프로세스를 기록하지 못해도
 * 나머지는 기록한다. 호스트를 기록하지 못하면 그 까닭으로 실패한다. 파일 이름은 호스트 pid 와 time 을 공유한다.
 */
export function sampleStall({ host, pages, directory, time = Date.now(), sample = sampleProcess }) {
  const base = join(directory, `stall-${host}-${time}`);
  const records = [sample(host, `${base}.txt`)];
  for (const pid of pages) {
    try {
      records.push(sample(pid, `${base}-page-${pid}.txt`));
    } catch (error) {
      records.push(`page ${pid} not sampled: ${error.message}`);
    }
  }
  return records;
}
