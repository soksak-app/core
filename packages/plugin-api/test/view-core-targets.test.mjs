// Checks viewCoreTargets(), which computes the core targets of the view import map from the import closure of the view entries
// (docs/spec/plugin-processes.md, rule 4). The sources are fixtures, read through the reader that the function is given.
import assert from "node:assert/strict";
import test from "node:test";
import { viewCoreTargets } from "../index.js";

/** A reader over fixture sources keyed by package name and file path. */
function readerOf(sources) {
  return (name, file) => sources[`${name}/${file}`];
}

const FIXTURE = {
  "@soksak/plugin-api/index.js": `// imports "ignored" in a comment\nexport * from "./binder.js";\nexport { view } from "./view.js";\n`,
  "@soksak/plugin-api/view.js": `import { calls } from "./nested/calls.js";\nexport const view = calls;\n`,
  "@soksak/plugin-api/binder.js": `export const binder = 1;\n`,
  "@soksak/plugin-api/nested/calls.js": `import { binder } from "../binder.js";\nexport const calls = binder;\n`,
  "@soksak/plugin-api/unused.js": `export const unused = 1;\n`,
  "soksak/dist/index.js": `export { slice } from "./slicing.js";\n`,
  "soksak/dist/slicing.js": `export const slice = 1;\n`,
};

test("viewCoreTargets returns the sorted core root paths of the closure of the view entries", () => {
  assert.deepEqual(viewCoreTargets(readerOf(FIXTURE)), [
    "/modules/@soksak/plugin-api/binder.js",
    "/modules/@soksak/plugin-api/index.js",
    "/modules/@soksak/plugin-api/nested/calls.js",
    "/modules/@soksak/plugin-api/view.js",
    "/modules/soksak/dist/index.js",
    "/modules/soksak/dist/slicing.js",
  ]);
});

test("viewCoreTargets fails for a file of the closure that the reader does not have", () => {
  const sources = { ...FIXTURE };
  delete sources["soksak/dist/slicing.js"];
  assert.throws(() => viewCoreTargets(readerOf(sources)), /soksak\/dist\/index\.js imports \.\/slicing\.js, which is missing/);
});

test("viewCoreTargets refuses a bare import and an import outside its package", () => {
  assert.throws(
    () => viewCoreTargets(readerOf({ ...FIXTURE, "@soksak/plugin-api/view.js": `import "@soksak/runtime";\n` })),
    /@soksak\/plugin-api\/view\.js imports @soksak\/runtime, which a core target may not import/,
  );
  assert.throws(
    () => viewCoreTargets(readerOf({ ...FIXTURE, "soksak/dist/index.js": `export * from "../../runtime/index.js";\n` })),
    /soksak\/dist\/index\.js imports \.\.\/\.\.\/runtime\/index\.js, which is outside the package/,
  );
});
