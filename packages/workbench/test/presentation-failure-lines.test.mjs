// 표시 실패 하나가 애플리케이션 로그에 쓰는 줄을 검사한다. 실패를 받은 요청자가 그 실패를 보고하고, 같은 실패를 받은
// 다른 경로는 다시 쓰지 않는다(docs/spec/hosts.md#application-log). 페이지에서 그 요청자는 배치 대기열의 failed 이며,
// 그 실패를 메인 문서의 오류 표시로 보인다. 연결은 index.html 의 배치 대기열, 오류 표시, 코어 명령의 그리기 대기와 같다.
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { JSDOM } from "jsdom";

const TIMEOUT = "the current image raster did not present within 10s; pending tab-1/view generation 2 raster 1 sequence 0 presented 0/0 surface visible";

test("one presentation timeout writes one page error line", async () => {
  const dom = new JSDOM('<div id="plane"></div><div id="applicationError"></div>');
  globalThis.document = dom.window.document;
  const lines = [];
  mock.module("@soksak/runtime", { namedExports: { host: {
    on: () => {},
    page: (path) => path,
    call: async (name, request) => {
      if (name === "report") { lines.push(request); return; }
      if (name === "syncSurfaces") return {
        ticket: 1,
        placements: [{ id: "tab-1", x: 0, y: 0, w: 10, h: 10, visible: true }],
        chrome: { controls: { x: 13, y: 13, w: 54, h: 14 }, row: 40 },
      };
      if (name === "presentSurfaces") throw new Error(TIMEOUT);
      throw new Error(`unexpected host call ${name}`);
    },
  } } });
  const { report, surfaces } = await import("../host.js");
  const { createLayoutQueue, drawPrepared } = await import("../layout-queue.js");
  const { showError } = await import("../shown-errors.js");
  const { connectExposure, registry } = await import("../exposure.js");

  const banner = document.getElementById("applicationError");
  const layouts = createLayoutQueue({
    failed(error) {
      showError(banner, "page", `surface presentation failed: ${String(error?.message ?? error)}`);
    },
    superseded() {},
  });
  // index.html 의 drawn 과 같다. 가장 새 배치가 표시되지 않았으면 읽을 슬롯이 없다.
  await connectExposure({ settled: async () => { if (!(await layouts.wait())) return; }, report });
  const record = {
    surfaces: [{
      id: "tab-1", dim: false, visible: true,
      surface: { module: "surface-module", composition: { kind: "hybrid", regions: [{ name: "view", kind: "image" }], overlays: [] } },
      applied: { x: 0, y: 0, w: 10, h: 10 },
    }],
    settled: true, drawn: false, titlebar: 40,
  };
  registry.declare("core", { status: [], dom: [], commands: [{
    name: "core.fixture.split", description: "Splits.", params: { type: "object", properties: {} }, result: { type: "null" },
  }] });
  registry.command("core.fixture.split", () => {
    layouts.run(() => drawPrepared({
      epoch: 0, current: () => 0,
      prepare: () => surfaces.place(record),
      draw: () => {},
      frame: async () => {},
      presented: () => surfaces.place({ ...record, drawn: true }),
    }));
    return null;
  });

  assert.equal(await registry.run("core.fixture.split"), null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(lines, [`error: page: surface presentation failed: ${TIMEOUT}`],
    "one presentation timeout must write exactly the line of the display that shows it");
  dom.window.close();
});
