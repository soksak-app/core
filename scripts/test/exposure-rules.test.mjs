import assert from "node:assert/strict";
import test from "node:test";
import { auditExposure } from "../exposure-rules.mjs";

const exposes = { status: [{ name: "core.state" }], commands: [{ name: "core.open" }], dom: [{ name: "core.view" }] };
const audit = (text, registrations) => auditExposure({ where: "workbench", exposes, sources: [{ path: "page.js", text }], registrations });

test("sources that match their declarations pass", () => {
  assert.deepEqual(audit('status("core.state", read);\nregistry.command("core.open", open);\nel.dataset.expose = "core.view";\n'), []);
});

test("an undeclared name and an unregistered entry are reported", () => {
  assert.deepEqual(audit('status("core.state", read);\nrun("core.close");\n'), [
    "page.js:2: core.close is not declared",
    "page.js:2: core.close is run but is not a declared command",
    "workbench: command core.open is declared but not registered",
    "workbench: dom core.view is declared but no element carries it",
  ]);
});

test("runtime.command of an undeclared command is reported, and registrations count as registration", () => {
  assert.deepEqual(audit('status("core.state", read);\nel.dataset.expose = "core.view";\nruntime.command("core.missing", null);\n',
    ['expose.command("core.open", open);']), [
    "page.js:3: core.missing is not declared",
    "page.js:3: core.missing is run but is not a declared command",
  ]);
});
