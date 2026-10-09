// Tauri 런타임은 개별 영역 배치를 노출하지 않고 완전한 합성만 보낸다.
import assert from "node:assert/strict";
import test from "node:test";

test("Tauri page regions expose operations but only composition places geometry", async () => {
  // mock한 Tauri invoke를 거친 모든 호출을 기록한다
  const recorded = [];
  const eventListeners = {};

  // Tauri 런타임 인터페이스를 mock한다
  globalThis.window = {
    __TAURI__: {
      core: {
        invoke(command, args) {
          recorded.push([command, args]);
          return Promise.resolve(command === "wait_presented" ? { displayed: 42 } : undefined);
        },
      },
      event: {
        listen(event, fn, _options) {
          // 이벤트 listener를 등록한다
          if (!eventListeners[event]) {
            eventListeners[event] = [];
          }
          eventListeners[event].push(fn);

          // 이벤트 전달을 흉내 낸다: image-event를 s1에 한 번, s2에 한 번, 모두 두 번 보낸다
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

  // surface id가 있는 location을 mock한다
  globalThis.location = {
    search: "?id=s1",
  };

  // URLSearchParams를 mock한다
  globalThis.URLSearchParams = class {
    constructor(search) {
      this.search = search;
    }
    get(key) {
      if (key === "id") return "s1";
      return null;
    }
  };

  // 런타임 모듈을 import한다(전역 값을 붙잡는 IIFE다)
  const { host, page } = await import("../runtime/index.js");

  // 테스트 전에 기록된 호출을 지운다(모듈 import가 호출을 만들었을 수 있다)
  recorded.length = 0;

  // A page of a surface reports a record of its own through the same host call as the main page.
  await page.report({ level: "error", where: "sidecar @x/side", text: "send failed: gone" });
  assert.deepEqual(recorded.at(-1), ["report", { record: { level: "error", where: "sidecar @x/side", text: "send failed: gone" } }]);
  await assert.rejects(async () => page.report("send failed"), /report requires \{level, where, text\} strings/);
  await page.document.attach("doc");
  assert.deepEqual(recorded.at(-1), ["document_attach", { request: { surface: "s1", document: "doc" } }]);
  await page.document.load("doc", "https://example.test");
  assert.deepEqual(recorded.at(-1), ["document_load", { request: { surface: "s1", document: "doc", url: "https://example.test" } }]);
  await host.call("documentPost", { surface: "s1", document: "doc", message: { ping: 1 } });
  assert.deepEqual(recorded.at(-1), ["document_post", { request: { surface: "s1", document: "doc", message: { ping: 1 } } }]);
  await host.call("report", { level: "info", where: "page", text: "ready" });
  assert.deepEqual(recorded.at(-1), ["report", { record: { level: "info", where: "page", text: "ready" } }]);
  assert.deepEqual(await host.call("waitPresented"), { displayed: 42 });
  assert.deepEqual(recorded.at(-1), ["wait_presented", {}]);
  // 잘못된 인자는 Wails 런타임처럼 거부된 약속으로 알린다. 메인 페이지의 호출은 모두 settlingCalls 를 거친다.
  await assert.rejects(host.call("report", "ready"), /report requires \{level, where, text\} strings/);
  await assert.rejects(host.call("report", { level: "info", where: "page" }), /report requires \{level, where, text\} strings/);
  await host.call("sidecarSend", { sidecar: "x", surface: "s1", body: { value: 1 } });
  assert.deepEqual(recorded.at(-1), ["sidecar_send", { sidecar: "x", surface: "s1", body: { value: 1 } }]);
  await host.call("imageCaret", { surface: "s1", name: "img", x: 1, y: 2, width: 3, height: 4 });
  assert.deepEqual(recorded.at(-1), ["image_caret", { request: { surface: "s1", name: "img" }, x: 1, y: 2, w: 3, h: 4 }]);
  await host.call("imageText", { surface: "s1", name: "img", text: "accessible" });
  assert.deepEqual(recorded.at(-1), ["image_text", { request: { surface: "s1", name: "img" }, text: "accessible" }]);

  // 테스트: image.attach는 image_attach를 { request: { surface, name, sidecar } }로 invoke해야 한다
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

  // 테스트: image.focus는 image_focus를 { request: { surface, name } }로 invoke해야 한다
  await page.image.focus("v");
  assert.deepEqual(
    recorded[recorded.length - 1],
    ["image_focus", { request: { surface: "s1", name: "v" } }],
    "image.focus: invokes image_focus with request object"
  );

  // 테스트: image.caret은 image_caret을 { request, x, y, w, h }의 개별 이름 있는 인자로 invoke해야 한다
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

  // 테스트: image.text는 image_text를 { request, text }의 개별 이름 있는 인자로 invoke해야 한다
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

  // 테스트: image.detach는 image_detach를 { request: { surface, name } }로 invoke해야 한다
  await page.image.detach("v");
  assert.deepEqual(
    recorded[recorded.length - 1],
    ["image_detach", { request: { surface: "s1", name: "v" } }],
    "image.detach: invokes image_detach with request object"
  );

  // 테스트: image.on은 surface로 이벤트를 걸러야 한다
  let receivedEvents = [];
  await page.image.on((name, event) => {
    receivedEvents.push({ name, event });
  });

  // 이벤트가 처리되기를 기다린다
  await new Promise((resolve) => setTimeout(resolve, 50));

  // s2가 아닌 s1의 이벤트만 받아야 한다
  assert.equal(receivedEvents.length, 1, "image.on: receives exactly 1 event");
  assert.deepEqual(
    receivedEvents[0],
    { name: "test-img", event: { type: "test" } },
    "image.on: event is passed correctly"
  );
});
