// 대화상자 문서에는 메인 문서의 native paint clip 을 복사하지 않는다(docs/spec/native-modals.md). clip 은 커밋 다음 frame 에
// 바뀌므로 복사하면 요청이 그 시점에 따라 달라진다(F40).
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM('<head><style>.card{color:red}</style><style data-native-paint-clip>body::before{clip-path:path("M0,0H10V10H0Z")}</style></head><body><div id="plane"></div><div id="settings" data-native-modal="dialog" aria-label="설정">x</div></body>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.innerWidth = 800;
globalThis.innerHeight = 600;
// WebKit 문서에는 있고 jsdom 에는 없는 목록이다.
document.adoptedStyleSheets = [];
const calls = [];
mock.module("@soksak/runtime", { namedExports: { host: {
  on: () => {},
  page: (path) => path,
  call: async (name, payload) => { calls.push([name, payload]); },
} } });
const { overlay } = await import("../host.js");

test("the dialog document receives the page styles without the native paint clip", async () => {
  overlay.show(document.getElementById("settings"), { x: 0, y: 0, w: 800, h: 600 }, () => {});
  await new Promise((resolve) => setTimeout(resolve, 0));
  const [, payload] = calls.find(([name]) => name === "overlayShow");
  assert.match(payload.css, /\.card \{ color: red; \}/);
  assert.doesNotMatch(payload.css, /clip-path/, "the main page's native paint clip was copied into the dialog document");
});
