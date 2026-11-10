// A core command has no command limit: its handler belongs to the workbench, and its result or its error ends it (`timeout` in
// docs/spec/exposure.md). The declared timeout applies to a plugin command that a state module runs in the main page.
import assert from "node:assert/strict";
import test from "node:test";

const { createRegistry } = await import("../exposure.js");

test("a core command whose handler takes longer than its declared timeout answers its result", async () => {
  const made = createRegistry();
  made.declare("core", {
    commands: [{ name: "core.fixture.slow", description: "Slow.", timeout: 20, params: { type: "object" }, result: { type: "integer" } }],
  });
  made.command("core.fixture.slow", () => new Promise((resolve) => setTimeout(() => resolve(7), 80)));
  const answer = await made.handle({ method: "command.run", params: { name: "core.fixture.slow", params: {} } });
  assert.deepEqual(answer, { result: 7 }, "the command limit ended a core command");
});
