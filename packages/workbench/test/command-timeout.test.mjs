import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { JSDOM } from "jsdom";
import { EXPOSURE_ERRORS } from "@soksak/plugin-api";

// 이 문서가 답하는 명령도 선언된 timeout 이나 기본 10초 안에 답하지 않으면 실패로 보고한다(docs/spec/exposure.md).
const dom = new JSDOM("<body></body>", { url: "https://example.test/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
const { createRegistry } = await import("../exposure.js");

function registry() {
  const made = createRegistry();
  made.declare("core", {
    status: [],
    commands: [
      { name: "core.fixture.slow", description: "Never replies.", params: { type: "object" }, result: { type: "null" }, timeout: 50 },
      { name: "core.fixture.hang", description: "Never replies.", params: { type: "object" }, result: { type: "null" } },
      { name: "core.fixture.quick", description: "Replies.", params: { type: "object" }, result: { type: "integer" } },
    ],
    dom: [],
  });
  const never = () => new Promise(() => {});
  made.command("core.fixture.slow", never);
  made.command("core.fixture.hang", never);
  made.command("core.fixture.quick", () => 7);
  return made;
}

test("a main-page command without a reply fails after its declared timeout", { timeout: 5000 }, async () => {
  const made = registry();
  const started = performance.now();
  await assert.rejects(made.run("core.fixture.slow", {}),
    (error) => error.code === EXPOSURE_ERRORS.failed && /core\.fixture\.slow did not reply within 50ms/.test(error.message));
  assert.ok(performance.now() - started < 5000, "the declared timeout was not applied");
  assert.equal(await made.run("core.fixture.quick", {}), 7);
});

test("a main-page command without a declared timeout fails after 10 seconds", { timeout: 5000 }, async (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  const made = registry();
  let settled = null;
  const running = made.run("core.fixture.hang", {}).then(() => { settled = "replied"; }, (error) => { settled = error; });
  await Promise.resolve();
  mock.timers.tick(9999);
  await Promise.resolve();
  assert.equal(settled, null, "the command failed before 10 seconds");
  mock.timers.tick(1);
  await running;
  assert.ok(settled instanceof Error && /core\.fixture\.hang did not reply within 10000ms/.test(settled.message), String(settled));
});

test("a command bound covers its handler and not the presentation it waits for afterwards", { timeout: 5000 }, async () => {
  const made = registry();
  // 표시는 명령의 handler 예산(50ms)보다 오래 걸린다. 표시의 한도는 표시를 기다리는 쪽이 정한다.
  made.configure({ settled: () => new Promise((resolve) => setTimeout(resolve, 150)) });
  made.declare("core", {
    status: [],
    commands: [{ name: "core.fixture.drawn", description: "Replies after its layout presents.", params: { type: "object" },
      result: { type: "integer" }, timeout: 50 }],
    dom: [],
  });
  made.command("core.fixture.drawn", () => 9);
  assert.equal(await made.run("core.fixture.drawn", {}), 9);
});

test("a handler that throws fails its command and leaves no reply timer behind", { timeout: 5000 }, async (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  const unhandled = [];
  const record = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", record);
  t.after(() => process.off("unhandledRejection", record));
  const made = registry();
  made.declare("core", {
    status: [],
    commands: [{ name: "core.fixture.throws", description: "Throws in its handler.", params: { type: "object" },
      result: { type: "null" } }],
    dom: [],
  });
  made.command("core.fixture.throws", () => { throw new Error("fixture handler failed"); });
  await assert.rejects(made.run("core.fixture.throws", {}), /fixture handler failed/);
  // 처리기가 동기로 던져도 응답 한도의 타이머는 해제되어, 10초 뒤 응답하지 않았다는 거부가 따로 생기지 않는다.
  mock.timers.tick(10000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(unhandled.map(String), []);
});
