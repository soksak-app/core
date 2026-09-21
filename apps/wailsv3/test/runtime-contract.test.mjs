// Wails 런타임은 개별 영역 배치를 노출하지 않고 완전한 합성만 보낸다.
import assert from "node:assert/strict";
import test from "node:test";

test("Wails page regions expose operations but only composition places geometry", async () => {
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
  const { host, page } = await import("../runtime/index.js");

  // Clear recorded calls before testing (module import might have made some calls)
  recorded.length = 0;

  await page.document.attach("doc");
  assert.deepEqual(recorded.at(-1), ["DocumentAttach", [{ surface: "s1", document: "doc" }]]);
  await page.document.load("doc", "https://example.test");
  assert.deepEqual(recorded.at(-1), ["DocumentLoad", [{ surface: "s1", document: "doc", url: "https://example.test" }]]);
  await host.call("compositionPlace", { revision: 1, regions: [], overlays: [] });
  assert.deepEqual(recorded.at(-1), ["CompositionPlace", [{ revision: 1, regions: [], overlays: [] }]]);
  await host.call("waitPresented");
  assert.deepEqual(recorded.at(-1), ["WaitPresented", []]);
  await host.call("report", "ready");
  assert.deepEqual(recorded.at(-1), ["Report", ["ready"]]);
  await assert.rejects(host.call("report", { line: "ready" }), /report requires a string/);
  await host.call("sidecarSend", { sidecar: "x", surface: "s1", body: { value: 1 } });
  assert.deepEqual(recorded.at(-1), ["SidecarSend", ["x", "s1", { value: 1 }]]);
  await host.call("imageAttach", { surface: "s1", name: "img", sidecar: "x" });
  assert.deepEqual(recorded.at(-1), ["ImageAttach", [{ surface: "s1", name: "img", sidecar: "x" }]]);
  await host.call("imageCaret", { surface: "s1", name: "img", x: 1, y: 2, width: 3, height: 4 });
  assert.deepEqual(recorded.at(-1), ["ImageCaret", [{ surface: "s1", name: "img" }, 1, 2, 3, 4]]);
  await host.call("imageText", { surface: "s1", name: "img", text: "accessible" });
  assert.deepEqual(recorded.at(-1), ["ImageText", [{ surface: "s1", name: "img" }, "accessible"]]);

  // Test: image.attach should call ImageAttach with [request]
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
