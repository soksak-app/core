// 표시 실패 하나가 애플리케이션 로그에 쓰는 줄을 검사한다. 실패를 받은 요청자가 그 실패를 보고하고, 같은 실패를 받은
// 다른 경로는 다시 쓰지 않는다(docs/spec/hosts.md#application-log). 페이지에서 그 요청자는 배치 대기열의 failed 이며,
// 그 실패를 메인 문서의 오류 표시로 보인다. 연결은 index.html 이 쓰는 page-layout.js 의 배치 배선이고, 이 검사는
// 호스트 브리지, 컴포지터, 판의 렌더와 animation frame 만 가짜로 둔다.
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { JSDOM } from "jsdom";

const TIMEOUT = "the current image raster did not present within 10s; pending tab-1/view generation 2 raster 1 sequence 0 presented 0/0 surface visible";

test("one presentation timeout writes one page error line", async () => {
  const dom = new JSDOM('<div id="plane"></div><div id="applicationError"></div>');
  globalThis.document = dom.window.document;
  // 문서의 animation frame. Node 에는 없으므로 요청한 자리에서 실행한다.
  globalThis.requestAnimationFrame = (run) => run(0);
  const shown = (record) => `${record.level} page ${record.where}: ${record.text}`;
  const lines = [];
  mock.module("@soksak/runtime", { namedExports: { host: {
    on: () => {},
    page: (path) => path,
    call: async (name, request) => {
      if (name === "report") { lines.push(shown(request)); return; }
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
  const { createErrorDisplay, createPageLayout } = await import("../page-layout.js");
  const { connectExposure, registry } = await import("../exposure.js");

  const record = {
    surfaces: [{
      id: "tab-1", dim: false, visible: true,
      surface: { module: "surface-module", composition: { kind: "hybrid", regions: [{ name: "view", kind: "image" }], overlays: [] } },
      applied: { x: 0, y: 0, w: 10, h: 10 },
    }],
    settled: true, drawn: false, titlebar: 40,
  };
  // 판의 렌더가 커밋한 표시(index.html 의 onRender). 그린 배치의 표시를 호스트에 요청한다.
  let rendered = Promise.resolve();
  const showError = createErrorDisplay({ document, changed: () => {} });
  const page = createPageLayout({
    document, showError, setVerify: () => {}, log: () => {}, surfaces,
    plane: {},
    compositor: { publishAhead: () => surfaces.place(record) },
    textSize: () => 1,
    rendered: () => rendered,
    waitSurfaceCompositionDeclared: async () => {},
  });
  await connectExposure({ settled: page.drawn, report });
  registry.declare("core", { status: [], dom: [], commands: [{
    name: "core.fixture.split", description: "Splits.", params: { type: "object", properties: {} }, result: { type: "null" },
  }] });
  registry.command("core.fixture.split", () => {
    page.onLayout(new Map(), () => { rendered = surfaces.place({ ...record, drawn: true }); }, new Map(), 40);
    return null;
  });

  assert.equal(await registry.run("core.fixture.split"), null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(lines, [`error page page: surface presentation failed: ${TIMEOUT}`],
    "one presentation timeout must write exactly the line of the display that shows it");
  dom.window.close();
});
