import assert from "node:assert/strict";
import test from "node:test";

// 참조가 맞지 않는 environment.json 은 아무것도 등록하지 않고 실패한다.
globalThis.fetch = async (path) => {
  const files = {
    "/environment.json": {
      runtime: "runtime",
      plugins: ["@fixture/side"],
      workspace: { focus: "main", grid: { xs: [0, 1], ys: [0, 1], cards: [
        { id: "main", c0: 0, c1: 1, r0: 0, r1: 1, tabs: [{ plugin: "missing", title: "m" }] },
      ] } },
      sidebars: { sets: [], links: [] },
    },
    "/modules/@fixture/side/plugin.json": { id: "side", name: "Side", sections: [{ id: "side.list", name: "List" }] },
  };
  const body = files[path];
  return body ? { ok: true, json: async () => structuredClone(body) } : { ok: false, status: 404 };
};

const { loadEnvironment } = await import("../environment.js");
const registry = await import("../registry.js");

test("an environment naming a missing plugin fails before registration", async () => {
  await assert.rejects(loadEnvironment(), /tab plugin missing has no surface/);
  assert.throws(() => registry.section("side.list"), /unknown section/);
});
