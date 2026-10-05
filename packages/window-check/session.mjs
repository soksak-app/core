// 창 검사 실행의 시작. node:test 의 --test-global-setup 으로 첫 검사 파일보다 먼저 한 번 실행된다.
//
// 검사 전 활성 애플리케이션이 검사할 호스트이면 그 실행의 합성 포인터 측정은 모두 활성 애플리케이션을 재므로,
// 검사를 하나도 시작하지 않고 한 번 실패한다(docs/operations/examples.md).
import { existsSync } from "node:fs";
import { readEndpoint } from "@soksak/client";
import { APPS } from "./app.mjs";
import { sessionBaseline } from "./frontmost.mjs";

export async function globalSetup() {
  // 실행 파일이 없는 앱은 open 이 건너뛰므로 검사할 호스트가 아니다.
  const hosts = [];
  for (const app of Object.values(APPS)) {
    if (!existsSync(app.binary)) continue;
    hosts.push({ name: app.name, pid: (await readEndpoint(app.configDir)).pid });
  }
  sessionBaseline({ hosts });
}
