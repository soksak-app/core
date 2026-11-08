import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PLAIN_CONTENT, viewContentCases } from "../view-content.mjs";

test("the content case of the plain view probe waits for its content read and proves the text of its region document", async () => {
  const diagnostics = [];
  const frame = { x: 0, y: 0, width: 100, height: 50 };
  const calls = [];
  const s = {
    async until(name, predicate, message) {
      calls.push(["until", name]);
      const value = [{ surface: "tab-1", exposes: ["command probeplain.content.read"] }];
      if (!predicate(value)) throw new Error(message);
      return value;
    },
    get: async () => ({ documents: [{ surface: "tab-1", document: "page", visible: true, frame }] }),
    run: async (name, params, surface) => {
      calls.push(["run", name, surface]);
      return PLAIN_CONTENT;
    },
  };
  const cases = await viewContentCases(s, (message) => diagnostics.push(message));
  assert.deepEqual([...cases.keys()], ["probeplain"]);
  const verify = await cases.get("probeplain").ready(s, { tab: "tab-1" });
  await verify();
  assert.deepEqual(calls, [["until", "core.surfaces"], ["run", "probeplain.content.read", "tab-1"]]);
  assert.deepEqual(diagnostics, [`probeplain tab-1 shows ${JSON.stringify(PLAIN_CONTENT)}`]);
  const shown = readFileSync(new URL("../fixtures/plain-view/probe/ui/document.html", import.meta.url), "utf8");
  assert.ok(shown.includes(`<p id="content">${PLAIN_CONTENT}</p>`), "the region document of the plain view probe does not show PLAIN_CONTENT");
});
