// 영속 터미널 사이드카 서비스가 죽었을 때 터미널 표면이 앱 재시작 없이 다시 붙는지 검사한다(V5-106).
// 서비스를 죽이고 새 세션이 열리며 입력이 화면에 도착하는지를 잰다.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";
import { ensureTerminals, readScreenUntil } from "./terminal-screen.mjs";

// 설정 디렉터리의 영속 서비스 디렉터리 하나가 담은 endpoint 를 읽는다.
// 영속 사이드카는 터미널 하나뿐이므로 services 아래 항목도 하나다.
function serviceEndpoint(configDir) {
  const services = readdirSync(join(configDir, "services"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory());
  assert.equal(services.length, 1, `expected one persistent service directory, found ${services.length}`);
  return {
    name: services[0].name,
    endpoint: JSON.parse(readFileSync(join(configDir, "services", services[0].name, "endpoint.json"), "utf8")),
  };
}

test("a killed terminal sidecar recovers without an application restart", async (t) => {
  for (const app of Object.values(APPS)) {
    const session = await open(t, app);
    if (!session) continue;
    await fresh(session);
    const [terminal] = await ensureTerminals(session, 1);
    const surface = terminal.surface;

    // 죽이기 전 세션이 살아 있고 입력이 화면에 도착한다.
    const before = await session.get("terminal.session", surface);
    assert.ok(before.sessionId, "the terminal session did not open before the kill");
    await session.run("terminal.input", { bytes: "echo V5106-BEFORE\r" }, surface);
    await readScreenUntil(session, surface,
      (lines) => lines.some((line) => line.includes("V5106-BEFORE")),
      "input before the kill did not reach the session");

    // 영속 서비스를 죽인다. 세션과 그림 상태는 서비스와 함께 사라진다.
    const { endpoint: killed } = serviceEndpoint(app.configDir);
    assert.ok(Number.isInteger(killed.pid) && killed.pid > 0, "the service endpoint has no pid");
    process.kill(killed.pid, "SIGKILL");

    // 복구: 표면이 다시 열린 세션에 붙는다. 죽은 세션의 sessionId 와 다른 값이 와야 한다.
    await session.until("terminal.session",
      (value) => typeof value.sessionId === "string" && value.sessionId !== "" && value.sessionId !== before.sessionId,
      "the terminal did not reopen a session after the sidecar died", { surface });
    const after = await session.get("terminal.session", surface);
    assert.equal(after.error, undefined, `the reopened session kept an error: ${after.error}`);

    // 복구 뒤 입력이 새 세션에 도달한다.
    await session.run("terminal.input", { bytes: "echo V5106-AFTER\r" }, surface);
    await readScreenUntil(session, surface,
      (lines) => lines.some((line) => line.includes("V5106-AFTER")),
      "input after the recovery did not reach the reopened session");

    // 서비스는 재스폰되어 새 pid 로 서 있다.
    const { endpoint: respawned } = serviceEndpoint(app.configDir);
    assert.notEqual(respawned.pid, killed.pid, "the service was not respawned after the kill");
  }
});
