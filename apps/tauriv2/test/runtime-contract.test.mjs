// The Tauri runtime does not expose placement of individual regions and sends only the complete composition.
import assert from "node:assert/strict";
import test from "node:test";

test("Tauri page regions expose operations but only composition places geometry", async () => {
  // Records every call that goes through the mocked Tauri invoke.
  const recorded = [];
  const logged = [];
  const eventListeners = {};

  // Mocks the Tauri runtime interface.
  globalThis.window = {
    __TAURI__: {
      core: {
        invoke(command, args) {
          // The batches of events are kept apart: the calls of the page under test are asserted one by one.
          if (command === "log") logged.push([command, args]);
          else recorded.push([command, args]);
          return Promise.resolve(command === "wait_presented" ? { displayed: 42 } : undefined);
        },
      },
      event: {
        listen(event, fn, _options) {
          // Registers an event listener.
          if (!eventListeners[event]) {
            eventListeners[event] = [];
          }
          eventListeners[event].push(fn);

          // Simulates event delivery: sends an image-event once to s1 and once to s2, twice in total.
          if (event === "image-event") {
            setTimeout(() => {
              const s1Event = {
                payload: {
                  surface: "s1",
                  name: "test-img",
                  event: { type: "test" },
                },
              };
              const s2Event = {
                payload: {
                  surface: "s2",
                  name: "test-img",
                  event: { type: "test" },
                },
              };
              eventListeners[event].forEach((listener) => {
                listener(s1Event);
                listener(s2Event);
              });
            }, 0);
          }
          return Promise.resolve(() => null);
        },
      },
      webview: {
        getCurrentWebview() {
          return { label: "surface" };
        },
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
  const [command, { request }] = logged.at(-1);
  assert.equal(command, "log");
  assert.equal(request.action, "batch");
  assert.equal(request.events.length, 1);
  const [event] = request.events;
  assert.deepEqual({ level: event.level, event: event.event, fields: event.fields },
    { level: "error", event: "page.record.error", fields: { where: "sidecar @x/side", text: "send failed: gone" } });
  assert.ok(Number.isInteger(event.ts_us) && event.ts_us > 1.7e15, "the event carries the wall clock in microseconds");
  await assert.rejects(async () => page.report("send failed"), /report requires \{level, where, text\} strings/);
  await assert.rejects(host.call("report", { level: "info", where: "page", text: "ready" }), /unknown host call: report/);
  await page.document.attach("doc");
  assert.deepEqual(recorded.at(-1), ["document_attach", { request: { surface: "s1", document: "doc" } }]);
  await page.document.load("doc", "https://example.test");
  assert.deepEqual(recorded.at(-1), ["document_load", { request: { surface: "s1", document: "doc", url: "https://example.test" } }]);
  await host.call("documentPost", { surface: "s1", document: "doc", message: { ping: 1 } });
  assert.deepEqual(recorded.at(-1), ["document_post", { request: { surface: "s1", document: "doc", message: { ping: 1 } } }]);
  assert.deepEqual(await host.call("waitPresented"), { displayed: 42 });
  assert.deepEqual(recorded.at(-1), ["wait_presented", {}]);
  // An invalid argument is reported as a rejected promise, like the Wails runtime. Every call of the main page goes through settlingCalls.
  await host.call("sidecarSend", { sidecar: "x", surface: "s1", body: { value: 1 }, cids: ["b1.7"] });
  assert.deepEqual(recorded.at(-1), ["sidecar_send", { sidecar: "x", surface: "s1", body: { value: 1 }, cids: ["b1.7"] }]);
  await host.call("imageCaret", { surface: "s1", name: "img", x: 1, y: 2, width: 3, height: 4 });
  assert.deepEqual(recorded.at(-1), ["image_caret", { request: { surface: "s1", name: "img" }, x: 1, y: 2, w: 3, h: 4 }]);
  await host.call("imageText", { surface: "s1", name: "img", text: "accessible" });
  assert.deepEqual(recorded.at(-1), ["image_text", { request: { surface: "s1", name: "img" }, text: "accessible" }]);

  // Test: image.attach must invoke image_attach with { request: { surface, name, sidecar } }
  await page.image.attach("v", "@x/side");
  assert.deepEqual(
    recorded[recorded.length - 1],
    [
      "image_attach",
      { request: { surface: "s1", name: "v", sidecar: "@x/side" } },
    ],
    "image.attach: invokes image_attach with request object"
  );

  assert.equal(page.image.place, undefined);
  assert.equal(page.document.place, undefined);
  const regions = [{ name: "v", left: 1, top: 2, right: 3, bottom: 4, visible: true }];
  const overlays = [{ name: "toolbar", left: 5, top: 6, right: 7, bottom: 8, visible: true }];
  await page.composition.place(9, regions, overlays);
  assert.deepEqual(
    recorded[recorded.length - 1],
    [
      "composition_place",
      { request: { surface: "s1", revision: 9, regions, overlays } },
    ],
    "composition.place: invokes composition_place with a complete request"
  );

  // Test: image.focus must invoke image_focus with { request: { surface, name } }
  await page.image.focus("v");
  assert.deepEqual(
    recorded[recorded.length - 1],
    ["image_focus", { request: { surface: "s1", name: "v" } }],
    "image.focus: invokes image_focus with request object"
  );

  // Test: image.caret must invoke image_caret with the separate named arguments { request, x, y, w, h }
  await page.image.caret("v", 1, 2, 3, 4);
  assert.deepEqual(
    recorded[recorded.length - 1],
    [
      "image_caret",
      {
        request: { surface: "s1", name: "v" },
        x: 1,
        y: 2,
        w: 3,
        h: 4,
      },
    ],
    "image.caret: invokes image_caret with [request, x, y, w, h] as separate named args"
  );

  // Test: image.text must invoke image_text with the separate named arguments { request, text }
  await page.image.text("v", "hello");
  assert.deepEqual(
    recorded[recorded.length - 1],
    [
      "image_text",
      {
        request: { surface: "s1", name: "v" },
        text: "hello",
      },
    ],
    "image.text: invokes image_text with [request, text] as separate named args"
  );

  // Test: image.detach must invoke image_detach with { request: { surface, name } }
  await page.image.detach("v");
  assert.deepEqual(
    recorded[recorded.length - 1],
    ["image_detach", { request: { surface: "s1", name: "v" } }],
    "image.detach: invokes image_detach with request object"
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
