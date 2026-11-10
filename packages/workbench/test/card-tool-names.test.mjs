import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";

// The tooltip of a card tool is its name, a refusal states its reason, and the ⋯ menu takes the same name; the names are one list of
// workbench.json that the specification states (docs/spec/example-model.md#card-tools).
test("the tooltip of a card tool is its name and a refusal states its reason", async () => {
  const declaration = JSON.parse(readFileSync(new URL("../workbench.json", import.meta.url), "utf8"));
  const names = declaration.cardTools;
  assert.deepEqual(names, {
    add: "탭 추가", "split-x": "세로로 나누기", "split-y": "가로로 나누기", fullscreen: "카드 전체 화면", restore: "카드 배치 복원",
    close: "카드 닫기", "close-refused": "이 자리를 빈틈없이 메울 이웃이 없어 닫을 수 없다", "layout-held": "전체 화면에서는 배치를 바꿀 수 없다",
  });
  for (const name of Object.values(names)) assert.ok(!name.includes("—"), `${name} carries a dash`);
  const spec = readFileSync(new URL("../../../docs/spec/example-model.md", import.meta.url), "utf8");
  for (const name of Object.values(names)) assert.ok(spec.includes(name), `the specification does not state ${name}`);
  const dom = new JSDOM("<body></body>");
  globalThis.document = dom.window.document;
  try {
    const { registry } = await import("../exposure.js");
    registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);
    const tools = await import("../card-tools.js");
    const toolbar = tools.createCardTools("fixture");
    const titles = () => Object.fromEntries([...toolbar.children].map((button) => [button.dataset.do, button.title]));
    tools.updateCardTools(toolbar, { canClose: true, canSplitX: true, canSplitY: true, fullscreen: false });
    assert.deepEqual(titles(), { add: names.add, x: names["split-x"], y: names["split-y"], fullscreen: names.fullscreen, close: names.close });
    for (const button of toolbar.children) assert.equal(button.getAttribute("aria-label"), button.title);
    tools.updateCardTools(toolbar, { canClose: false, canSplitX: true, canSplitY: true, fullscreen: false });
    assert.equal(titles().close, names["close-refused"]);
    tools.updateCardTools(toolbar, { canClose: true, canSplitX: true, canSplitY: true, fullscreen: true });
    const held = names["layout-held"];
    assert.deepEqual(titles(), { add: held, x: held, y: held, fullscreen: names.restore, close: held });
  } finally { dom.window.close(); }
  // The ⋯ menu names an item by the title of its tool and cuts nothing from it.
  const plane = readFileSync(new URL("../plane.js", import.meta.url), "utf8");
  assert.ok(!plane.includes('split(" — ")'), "the tool menu cuts the names of the tools");
});
