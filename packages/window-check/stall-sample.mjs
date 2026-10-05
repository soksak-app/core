// 답하지 않는 호스트의 그 순간 thread stack 을 남긴다(F69). 요청이 한도 안에 답하지 않은 동안 main thread 가 무엇을
// 했는지는 그때만 볼 수 있으므로, 검사는 그 순간 macOS 의 sample 로 호스트 프로세스의 모든 thread 를 기록한다. 같은
// 사용자의 프로세스는 권한 없이 sample 할 수 있다.
import { spawnSync } from "node:child_process";

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
