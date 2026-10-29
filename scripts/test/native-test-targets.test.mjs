import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { findUnrunTests } from "../check-native-test-targets.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const MAKEFILE = [
  "NATIVE_TESTS = a_test \\",
  "  b_test,--flag \\",
  "  c_test.app/Contents/MacOS/c_test,--bundled",
  "",
  "test-d: $(BUILD)/d_test $(BUILD)/e_test",
  "\t@$(BUILD)/d_test",
  "",
].join("\n");

test("a test source that neither the suite nor a recipe names is found", () => {
  const files = ["a", "b", "c", "d", "e"].map((name) => `native/darwin/tests/${name}_test.m`)
    .concat(["native/darwin/tests/support/records.m", "native/darwin/tests/f_benchmark.m"]);
  assert.deepEqual(findUnrunTests(files, MAKEFILE), ["native/darwin/tests/e_test.m"]);
});

test("every native test source is run by a make target", () => {
  const output = spawnSync(process.execPath, [join(ROOT, "scripts/check-native-test-targets.mjs")], { encoding: "utf8" });
  assert.equal(output.status, 0, output.stderr);
});
