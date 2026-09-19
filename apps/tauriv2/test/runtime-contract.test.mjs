// Tauri 런타임은 개별 영역 배치를 노출하지 않고 완전한 합성만 보낸다.
import assert from "node:assert/strict";
import test from "node:test";

test("Tauri page regions expose operations but only composition places geometry", async () => {
  // Record all calls made through the mocked Tauri invoke
  const recorded = [];
  const eventListeners = {};

  // Mock the Tauri runtime interface
  globalThis.window = {
    __TAURI__: {
      core: {
        invoke(command, args) {
          recorded.push([command, args]);
          return Promise.resolve();
        },
      },
      event: {
        listen(event, fn, _options) {
          // Register event listeners
          if (!eventListeners[event]) {
            eventListeners[event] = [];
          }
          eventListeners[event].push(fn);

          // Simulate event delivery: send image-event twice, once for s1 and once for s2
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

  // Mock location with surface id
  globalThis.location = {
    search: "?id=s1",
  };

  // Mock URLSearchParams
  globalThis.URLSearchParams = class {
    constructor(search) {
      this.search = search;
    }
    get(key) {
      if (key === "id") return "s1";
      return null;
    }
  };

  // Import the runtime module (this is the IIFE that captures the globals)
  const { page } = await import("../runtime/index.js");

  // Clear recorded calls before testing (module import might have made some calls)
  recorded.length = 0;

  // Test: image.attach should invoke image_attach with { request: { surface, name, sidecar } }
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

  // Test: image.focus should invoke image_focus with { request: { surface, name } }
  await page.image.focus("v");
  assert.deepEqual(
    recorded[recorded.length - 1],
    ["image_focus", { request: { surface: "s1", name: "v" } }],
    "image.focus: invokes image_focus with request object"
  );

  // Test: image.caret should invoke image_caret with { request, x, y, w, h } as separate named args
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

  // Test: image.text should invoke image_text with { request, text } as separate named args
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

  // Test: image.detach should invoke image_detach with { request: { surface, name } }
  await page.image.detach("v");
  assert.deepEqual(
    recorded[recorded.length - 1],
    ["image_detach", { request: { surface: "s1", name: "v" } }],
    "image.detach: invokes image_detach with request object"
  );

  // Test: image.on should filter events by surface
  let receivedEvents = [];
  await page.image.on((name, event) => {
    receivedEvents.push({ name, event });
  });

  // Wait for events to be processed
  await new Promise((resolve) => setTimeout(resolve, 50));

  // Should only receive events for s1, not s2
  assert.equal(receivedEvents.length, 1, "image.on: receives exactly 1 event");
  assert.deepEqual(
    receivedEvents[0],
    { name: "test-img", event: { type: "test" } },
    "image.on: event is passed correctly"
  );
});
