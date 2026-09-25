// 섹션 모듈이 받는 문맥(status 관찰과 명령 연결)과 core.sidebars 의 섹션 내용을 검사한다.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<body></body>", { url: "https://example.test/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;

const { registry } = await import("../exposure.js");
const { audit } = await import("../commands.js");
const { registerSection } = await import("../registry.js");
const { drawSet, sidebarsState, clearSet } = await import("../sidebar-sections.js");

registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);
registry.declare("probe", {
  status: [{ name: "probe.lines", description: "Lines.", schema: { type: "array" } }],
  commands: [{ name: "probe.send", description: "Sends.", params: { type: "object" }, result: {} }],
  dom: [],
});

// 섹션 모듈: 관찰한 값과 표면을 한 줄로 그리고, 명령에 연결한 단추 하나를 둔다.
const source = `export function mount(root, context) {
  const line = document.createElement("p");
  const button = document.createElement("button");
  button.textContent = "send";
  context.bind(button, "probe.send", { text: "x" });
  const stop = context.status("probe.lines", (value, surface) => { line.textContent = JSON.stringify([surface, value]); });
  root.append(line, button);
  return { dispose() { stop(); line.remove(); button.remove(); } };
}`;
registerSection({ id: "probe.view", name: "보기", module: `data:text/javascript,${encodeURIComponent(source)}` });
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test("a section observes its plugin status, binds controls with the section control name, and reports its text", async () => {
  const container = document.createElement("div");
  container.className = "set";
  document.body.append(container);
  drawSet(container, "rail-probe", { id: "set-probe", title: "세트", layout: "list", sections: ["probe.view"] },
    { card: "rail-probe", surface: "tab-a" });
  await settle();
  const [state] = sidebarsState();
  assert.equal(state.sections[0].mounted, true, state.sections[0].error);
  assert.equal(state.sections[0].text, "[null,null]send", "without a registered surface the section shows null");
  const button = container.querySelector("button:not(.set__head)");
  assert.equal(button.dataset.expose, "core.sidebar.section.control");
  assert.equal(button.dataset.command, "probe.send");
  assert.equal(button.closest("[data-surface]")?.dataset.surface, "tab-a", "the section names the card's tab");
  assert.deepEqual(audit(container), [], "section controls are connected and named");
  clearSet(container);
});
