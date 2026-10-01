import assert from "node:assert/strict";
import test from "node:test";

// 참조가 맞지 않는 environment.json 은 아무것도 등록하지 않고 실패한다.
globalThis.fetch = async (path) => {
  const files = {
    "/environment.json": {
      runtime: "runtime",
      workspace: { focus: "main", grid: { xs: [0, 1], ys: [0, 1], cards: [
        { id: "main", c0: 0, c1: 1, r0: 0, r1: 1, tabs: [{ plugin: "side", title: "m" }] },
      ] } },
      sidebars: { sets: [], links: [] },
    },
    "/installed-plugins.json": { plugins: [{ id: "side", package: "@fixture/side", version: "0.0.1" }] },
    "/modules/@fixture/side/plugin.json": { id: "side", name: "Side", description: "검사용 섹션.", sections: [{ id: "side.list", name: "List", module: "ui/list.js" }] },
  };
  const body = files[path];
  return body ? { ok: true, json: async () => structuredClone(body) } : { ok: false, status: 404 };
};

const { loadEnvironment } = await import("../environment.js");
const registry = await import("../registry.js");

// 불러오지 않은 플러그인의 탭은 placeholder 로 열리므로 실패하지 않는다(docs/spec/plugins.md). 불러온 플러그인이
// 표면 없이 탭에 쓰이면 실패한다.
test("an environment naming a loaded plugin without a surface as a tab fails before registration", async () => {
  await assert.rejects(loadEnvironment(), /tab plugin side has no surface/);
  assert.throws(() => registry.section("side.list"), /unknown section/);
});
