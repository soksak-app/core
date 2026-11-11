import assert from "node:assert/strict";
import test from "node:test";

import { windowElementsOf } from "../accessibility.mjs";

test("the elements of the windows of an application are counted by their accessibility role", { timeout: 5000 }, () => {
  assert.deepEqual(windowElementsOf({ windows: 1, roles: ["AXWindow", "AXGroup", "AXButton", "AXGroup"] }, "mygo"),
    { windows: 1, elements: 4, roles: { AXWindow: 1, AXGroup: 2, AXButton: 1 } });
  assert.throws(() => windowElementsOf(null, "mygo"), new Error("System Events has no process with the pid of mygo"));
  assert.throws(() => windowElementsOf({ windows: 0, roles: [] }, "mygo"), new Error("mygo has no window that the accessibility API reads"));
});
