// Wails runtime contract: page.image methods send arguments in the shape the host expects.
import assert from "node:assert/strict";
import test from "node:test";

test("Wails page.image methods send correct argument shapes to host", async () => {
  // Record all calls made through the mocked native interface
  const recorded = [];

  // Mock the Wails native interface
  globalThis.window = {
    __soksakNative: {
      call(method, args) {
        recorded.push([method, args]);
        return Promise.resolve();
      },
      on(event, fn) {
        // Simulate event delivery: send image-event twice, once for s1 and once for s2
        if (event === "image-event") {
          setTimeout(() => {
            fn({ surface: "s1", name: "test-img", event: { type: "test" } });
            fn({ surface: "s2", name: "test-img", event: { type: "test" } });
          }, 0);
        }
        return Promise.resolve();
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

  // Test: image.attach should call ImageAttach with [request]
  await page.image.attach("v", "@x/side");
  assert.deepEqual(
    recorded[recorded.length - 1],
    ["ImageAttach", [{ surface: "s1", name: "v", sidecar: "@x/side" }]],
    "image.attach: sends ImageAttach with [request]"
  );

  // Test: image.place should call ImagePlace with [request]
  await page.image.place("v", { left: 1, top: 2, right: 3, bottom: 4 }, true);
  assert.deepEqual(
    recorded[recorded.length - 1],
    [
      "ImagePlace",
      [
        {
          surface: "s1",
          name: "v",
          left: 1,
          top: 2,
          right: 3,
          bottom: 4,
          visible: true,
        },
      ],
    ],
    "image.place: sends ImagePlace with [request]"
  );

  // Test: image.focus should call ImageFocus with [request]
  await page.image.focus("v");
  assert.deepEqual(
    recorded[recorded.length - 1],
    ["ImageFocus", [{ surface: "s1", name: "v" }]],
    "image.focus: sends ImageFocus with [request]"
  );

  // Test: image.caret should call ImageCaret with [request, x, y, w, h] as separate args
  await page.image.caret("v", 1, 2, 3, 4);
  assert.deepEqual(
    recorded[recorded.length - 1],
    ["ImageCaret", [{ surface: "s1", name: "v" }, 1, 2, 3, 4]],
    "image.caret: sends ImageCaret with [request, x, y, w, h] as separate args"
  );

  // Test: image.text should call ImageText with [request, text] as separate args
  await page.image.text("v", "hello");
  assert.deepEqual(
    recorded[recorded.length - 1],
    ["ImageText", [{ surface: "s1", name: "v" }, "hello"]],
    "image.text: sends ImageText with [request, text] as separate args"
  );

  // Test: image.detach should call ImageDetach with [request]
  await page.image.detach("v");
  assert.deepEqual(
    recorded[recorded.length - 1],
    ["ImageDetach", [{ surface: "s1", name: "v" }]],
    "image.detach: sends ImageDetach with [request]"
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
