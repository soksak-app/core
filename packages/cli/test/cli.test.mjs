import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
// pnpm install 전에도 실행되도록 가짜 엔드포인트는 상대 경로로 가져온다.
import { sampleHandlers, startFakeEndpoint } from "@soksak/client/testing";

const cli = fileURLToPath(new URL("../cli.js", import.meta.url));

// 명령을 실행하고 종료 코드와 출력을 반환한다.
function run(args, { onStdout } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      onStdout?.(stdout, child);
    });
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function fixture(t) {
  const sample = sampleHandlers();
  const server = await startFakeEndpoint(sample.handlers);
  t.after(() => server.close());
  return { sample, server, dir: ["--config-dir", server.configDir] };
}

test("windows prints the window list as JSON", async (t) => {
  const { dir } = await fixture(t);
  const result = await run(["windows", ...dir]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [{ window: "main", title: "soksak", project: null, key: true, ready: true }]);
});

test("list sends exposure.list for the window", async (t) => {
  const { server, dir } = await fixture(t);
  const result = await run(["list", "--window", "main", ...dir]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).commands[0].name, "core.project.open");
  assert.deepEqual(server.requests[0].params, { window: "main" });
});

test("status prints the current value", async (t) => {
  const { dir } = await fixture(t);
  const result = await run(["status", "core.screen", "--window", "main", ...dir]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout), "home");
});

test("status --watch prints the current value and each change", async (t) => {
  const { sample, dir } = await fixture(t);
  let step = 0;
  const result = await run(["status", "core.screen", "--window", "main", "--watch", ...dir], {
    onStdout(stdout, child) {
      const lines = stdout.trim().split("\n");
      if (step === 0 && lines.length >= 1) {
        step = 1;
        sample.set("core.screen", "project");
      } else if (step === 1 && lines.length >= 2) {
        step = 2;
        child.kill("SIGINT");
      }
    },
  });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split("\n").map((line) => JSON.parse(line)), ["home", "project"]);
});

