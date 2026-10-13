import assert from "node:assert/strict";
import test from "node:test";
import { echoed } from "../terminal-screen.mjs";

test("a command and its output are found when the terminal wrapped them and when it did not", () => {
  // 11 columns: the command and its output of 12 characters each take two rows.
  assert.equal(echoed(["sh-3.2$ ech", "o afterproj", "ect", "afterprojec", "t", "sh-3.2$"], "afterproject"), true);
  assert.equal(echoed(["sh-3.2$ echo afterproject", "afterproject", "sh-3.2$"], "afterproject"), true);
  // The command without its output, and an output of another command, are not found.
  assert.equal(echoed(["sh-3.2$ echo afterproject"], "afterproject"), false);
  assert.equal(echoed(["sh-3.2$ echo afterproject", "afterresize", "sh-3.2$"], "afterproject"), false);
});
