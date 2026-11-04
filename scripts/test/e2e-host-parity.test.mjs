import assert from "node:assert/strict";
import test from "node:test";
import { auditE2EHostParity } from "../check-e2e-host-parity.mjs";

test("every application E2E suite runs the same scenario through both adapters", () => {
  const result = auditE2EHostParity();
  assert.deepEqual(result.errors, []);
  assert.ok(result.shared.length >= 14, `expected the current shared suite inventory, got ${result.shared.length}`);
});

// The unit tests of the window-check helpers are in e2e/test/ (docs/operations/examples.md#test-kinds), so every test file of
// the window-check folder is an application suite and no file name is exempt.
test("a window-check file that does not run both adapters is an error whatever its name", () => {
  const result = auditE2EHostParity(["app-contract.test.mjs"], () => 'import test from "node:test";\n');
  assert.deepEqual(result.errors, ["app-contract.test.mjs: app behavior test imports neither APPS nor MAIN_PAGE_APPS"]);
});

const IMPORT = 'import { APPS, MAIN_PAGE_APPS, open } from "@soksak/window-check/app.mjs";\n';
const audit = (body) => auditE2EHostParity(["probe.test.mjs"], () => IMPORT + body).errors;

// A window check iterates the applications of the session (Object.values(APPS)) or, when its subject is the main page or a
// modal web view, the applications that have one (MAIN_PAGE_APPS); a check over another set leaves a host out unseen.
test("a window check that iterates Object.values(APPS) or MAIN_PAGE_APPS passes", () => {
  assert.deepEqual(audit("for (const app of Object.values(APPS)) test(app.name, () => {});\n"), []);
  assert.deepEqual(audit("for (const app of MAIN_PAGE_APPS) test(app.name, () => {});\n"), []);
  assert.deepEqual(audit("const names = Object.values(APPS).map((app) => app.name);\nfor (const app of MAIN_PAGE_APPS) {}\n"), []);
});

test("a window check that iterates another set of applications is an error", () => {
  assert.deepEqual(audit("for (const app of [APPS.wailsv3]) test(app.name, () => {});\n"),
    ["probe.test.mjs:2: window check selects APPS.wailsv3; it iterates Object.values(APPS) or MAIN_PAGE_APPS"]);
  assert.deepEqual(audit('for (const app of Object.values(APPS).filter((app) => app.name !== "mygo")) {}\n'),
    ["probe.test.mjs:2: window check selects Object.values(APPS).filter; it iterates Object.values(APPS) or MAIN_PAGE_APPS"]);
  assert.deepEqual(audit("for (const app of MAIN_PAGE_APPS.slice(1)) {}\n"),
    ["probe.test.mjs:2: window check selects MAIN_PAGE_APPS.slice; it iterates Object.values(APPS) or MAIN_PAGE_APPS"]);
  assert.deepEqual(audit("for (const [name, app] of Object.entries(APPS)) {}\n"),
    ["probe.test.mjs:2: window check selects Object.entries(APPS); it iterates Object.values(APPS) or MAIN_PAGE_APPS"]);
});

// A window check runs against every application, except a check of the main page or a modal web view (docs/spec/host-parity.md).
test("a window check that iterates a set other than Object.values(APPS) and MAIN_PAGE_APPS is an error", () => {
  const check = (body) => auditE2EHostParity(["set.test.mjs"], () => `import { APPS, MAIN_PAGE_APPS } from "@soksak/window-check/app.mjs";\n${body}\n`).errors;
  const refused = ["set.test.mjs: window check iterates a set other than Object.values(APPS) and MAIN_PAGE_APPS"];
  assert.deepEqual(check("for (const app of Object.values(APPS)) test(app.name);"), []);
  assert.deepEqual(check("for (const app of MAIN_PAGE_APPS) test(app.name);"), []);
  assert.deepEqual(check("for (const app of [APPS.wailsv3]) test(app.name);"), refused);
  assert.deepEqual(check("for (const app of Object.values(APPS).filter((item) => item.name !== 'mygo')) test(app.name);"), refused);
});
