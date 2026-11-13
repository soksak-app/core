// The native paint clip of the main document is not copied to the dialog document (docs/spec/native-modals.md). The clip changes in the frame after a commit,
// so copying it would make the request depend on that timing (F40).
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { selectPageWire } from "@soksak/runtime";

const dom = new JSDOM('<head><style>.card{color:red}</style><style data-native-paint-clip>body::before{clip-path:path("M0,0H10V10H0Z")}</style></head><body><div id="plane"></div><div id="settings" data-native-modal="dialog" aria-label="설정">x</div></body>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.innerWidth = 800;
globalThis.innerHeight = 600;
// This is a list that a WebKit document has and jsdom does not.
document.adoptedStyleSheets = [];
// The host calls of the overlay are answered by the page-wire case of this test (docs/spec/cases/page-wire/README.md). The case is selected before
// host.js is imported, because the page reads the host when it imports it.
const wire = selectPageWire("overlay-paint-clip");
const { overlay, orderedCallsAnswered } = await import("../host.js");

test("the dialog document receives the page styles without the native paint clip", async () => {
  overlay.show(document.getElementById("settings"), { x: 0, y: 0, w: 800, h: 600 }, () => {});
  await orderedCallsAnswered();
  const { payload } = wire.calls.find((call) => call.name === "overlayShow");
  assert.match(payload.css, /\.card \{ color: red; \}/);
  assert.doesNotMatch(payload.css, /clip-path/, "the main page's native paint clip was copied into the dialog document");
  wire.finish();
});
