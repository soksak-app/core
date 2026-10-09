// 배치 하나의 실패가 애플리케이션 로그에 쓰는 줄을 검사한다. 배치 대기열의 failed 가 그 실패를 받아 보이므로, 그 배치를
// 기다린 프로젝트 전환 명령이나 배치를 예약한 몸짓은 같은 실패를 다시 쓰지 않는다(docs/spec/hosts.md#application-log).
// 연결은 index.html 이 쓰는 page-layout.js 의 오류 표시, 처리되지 않은 거절의 보고, 배치 수신자, 프로젝트 전환의
// presented 이고, 이 검사는 호스트 브리지, 컴포지터, 창의 사건만 가짜로 둔다.
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { JSDOM } from "jsdom";

const TIMEOUT = "the current image raster did not present within 10s; pending tab-1/view generation 2 raster 1 sequence 0 presented 0/0 surface visible";

const dom = new JSDOM('<div id="applicationError"></div><button id="projectTab"></button>');
globalThis.document = dom.window.document;
const shown = (record) => `${record.level} page ${record.where}: ${record.text}`;
const lines = [];
mock.module("@soksak/runtime", { namedExports: { host: {
  on: () => {},
  page: (path) => path,
  call: async (name, request) => {
    if (name === "report") { lines.push(shown(request)); return; }
    throw new Error(`unexpected host call ${name}`);
  },
} } });
const { report, surfaces } = await import("../host.js");
const { createErrorDisplay, createPageLayout, reportUncaught } = await import("../page-layout.js");
const { hideError } = await import("../shown-errors.js");
const { connectExposure, registry } = await import("../exposure.js");
const { bind } = await import("../commands.js");

const banner = document.getElementById("applicationError");
const showError = createErrorDisplay({ document, changed: () => {} });
// 문서의 창. 브라우저는 처리되지 않은 거절을 창의 unhandledrejection 사건으로 알린다.
const target = new EventTarget();
reportUncaught(target, showError);
/**
 * 처리되지 않은 거절을 창의 사건으로 보낸다. 문서의 처리되지 않은 거절은 그 사건의 보고만 받으므로, 첫 test() 가 설치하는
 * 테스트 실행기의 처리기를 각 테스트의 시작에서 뗀다.
 */
function reportRejectionsAsPage() {
  process.removeAllListeners("unhandledRejection");
  process.on("unhandledRejection", (reason) => {
    target.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason }));
  });
}

const page = createPageLayout({
  document, showError, setVerify: () => {}, log: () => {}, surfaces,
  plane: {},
  compositor: { publishAhead: () => Promise.reject(new Error(TIMEOUT)) },
  textSize: () => 1,
  rendered: () => Promise.resolve(),
  waitSurfaceCompositionDeclared: async () => {},
});
await connectExposure({ settled: page.drawn, report });
/** 판이 배치를 예약한다. 그 배치의 준비가 실패한다. */
const schedule = () => { page.onLayout(new Map(), () => {}, new Map(), 40); };

/** 다음 macrotask 까지의 모든 microtask 와 처리되지 않은 거절의 보고를 끝낸다. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("a layout failure of a project switch started from the interface writes one page error line", async () => {
  reportRejectionsAsPage();
  lines.length = 0;
  registry.declare("core", { status: [], dom: [], commands: [{
    name: "core.fixture.activate", description: "Activates.", params: { type: "object", properties: {} }, result: { type: "null" },
  }] });
  // 프로젝트 전환은 불러온 배치를 판에 예약하고 그 표시를 기다린 뒤 답한다(projects.js 의 showProject).
  registry.command("core.fixture.activate", async () => {
    schedule();
    await page.presented();
    return null;
  });
  bind(document.getElementById("projectTab"), "core.fixture.activate");
  document.getElementById("projectTab").click();
  await settle();
  await settle();
  assert.deepEqual(lines, [`error page page: surface presentation failed: ${TIMEOUT}`],
    "one layout failure of a project switch must write exactly the line of the layout queue that shows it");
});

test("a layout failure that no command waits for writes one page error line", async () => {
  reportRejectionsAsPage();
  // 같은 줄은 다시 쓰지 않으므로 앞의 표시를 거둔다.
  hideError(banner, "page");
  lines.length = 0;
  schedule();
  await settle();
  await settle();
  assert.deepEqual(lines, [`error page page: surface presentation failed: ${TIMEOUT}`],
    "one layout failure of a gesture must write exactly the line of the layout queue that shows it");
});
