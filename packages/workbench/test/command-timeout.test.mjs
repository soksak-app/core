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
