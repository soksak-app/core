// 준비는 제목줄 높이를 담고, 페이지는 표시를 확인한 준비의 창 단추 영역을 커밋된 상태로 읽는다. 그리기 뒤에 제목줄을
// 따로 요청하는 호출은 없다(docs/spec/native-surfaces.md#title-bar-height).
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { JSDOM } from "jsdom";

test("the preparation carries the title bar height and the presented chrome is the committed one", async () => {
  const dom = new JSDOM('<div id="plane"></div>');
  globalThis.document = dom.window.document;
  const calls = [];
  let prepared = 0;
  mock.module("@soksak/runtime", { namedExports: { host: {
    on: () => {},
    page: (path) => path,
    call: async (name, request) => {
      calls.push({ name, request });
      if (name === "report") return;
      if (name === "syncSurfaces") {
        prepared++;
        return {
          ticket: prepared,
          placements: [{ id: "surface", x: 1, y: 2, w: 3, h: 4, visible: true }],
          // 호스트가 트랜잭션 안에서 제목줄을 정한 뒤 읽은 창 단추 영역: 단추 14pt 가 행의 가운데에 있다.
          chrome: { controls: { x: 13, y: (request.titlebar - 14) / 2, w: 54, h: 14 }, row: request.titlebar },
        };
      }
      if (name === "presentSurfaces") return request.placements;
      throw new Error(`unexpected host call ${name}`);
    },
  } } });
  const { chrome, surfaces } = await import("../host.js");
  const record = (titlebar, drawn) => ({
    surfaces: [{
      id: "surface", dim: false, visible: true,
      surface: { module: "surface-module", composition: { kind: "dom" } },
      applied: { x: 1, y: 2, w: 3, h: 4 },
    }],
    settled: true, drawn, titlebar,
  });
  try {
    assert.equal("titlebar" in chrome, false, "the page has no title bar request apart from the preparation");
    assert.equal(chrome.presented(), null, "no preparation has been presented");

    await surfaces.place(record(54, false));
    assert.deepEqual(calls.map((c) => c.name), ["syncSurfaces"]);
    assert.equal(calls[0].request.titlebar, 54, "the preparation carries the row of the next draw");
    assert.equal(chrome.presented(), null, "a preparation is not the committed state before its presentation");

    await surfaces.place(record(54, true));
    assert.deepEqual(calls.map((c) => c.name), ["syncSurfaces", "presentSurfaces"],
      "the draw makes no request other than the presentation");
    assert.deepEqual(Object.keys(calls[1].request).sort(), ["placements", "settled", "ticket", "waitForPresentation"],
      "the presentation sends the prepared ticket and placements");
    assert.deepEqual(chrome.presented(), { controls: { x: 13, y: 20, w: 54, h: 14 }, row: 54 });

    // 다음 배치의 준비는 표시를 확인하기 전까지 커밋된 상태를 바꾸지 않는다.
    await surfaces.place(record(40, false));
    assert.equal(calls.at(-1).request.titlebar, 40);
    assert.equal(chrome.presented().row, 54, "an unpresented preparation replaced the committed chrome");
    await surfaces.place(record(40, true));
    assert.equal(chrome.presented().row, 40);

    // 같은 요청은 다시 보내지 않는다. 창의 상태가 요청 없이 바뀌었으면(전체 화면에서 나온 창) forget 뒤의 같은
    // 요청을 보낸다.
    calls.length = 0;
    await surfaces.place(record(40, false));
    assert.deepEqual(calls, [], "an unchanged request was sent");
    surfaces.forget();
    await surfaces.place(record(40, false));
    await surfaces.place(record(40, true));
    assert.deepEqual(calls.map((c) => c.name), ["syncSurfaces", "presentSurfaces"],
      "a forgotten request was not sent again");
    assert.equal(calls[0].request.titlebar, 40);
  } finally {
    dom.window.close();
  }
});
