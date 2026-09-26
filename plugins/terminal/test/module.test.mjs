import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const manifest = JSON.parse(readFileSync(new URL("../plugin.json", import.meta.url), "utf8"));


// 터미널은 설정 shell 이 가리키는 셸을 연다.
// 실제 표면 문맥처럼 매니페스트의 모든 설정 기본값을 읽는다.
const SHELL_SETTINGS = {
  read: () => ({ ...Object.fromEntries(Object.entries(manifest.settings).map(([key, { default: value }]) => [key, value])), shell: "/bin/sh" }),
  on: () => () => {},
};
test("terminal module waits for composition presentation, publishes state, and disposes the controller", async () => {
  const view = { addEventListener() {}, removeEventListener() {} };
  const element = () => ({ style: {}, hidden: true, addEventListener() {}, removeEventListener() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 10, height: 300 }) });
  const parts = { "#view": view, "#scrollbar": element(), "#thumb": element() };
  const root = {
    childNodes: [],
    set innerHTML(value) { this.childNodes = value ? [view] : []; },
    querySelector(selector) { return parts[selector] ?? null; },
    replaceChildren() { this.childNodes = []; },
  };
  globalThis.window = { TextEncoder };
  const imageListeners = new Map();
  const image = {
    on(type, listener) {
      imageListeners.set(type, listener);
      return () => imageListeners.delete(type);
    },
    focus: async () => {}, setCaret: async () => {},
  };
  const sidecarListeners = new Map();
  const messages = [];
  const sidecar = {
    async on(id, listener) { sidecarListeners.set(id, listener); return () => sidecarListeners.delete(id); },
    async send(id, body) { messages.push({ id, body }); },
  };
  const statuses = new Map();
  const context = {
    surfaceId: "terminal-test",
    runtime: { sidecar: () => sidecar, theme: (listener) => listener({ scheme: "light",
      tokens: { "--card": "#ffffff", "--fg": "#252735", "--edge": "#d8dbe4" } }), settings: SHELL_SETTINGS },
    composition: {
      async create() {
        await presentation;
        return { region: () => image, dispose: async () => { compositionDisposed = true; } };
      },
    },
    exposure: {
      status: async (name, read, subscribe) => statuses.set(name, { read, subscribe }),
      command: async () => {}, dom: async () => {}, bind: async () => {}, delegate: async () => {}, mark: async () => {},
      dispose: async () => { exposureDisposed = true; },
    },
    status: { report: (phase) => { phases.push(phase); } },
  };
  let resolvePresentation;
  const presentation = new Promise((resolve) => { resolvePresentation = resolve; });
  let compositionDisposed = false;
  let exposureDisposed = false;
  const phases = [];
  const { mount } = await import("../ui/terminal-module.js");
  const mounting = mount(root, context);
  await Promise.resolve();
  assert.deepEqual(phases, [], "ready is not reported before native presentation");
  resolvePresentation();
  const mounted = await mounting;
  assert.deepEqual(phases, ["ready"]);
  sidecarListeners.get("terminal-test")({ event: "state", sessionId: "s1", cols: 80, rows: 24, cellWidth: 8, cellHeight: 16 });
  assert.equal(statuses.get("terminal.session").read().sessionId, "s1");
  // 테마는 모드와 함께 카드 색 토큰에서 가져온 네 색을 보낸다(docs/spec/terminal-runtime.md).
  assert.deepEqual(messages.find(({ body }) => body.operation === "theme")?.body,
    { operation: "theme", mode: "light", background: "#ffffff", foreground: "#252735", cursor: "#252735", selection: "#d8dbe4" });
  await mounted.dispose();
  assert.equal(compositionDisposed, true);
  assert.equal(exposureDisposed, true);
  assert.equal(messages.at(-1).body.operation, "close");
  assert.equal(root.childNodes.length, 0);
  delete globalThis.window;
});

test("terminal module disposes its native composition when sidecar open fails", async () => {
  const view = { addEventListener() {}, removeEventListener() {} };
  const root = {
    set innerHTML(value) { this.childNodes = value ? [view] : []; },
    querySelector() { return view; },
    replaceChildren() { this.childNodes = []; },
  };
  globalThis.window = { TextEncoder };
  let compositionDisposed = false;
  const phases = [];
  const context = {
    surfaceId: "terminal-open-failure",
    runtime: { sidecar: () => ({
      async on() { return () => {}; },
      async send(_id, body) {
        if (body.operation === "open") throw new Error("connect authenticated service: socket missing");
      },
    }), theme: () => {}, settings: SHELL_SETTINGS },
    composition: {
      async create() {
        return {
          region: () => ({ on: () => () => {}, focus: async () => {}, setCaret: async () => {} }),
          dispose: async () => { compositionDisposed = true; },
        };
      },
    },
    exposure: { status: async () => {}, command: async () => {}, dom: async () => {}, bind: async () => {}, delegate: async () => {}, mark: async () => {}, dispose: async () => {} },
    status: { report: (phase, error) => { phases.push({ phase, error }); } },
  };
  const { mount } = await import(`../ui/terminal-module.js?open-failure=${Date.now()}`);
  await assert.rejects(mount(root, context), /connect authenticated service: socket missing/);
  assert.equal(compositionDisposed, true, "failed sidecar startup releases the native image composition");
  assert.equal(phases.length, 0, "a mount failure is propagated instead of being reported as ready");
  delete globalThis.window;
});
