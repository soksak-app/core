// 배치 하나의 실패가 애플리케이션 로그에 쓰는 줄을 검사한다. 배치 대기열의 failed 가 그 실패를 받아 보이므로, 그 배치를
// 기다린 프로젝트 전환 명령이나 배치를 예약한 몸짓은 같은 실패를 다시 쓰지 않는다(docs/spec/hosts.md#application-log).
// 연결은 index.html 의 배치 대기열, 오류 표시, 처리되지 않은 거절의 보고, 프로젝트 전환의 presented 와 같다.
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { JSDOM } from "jsdom";

const TIMEOUT = "the current image raster did not present within 10s; pending tab-1/view generation 2 raster 1 sequence 0 presented 0/0 surface visible";

const dom = new JSDOM('<div id="applicationError"></div><button id="projectTab"></button>');
globalThis.document = dom.window.document;
const lines = [];
mock.module("@soksak/runtime", { namedExports: { host: {
  on: () => {},
  page: (path) => path,
  call: async (name, request) => {
    if (name === "report") { lines.push(request); return; }
    throw new Error(`unexpected host call ${name}`);
  },
} } });
const { report } = await import("../host.js");
const { createLayoutQueue } = await import("../layout-queue.js");
const { hideError, showError: showShownError } = await import("../shown-errors.js");
const { connectExposure, registry } = await import("../exposure.js");
const { bind } = await import("../commands.js");

// index.html 의 showError 와 같다.
const banner = document.getElementById("applicationError");
const showError = (reason, detail = "") => showShownError(banner, "page", String(reason), detail);
/**
 * 처리되지 않은 거절을 index.html 처럼 보고한다. 문서의 처리되지 않은 거절은 이 보고만 받으므로, 첫 test() 가 설치하는
 * 테스트 실행기의 처리기를 각 테스트의 시작에서 뗀다.
 */
function reportRejectionsAsPage() {
  process.removeAllListeners("unhandledRejection");
  process.on("unhandledRejection", (reason) => {
    const stack = reason instanceof Error && reason.stack ? `\n${reason.stack}` : "";
    showError(reason instanceof Error ? reason.message : reason, stack);
  });
}

const layouts = createLayoutQueue({
  failed(error) {
    showError(`surface presentation failed: ${String(error?.message ?? error)}`);
  },
  superseded() {},
});
await connectExposure({ settled: async () => { await layouts.wait(); }, report });
const failing = () => Promise.reject(new Error(TIMEOUT));
/** 판이 배치를 예약한다(index.html 의 onLayout). */
const schedule = () => { layouts.run(failing); };
/** 프로젝트 전환이 판의 표시를 기다린다(index.html 의 onSwitch presented). */
async function presented() {
  if (!(await layouts.wait())) return;
}

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
    await presented();
    return null;
  });
  bind(document.getElementById("projectTab"), "core.fixture.activate");
  document.getElementById("projectTab").click();
  await settle();
  await settle();
  assert.deepEqual(lines, [`error: page: surface presentation failed: ${TIMEOUT}`],
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
  assert.deepEqual(lines, [`error: page: surface presentation failed: ${TIMEOUT}`],
    "one layout failure of a gesture must write exactly the line of the layout queue that shows it");
});
