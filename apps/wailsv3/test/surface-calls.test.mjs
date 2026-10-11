// The host calls of a surface document are the events `page.call`, relayed in batches of the host call Log
// (docs/spec/logging.md#automatic-entrances).
import assert from "node:assert/strict";
import test from "node:test";

async function surface(native) {
  const calls = [];
  globalThis.window = { __soksakNative: {
    call: (method, args) => {
      // The request for the clocks of the host is answered here; the batches are what the tests assert.
      if (method === "Log" && args[0].action === "clock") return Promise.resolve({ ts_us: 1_791_000_000_000_456, mono_ns: 5_000_000_789 });
      calls.push([method, args]);
      return native(method, args);
    },
    on: () => Promise.resolve(() => {}),
  } };
  globalThis.location = { search: "?id=s1" };
  const { page } = await import(`../runtime/index.js?test=surface-calls-${Math.random()}`);
  const batches = () => calls.filter(([method]) => method === "Log").map(([, [request]]) => request.events);
  return { page, calls, batches };
}

const cleanup = () => {
  delete globalThis.window;
  delete globalThis.location;
};

test("the calls of one turn are the events page.call in one Log batch, with the arguments of the host call", async () => {
  const { page, calls, batches } = await surface(async () => undefined);
  try {
    await Promise.all([page.document.attach("doc"), page.document.load("doc", "https://example.test"), page.image.caret("v", 1, 2, 3, 4)]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(batches().length, 1, "one Log call carries the events of the turn");
    const events = batches()[0];
    assert.deepEqual(events.map((event) => [event.event, event.level, event.fields.name, event.fields.args, event.fields.ok]), [
      ["page.call", "debug", "documentAttach", '[{"surface":"s1","document":"doc"}]', true],
      ["page.call", "debug", "documentLoad", '[{"surface":"s1","document":"doc","url":"https://example.test"}]', true],
      ["page.call", "debug", "imageCaret", '[{"surface":"s1","name":"v"},1,2,3,4]', true],
    ]);
    for (const event of events) {
      assert.equal(event.fields.truncated, false);
      assert.ok(Number.isInteger(event.fields.micros) && event.fields.micros >= 0);
      assert.ok(Number.isInteger(event.ts_us) && event.ts_us > 1.7e15);
      assert.ok(Number.isInteger(event.mono_ns) && event.mono_ns > 0);
    }
    assert.equal(calls.filter(([method]) => method !== "Log").length, 3, "the calls themselves are not delayed or repeated");
  } finally {
    cleanup();
  }
});

test("a refused call is at the level warn with the error, and the caller still gets the rejection", async () => {
  const { page, batches } = await surface(async (method) => { if (method === "ImageFocus") throw new Error("no such region"); });
  try {
    await assert.rejects(page.image.focus("v"), /no such region/);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const [event] = batches()[0];
    assert.equal(event.level, "warn");
    assert.equal(event.fields.name, "imageFocus");
    assert.equal(event.fields.ok, false);
    assert.equal(event.fields.error, "no such region");
  } finally {
    cleanup();
  }
});

test("the Log call is not recorded, and a long argument is cut with truncated", async () => {
  const { page, batches } = await surface(async () => undefined);
  try {
    await page.report({ level: "info", where: "page", text: "ready" });
    await page.sidecar("x").send("s1", "y".repeat(3000));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const events = batches().flat();
    assert.deepEqual(events.map((event) => event.event), ["page.record.info", "page.call"]);
    assert.equal(events[1].fields.name, "sidecarSend");
    assert.equal(events[1].fields.args.length, 1024);
    assert.equal(events[1].fields.truncated, true);
  } finally {
    cleanup();
  }
});
