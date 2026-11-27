// The group 설정이 있는 플러그인 lists every installed plugin by id, whether or not it declares settings (docs/spec/settings.md#menu).
import assert from "node:assert/strict";
import test from "node:test";
import { menuItemsOf } from "../settings-plugins.js";

test("the menu group lists each installed plugin by id, and no plugin that is not installed", () => {
  const rows = [
    { id: "moai", name: "moai", installed: { version: "1.0.0", enabled: true } },
    { id: "agents", name: "에이전트", installed: null },
    { id: "alpha", name: "alpha", installed: { version: "1.0.0", enabled: false } },
  ];
  assert.deepEqual(menuItemsOf(rows).map((row) => row.id), ["alpha", "moai"]);
});
