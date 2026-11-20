// The check of the parameters of a command against its params schema before it runs (docs/spec/exposure.md#command-parameters). The
// registry of a document runs every case of docs/spec/cases/command-params.json; the registry of the mygo workbench and the endpoints of
// the Go and Rust hosts run the same cases.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { EXPOSURE_ERRORS, declarationMap, exposureEntries } from "../index.js";

const { cases } = JSON.parse(readFileSync(new URL("../../../docs/spec/cases/command-params.json", import.meta.url), "utf8"));

// contract: exposure.command-params.checked-before-the-run
test("the registry of a document refuses the parameters of each case before the command runs, with the text of the case", { timeout: 5000 }, async () => {
  assert.ok(cases.length >= 8, "command-params.json holds fewer than eight cases");
  for (const { name, command, schema, params, error } of cases) {
    const entries = exposureEntries(declarationMap({ commands: [{ name: command, description: "Runs.", params: schema, result: { type: "null" } }] }));
    let runs = 0;
    entries.command(command, () => { runs++; return null; });
    if (error === null) {
      assert.equal(await entries.answer("command.run", { name: command, params }), null, name);
      assert.equal(runs, 1, `${name}: the command did not run`);
      continue;
    }
    await assert.rejects(entries.answer("command.run", { name: command, params }),
      (refusal) => refusal.code === EXPOSURE_ERRORS.invalidParams && refusal.message === error, `${name}: not refused with ${error}`);
    assert.equal(runs, 0, `${name}: the refused command ran`);
  }
});
