// The Wails runtime does not expose placement of individual regions and sends only the complete composition.
import assert from "node:assert/strict";
import test from "node:test";

// A document of a surface asks the host for the log policy at its load (action policy-read); the fake host answers it with the
// default policy and does not record it.
const policyRead = { classes: { lifecycle: "error", input: "error", call: "error", io: "error", frame: "error" } };

test("Wails page regions expose operations but only composition places geometry", async () => {
  // Records every call that goes through the mocked native interface.
  const recorded = [];
  const logged = [];

  // Mocks the Wails native interface.
  globalThis.window = {
    __soksakNative: {
      call(method, args) {
        if (method === "Log" && args[0].action === "policy-read") return Promise.resolve(policyRead);
        // The batches of events are kept apart: the calls of the page under test are asserted one by one.
        if (method === "Log" && args[0].action === "clock") return Promise.resolve({ ts_us: 1_791_000_000_000_456, mono_ns: 5_000_000_789 });
        // The statement of the clock anchor (page.log.clock) leads the first batch of a page and has its own test in the workbench.
        if (method === "Log") logged.push([method, [{ ...args[0], events: args[0].events.filter((event) => event.event !== "page.log.clock") }]]);
        else recorded.push([method, args]);
        return Promise.resolve(method === "WaitPresented" ? { displayed: 42 } : undefined);
      },
      on(event, fn) {
        // Simulates event delivery: sends an image-event once to s1 and once to s2, twice in total.
        if (event === "image-event") {
          setTimeout(() => {
            fn({ surface: "s1", name: "test-img", event: { type: "test" } });
            fn({ surface: "s2", name: "test-img", event: { type: "test" } });
          }, 0);
        }
        return Promise.resolve(() => {});
      },
    },
  };

  // Mocks a location that has a surface id.
  globalThis.location = {
    search: "?id=s1",
  };

  // Mocks URLSearchParams.
  globalThis.URLSearchParams = class {
    constructor(search) {
      this.search = search;
    }
    get(key) {
      if (key === "id") return "s1";
      return null;
    }
  };

  // Imports the runtime module (an IIFE that captures global values).
  const { host, page } = await import("../runtime/index.js");

  // Clears the calls recorded before the test (the module import may have produced calls).
  recorded.length = 0;

  // A page of a surface reports a record of its own as an event of a batch of the host call log.
  await page.report({ level: "error", where: "sidecar @x/side", text: "send failed: gone" });
  const [method, [request]] = logged.at(-1);
  assert.equal(method, "Log");
  assert.equal(request.action, "batch");
  assert.equal(request.events.length, 1);
  const [event] = request.events;
  assert.deepEqual({ level: event.level, event: event.event, fields: event.fields },
    { level: "error", event: "page.record.error", fields: { where: "sidecar @x/side", text: "send failed: gone" } });
  assert.ok(Number.isInteger(event.ts_us) && event.ts_us > 1.7e15, "the event carries the wall clock in microseconds");
  assert.ok(Number.isInteger(event.mono_ns) && event.mono_ns > 0, "the event carries the monotonic clock in nanoseconds");
  await assert.rejects(async () => page.report("send failed"), /report requires \{level, where, text\} strings/);
  await assert.rejects(host.call("report", { level: "info", where: "page", text: "ready" }), /unknown host call: report/);
  await page.document.attach("doc");
  assert.deepEqual(recorded.at(-1), ["DocumentAttach", [{ surface: "s1", document: "doc" }]]);
  await page.document.load("doc", "https://example.test");
  assert.deepEqual(recorded.at(-1), ["DocumentLoad", [{ surface: "s1", document: "doc", url: "https://example.test" }]]);
  await host.call("documentPost", { surface: "s1", document: "doc", message: { ping: 1 } });
  assert.deepEqual(recorded.at(-1), ["DocumentPost", [{ surface: "s1", document: "doc", message: { ping: 1 } }]]);
  await host.call("compositionPlace", { revision: 1, regions: [], overlays: [] });
  assert.deepEqual(recorded.at(-1), ["CompositionPlace", [{ revision: 1, regions: [], overlays: [] }]]);
  assert.deepEqual(await host.call("waitPresented"), { displayed: 42 });
  assert.deepEqual(recorded.at(-1), ["WaitPresented", []]);
  await host.call("sidecarSend", { sidecar: "x", surface: "s1", body: { value: 1 }, cids: ["b1.7"] });
  assert.deepEqual(recorded.at(-1), ["SidecarSend", ["x", "s1", { value: 1 }, ["b1.7"]]]);
  await host.call("imageAttach", { surface: "s1", name: "img", sidecar: "x" });
  assert.deepEqual(recorded.at(-1), ["ImageAttach", [{ surface: "s1", name: "img", sidecar: "x" }]]);
  await host.call("imageCaret", { surface: "s1", name: "img", x: 1, y: 2, width: 3, height: 4 });
  assert.deepEqual(recorded.at(-1), ["ImageCaret", [{ surface: "s1", name: "img" }, 1, 2, 3, 4]]);
  await host.call("imageText", { surface: "s1", name: "img", text: "accessible" });
  assert.deepEqual(recorded.at(-1), ["ImageText", [{ surface: "s1", name: "img" }, "accessible"]]);

  // Test: image.attach must call ImageAttach with [request]
  await page.image.attach("v", "@x/side");
  assert.deepEqual(
    recorded[recorded.length - 1],
    ["ImageAttach", [{ surface: "s1", name: "v", sidecar: "@x/side" }]],
    "image.attach: sends ImageAttach with [request]"
  );

  assert.equal(page.image.place, undefined);
  assert.equal(page.document.place, undefined);
  const regions = [{ name: "v", left: 1, top: 2, right: 3, bottom: 4, visible: true }];
  const overlays = [{ name: "toolbar", left: 5, top: 6, right: 7, bottom: 8, visible: true }];
  await page.composition.place(9, regions, overlays);
  assert.deepEqual(
    recorded[recorded.length - 1],
    [
      "CompositionPlace",
      [{ surface: "s1", revision: 9, regions, overlays }],
    ],
    "composition.place: sends one complete request"
  );

  // Test: image.focus must call ImageFocus with [request]
  await page.image.focus("v");
  assert.deepEqual(
    recorded[recorded.length - 1],
    ["ImageFocus", [{ surface: "s1", name: "v" }]],
    "image.focus: sends ImageFocus with [request]"
  );

  // Test: image.caret must call ImageCaret with the separate arguments [request, x, y, w, h]
  await page.image.caret("v", 1, 2, 3, 4);
  assert.deepEqual(
    recorded[recorded.length - 1],
    ["ImageCaret", [{ surface: "s1", name: "v" }, 1, 2, 3, 4]],
    "image.caret: sends ImageCaret with [request, x, y, w, h] as separate args"
  );

  // Test: image.text must call ImageText with the separate arguments [request, text]
  await page.image.text("v", "hello");
  assert.deepEqual(
    recorded[recorded.length - 1],
    ["ImageText", [{ surface: "s1", name: "v" }, "hello"]],
    "image.text: sends ImageText with [request, text] as separate args"
  );

  // Test: image.detach must call ImageDetach with [request]
  await page.image.detach("v");
  assert.deepEqual(
    recorded[recorded.length - 1],
    ["ImageDetach", [{ surface: "s1", name: "v" }]],
    "image.detach: sends ImageDetach with [request]"
  );

  // Test: image.on must filter events by surface
  let receivedEvents = [];
  await page.image.on((name, event) => {
    receivedEvents.push({ name, event });
  });

  // Waits until the events are handled.
  await new Promise((resolve) => setTimeout(resolve, 50));

  // It must receive only the events of s1, not of s2
  assert.equal(receivedEvents.length, 1, "image.on: receives exactly 1 event");
  assert.deepEqual(
    receivedEvents[0],
    { name: "test-img", event: { type: "test" } },
    "image.on: event is passed correctly"
  );
});
