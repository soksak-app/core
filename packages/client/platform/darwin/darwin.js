// darwin 의 로컬 엔드포인트 전송: 소유자 전용 디렉터리의 Unix 도메인 소켓.
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const name = "darwin";
export const transport = "unix";

/** 권한 0700 의 임시 디렉터리에 소켓 경로를 만든다. remove 는 디렉터리를 제거한다. */
export function createAddress(label) {
  const directory = mkdtempSync(join(tmpdir(), `${label}-`));
  chmodSync(directory, 0o700);
  return {
    address: join(directory, "endpoint.sock"),
    remove: () => rmSync(directory, { recursive: true, force: true }),
  };
}
