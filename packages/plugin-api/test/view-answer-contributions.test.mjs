// Checks the route of the view call runtime.contributions in answerViewCall (docs/spec/plugins.md, provider interface): a view
// receives each connected item with the installed folder of its contributor, as a page of the main document does, and the module as a
// URL of the core root.
import assert from "node:assert/strict";
import test from "node:test";
import { answerViewCall } from "../view-answer.js";

const ITEM = { plugin: "maker", index: 0, item: { id: "group" }, module: "/plugins/maker/0.0.1/maker/index.js", folder: "/config/plugins/maker/0.0.1" };

test("runtime.contributions gives a view the folder of the contributor of each item", async () => {
  const points = [];
  const answer = await answerViewCall({ id: 1, command: "runtime.contributions", params: { point: "agents.makers" } }, {
    plugin: "agents",
    surface: "agents-section",
    pending: new Map(),
    emitEvent() {},
    contributions: (point) => {
      points.push(point);
      return [ITEM];
    },
  });
  assert.deepEqual(points, ["agents.makers"]);
  assert.equal(answer.length, 1);
  assert.equal(answer[0].folder, "/config/plugins/maker/0.0.1");
  assert.deepEqual({ ...answer[0], module: undefined }, { plugin: "maker", index: 0, item: { id: "group" }, module: undefined, folder: "/config/plugins/maker/0.0.1" });
  assert.match(answer[0].module, /\/plugins\/maker\/0\.0\.1\/maker\/index\.js$/);
});
