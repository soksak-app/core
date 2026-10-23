import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

test("Tauri start module imports the core start document from the canonical scheme", { timeout: 5_000 }, async () => {
  const requested = [];
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "soksak://core/start.json") {
        requested.push(specifier);
        return { url: new URL("./fixtures/start.json", import.meta.url).href, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
  });

  try {
    const { default: start } = await import(`../runtime/start.js?test=${Date.now()}`);
    assert.deepEqual(start, { window: "main" });
    assert.deepEqual(requested, ["soksak://core/start.json"]);
  } finally {
    hooks.deregister();
  }
});
