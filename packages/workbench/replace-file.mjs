// 스테이징한 실행 파일을 새 파일로 바꾼다.
//
// macOS 는 실행 파일의 코드 서명 정보를 파일(vnode)에 보관한다. 실행된 적이 있는 파일을 같은
// 자리에서 덮어쓰면 이전 서명 정보가 남아, 새 내용으로 시작한 프로세스를 커널이 종료한다(SIGKILL).
// 같은 디렉터리의 임시 파일에 쓴 뒤 이름을 바꾸면 새 파일이 된다.
import { copyFileSync, renameSync, rmSync } from "node:fs";

/** from 을 to 로 복사한다. to 는 기존 파일과 다른 새 파일이 된다. 권한은 from 과 같다. */
export function replaceFile(from, to) {
  const pending = `${to}.partial-${process.pid}`;
  try {
    copyFileSync(from, pending);
    renameSync(pending, to);
  } catch (error) {
    rmSync(pending, { force: true });
    throw error;
  }
}
