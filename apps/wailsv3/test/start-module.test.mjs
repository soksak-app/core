import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

test("Wails start module imports the start document from the asset path", { timeout: 5_000 }, async () => {
  const requested = [];
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "/start.json") {
        requested.push(context.parentURL);
        return { url: new URL("./fixtures/start.json", import.meta.url).href, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
  });

  try {
    const { default: start } = await import(`../runtime/start.js?test=${Date.now()}`);
    assert.deepEqual(start, { window: "main" });
    assert.equal(requested.length, 1, "the module did not request its start document once");
    assert.equal(
      new URL(requested[0]).pathname,
      new URL("../runtime/start.js", import.meta.url).pathname,
      "another module requested the Wails start asset",
    );
  } finally {
    hooks.deregister();
  }
});
