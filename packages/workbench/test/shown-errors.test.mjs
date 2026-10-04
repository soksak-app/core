// 화면에 보인 오류가 그 순간 애플리케이션 로그에 남는지 검사한다.
import assert from "node:assert/strict";
import { mock, test } from "node:test";

const lines = [];
mock.module("@soksak/runtime", { namedExports: { host: {
  on: () => {},
  page: (path) => path,
  call: async (name, payload) => { if (name === "report") lines.push(payload); },
} } });
const { clearShownError, reportShownError } = await import("../shown-errors.js");

test("an error shown on the screen is logged once until it changes or clears", () => {
  reportShownError("library", "folder is missing");
  reportShownError("library", "folder is missing");
  reportShownError("library", "registry failed");
  clearShownError("library");
  reportShownError("library", "registry failed");
  assert.deepEqual(lines.splice(0), [
    "error: library: folder is missing", "error: library: registry failed", "error: library: registry failed",
  ]);
});
