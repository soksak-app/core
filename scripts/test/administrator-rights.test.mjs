// No source of the hosts or of the mygo workbench starts sudo, so no operation of the application needs administrator rights
// (docs/spec/cli.md#agents-in-the-application). The test of packages/sok/go judges the sources of the command line.
import assert from "node:assert/strict";
import test from "node:test";
import { sudoSources } from "../check-administrator-rights.mjs";

const ROOT = new URL("../../", import.meta.url).pathname;

// contract: cli.no-administrator-rights
test("no source of the hosts or of the mygo workbench starts sudo", { timeout: 5000 }, () => {
  assert.deepEqual(sudoSources(ROOT), [], "a source names the sudo command");
});
