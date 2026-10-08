// Wails 런타임은 개별 영역 배치를 노출하지 않고 완전한 합성만 보낸다.
import assert from "node:assert/strict";
import test from "node:test";

test("Wails page regions expose operations but only composition places geometry", async () => {
  // mock한 native 인터페이스를 거친 모든 호출을 기록한다
  const recorded = [];

  // Wails native 인터페이스를 mock한다
  globalThis.window = {
    __soksakNative: {
      call(method, args) {
        recorded.push([method, args]);
        return Promise.resolve(method === "WaitPresented" ? { displayed: 42 } : undefined);
      },
      on(event, fn) {
        // 이벤트 전달을 흉내 낸다: image-event를 s1에 한 번, s2에 한 번, 모두 두 번 보낸다
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

  // 테스트: image.attach는 ImageAttach를 [request]로 호출해야 한다
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

  // 테스트: image.focus는 ImageFocus를 [request]로 호출해야 한다
  await page.image.focus("v");
  assert.deepEqual(
    recorded[recorded.length - 1],
    ["ImageFocus", [{ surface: "s1", name: "v" }]],
    "image.focus: sends ImageFocus with [request]"
  );

  // 테스트: image.caret은 ImageCaret을 [request, x, y, w, h]의 개별 인자로 호출해야 한다
  await page.image.caret("v", 1, 2, 3, 4);
  assert.deepEqual(
    recorded[recorded.length - 1],
    ["ImageCaret", [{ surface: "s1", name: "v" }, 1, 2, 3, 4]],
    "image.caret: sends ImageCaret with [request, x, y, w, h] as separate args"
  );

  // 테스트: image.text는 ImageText를 [request, text]의 개별 인자로 호출해야 한다
  await page.image.text("v", "hello");
  assert.deepEqual(
    recorded[recorded.length - 1],
    ["ImageText", [{ surface: "s1", name: "v" }, "hello"]],
    "image.text: sends ImageText with [request, text] as separate args"
  );

  // 테스트: image.detach는 ImageDetach를 [request]로 호출해야 한다
  await page.image.detach("v");
  assert.deepEqual(
    recorded[recorded.length - 1],
    ["ImageDetach", [{ surface: "s1", name: "v" }]],
    "image.detach: sends ImageDetach with [request]"
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