test("status --watch fails when the connection closes", async (t) => {
  const { server, dir } = await fixture(t);
  const result = await run(["status", "core.screen", "--window", "main", "--watch", ...dir], {
    onStdout() {
      for (const connection of server.connections) connection.socket.destroy();
    },
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /connection closed/);
});

test("run passes JSON params", async (t) => {
  const { server, dir } = await fixture(t);
  const result = await run(["run", "core.project.open", "--window", "main", "--params", '{"root":"/p"}', ...dir]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { opened: "/p" });
  assert.deepEqual(server.requests[0].params, { window: "main", name: "core.project.open", params: { root: "/p" } });
});

test("dom subcommands map to dom.rect and dom.act", async (t) => {
  const { server, dir } = await fixture(t);
  const rect = await run(["dom", "rect", "core.tab", "--window", "main", "--index", "2", ...dir]);
  assert.equal(rect.code, 0, rect.stderr);
  assert.equal(JSON.parse(rect.stdout).index, 2);
  assert.equal((await run(["dom", "click", "core.tab", "--window", "main", ...dir])).code, 0);
  assert.equal((await run(["dom", "input", "core.tab", "--window", "main", "--value", "abc", ...dir])).code, 0);
  assert.equal((await run(["dom", "dispatch", "core.tab", "--window", "main", "--event", '{"type":"keydown","key":"Escape"}', ...dir])).code, 0);
  assert.deepEqual(
    server.requests.map((m) => [m.method, m.params]),
    [
      ["dom.rect", { window: "main", name: "core.tab", index: 2 }],
      ["dom.act", { window: "main", name: "core.tab", action: "click" }],
      ["dom.act", { window: "main", name: "core.tab", action: "input", value: "abc" }],
      ["dom.act", { window: "main", name: "core.tab", action: "dispatch", event: { type: "keydown", key: "Escape" } }],
    ],
  );
});

test("input subcommands map to input.pointer and input.key", async (t) => {
  const { server, dir } = await fixture(t);
  const pointer = await run(["input", "pointer", "--window", "main", "--x", "5", "--y", "6.5", "--phase", "down", "--button", "right", ...dir]);
  assert.equal(pointer.code, 0, pointer.stderr);
  const move = await run(["input", "pointer", "--window", "main", "--x", "1", "--y", "2", "--phase", "move", "--activate", ...dir]);
  assert.equal(move.code, 0, move.stderr);
  const key = await run(["input", "key", "--window", "main", "--key", "a", "--phase", "down", "--modifiers", "shift,command", ...dir]);
  assert.equal(key.code, 0, key.stderr);
  assert.deepEqual(server.requests.map((m) => [m.method, m.params]), [
    ["input.pointer", { window: "main", x: 5, y: 6.5, phase: "down", button: "right" }],
    ["input.pointer", { window: "main", x: 1, y: 2, phase: "move", activate: true }],
    ["input.key", { window: "main", key: "a", phase: "down", modifiers: ["shift", "command"] }],
  ]);
});

test("endpoint errors exit non-zero with the message and code", async (t) => {
  const { dir } = await fixture(t);
  const result = await run(["status", "core.screen", "--window", "other", ...dir]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /window other does not exist \(1003\)/);
  assert.equal(result.stdout, "");
});

test("an inactive window error is printed with its message and code", async (t) => {
  const { sample, dir } = await fixture(t);
  sample.state.key = false;
  const result = await run(["input", "pointer", "--window", "main", "--x", "1", "--y", "1", "--phase", "move", ...dir]);
  assert.equal(result.code, 1);
  assert.equal(result.stderr, "soksak: window main is not the key window; pass activate to make it key (1006)\n");
});

test("usage errors exit with code 2", async (t) => {
  const { dir } = await fixture(t);
  assert.equal((await run(["status", "core.screen", ...dir])).code, 2);
  assert.equal((await run(["run", "x", "--window", "main", "--params", "{", ...dir])).code, 2);
  assert.equal((await run(["input", "pointer", "--window", "main", "--x", "a", "--y", "1", "--phase", "move", ...dir])).code, 2);
  assert.equal((await run(["windows", "--unknown", ...dir])).code, 2);
  assert.equal((await run(["dom", "dispatch", "core.tab", "--window", "main", ...dir])).code, 2, "dispatch needs --event");
  assert.equal((await run(["dom", "dispatch", "core.tab", "--window", "main", "--event", '"keydown"', ...dir])).code, 2);
  assert.equal((await run(["dom", "dispatch", "core.tab", "--window", "main", "--event", "{", ...dir])).code, 2);
  assert.equal((await run(["input", "pointer", "--window", "main", "--x", "1", "--y", "1", "--phase", "down", "--button", "0", ...dir])).code, 2);
  assert.equal((await run(["input", "pointer", "--window", "main", "--x", "1", "--y", "1", "--phase", "down", "--activate", ...dir])).code, 2);
  const missing = await run(["windows"]);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /--config-dir is required/);
});

test("a missing endpoint.json exits non-zero naming the file", async (t) => {
  const result = await run(["windows", "--config-dir", "/nonexistent/soksak"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /\/nonexistent\/soksak\/endpoint\.json/);
});

test("--surface names the surface of status, run, and dom requests", async (t) => {
  const { server, dir } = await fixture(t);
  assert.equal((await run(["status", "core.screen", "--window", "main", "--surface", "tab-a", ...dir])).code, 0);
  assert.equal((await run(["run", "core.project.open", "--window", "main", "--surface", "tab-a", ...dir])).code, 0);
  assert.equal((await run(["dom", "rect", "core.tab", "--window", "main", "--surface", "tab-a", ...dir])).code, 0);
  assert.deepEqual(server.requests.map((m) => m.params.surface), ["tab-a", "tab-a", "tab-a"]);
});

test("capture requests a still window capture and prints its path", async (t) => {
  const { server, dir } = await fixture(t);
  const result = await run(["capture", "--window", "main", ...dir]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(server.requests.map((m) => [m.method, m.params]), [["diagnostics.capture.still", { window: "main" }]]);
  assert.deepEqual(JSON.parse(result.stdout), { path: "/config/captures/still-main-1.png" });
});
