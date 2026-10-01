import assert from "node:assert/strict";
import test from "node:test";

import { rejectionLine } from "../rejection.js";

test("a rejection line carries the error message when the stack holds only call sites", () => {
  // WebKit 의 stack 형식: 메시지 없이 호출 위치만 있다.
  const error = new Error("common settings: unknown setting cardSidebar");
  error.stack = "validateValues@wails://localhost/settings.js:270:55\nrefresh@wails://localhost/settings.js:330:17";
  assert.equal(rejectionLine(error), "rejected: common settings: unknown setting cardSidebar\n" +
    "validateValues@wails://localhost/settings.js:270:55\nrefresh@wails://localhost/settings.js:330:17");
  assert.equal(rejectionLine("lstat /missing: no such file or directory"), "rejected: lstat /missing: no such file or directory");
});
