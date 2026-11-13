// A core command answers after the host answered the ordered calls that it sent, so a modal that the command opened holds the
// input of the window when the command answers (docs/spec/native-modals.md#keyboard).
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM('<body><div id="plane"></div><div id="menu" data-native-modal="menu" aria-label="Menu"></div></body>', { url: "https://example.test/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);

// The host answers each ordered call when the test lets it, and answers the application log at once.
const pending = [];
const logged = [];
const answerLog = (request) => {
  if (request.action === "clock") return Promise.resolve({ ts_us: 1, mono_ns: 1 });
  logged.push(JSON.stringify(request));
  return Promise.resolve();
};
// The names of the ordered calls in the order the host received them, and the waiters for a count of them.
const received = [];
const arrivals = [];
const untilReceived = (count) => new Promise((resolve) => {
  const check = () => (received.length >= count ? resolve() : arrivals.push(check));
  check();
});
mock.module("@soksak/runtime", { namedExports: { host: {
  on: () => Promise.resolve(() => {}),
  page: (path) => path,
  call: (name, request) => {
    if (name === "log") return answerLog(request);
    received.push(name);
    const call = new Promise((resolve, reject) => pending.push({ name, request, resolve, reject }));
    for (const check of arrivals.splice(0)) check();
    return call;
  },
  reload: () => {},
} } });
const { orderedCallsAnswered, overlay } = await import("../host.js");

test("the wait of the ordered calls ends after the host answered the show of a modal", async () => {
  received.length = 0;
  const el = document.getElementById("menu");
  overlay.show(el, { x: 0, y: 0, w: 10, h: 10 }, () => {});
  let answered = false;
  const wait = orderedCallsAnswered().then(() => { answered = true; });
  await untilReceived(1);
  assert.deepEqual(pending.map((call) => call.name), ["overlayShow"]);
  assert.equal(answered, false, "the wait ended before the host answered the show of the modal");
  pending.shift().resolve({ x: 0, y: 0, w: 10, h: 10 });
  await wait;
  assert.equal(answered, true);
});

test("a show that failed ends the wait too, so the command still answers", async () => {
  received.length = 0;
  const el = document.getElementById("menu");
  overlay.show(el, { x: 0, y: 0, w: 10, h: 10 }, () => {});
  const wait = orderedCallsAnswered();
  await untilReceived(1);
  // The show replaces the open modal, so its hide goes first.
  assert.deepEqual(pending.map((call) => call.name), ["overlayHide"]);
  pending.shift().resolve();
  await untilReceived(2);
  assert.deepEqual(pending.map((call) => call.name), ["overlayShow"]);
  pending.shift().reject(new Error("create modal webview: refused"));
  await wait;
  // The failure of the show was written to the application log before the wait ended.
  assert.ok(logged.some((batch) => batch.includes('"where":"host overlayShow failed","text":"Error: create modal webview: refused"')),
    `the application log holds no failure of the show: ${logged.join("\n")}`);
});
