import assert from "node:assert/strict";
import test from "node:test";
import { checkViewModules } from "../view-modules.js";

/** A module reader over an object of module texts keyed by path; a missing path reads as null. */
const reader = (files) => (path) => (Object.hasOwn(files, path) ? files[path] : null);

test("a page whose module graph imports only the view import map entries passes", () => {
  const files = {
    "ui/view.js": 'import { createExpose } from "@soksak/plugin-api";\nimport { createViewBridge } from "@soksak/plugin-api/view";\nimport { mount } from "./page.js";\n',
    "ui/page.js": 'import { x } from "soksak";\nimport { y } from "@soksak/shared/widget.js";\nexport const z = 1;\n',
  };
  assert.deepEqual(checkViewModules(reader(files), "ui/view.js"), []);
});

test("a module that imports a specifier outside the view import map is an error that names the module and the specifier", () => {
  const files = {
    "ui/view.js": 'import { mount } from "./render.js";\n',
    "ui/render.js": 'import { screenHash } from "@soksak/plugin-api/screen-hash";\n',
  };
  assert.deepEqual(checkViewModules(reader(files), "ui/view.js"), [
    "ui/render.js: import @soksak/plugin-api/screen-hash is not in the view import map",
  ]);
});

test("a relative import that names no module of the page is an error that names the importing module", () => {
  const files = { "ui/view.js": 'import { mount } from "./missing.js";\n' };
  assert.deepEqual(checkViewModules(reader(files), "ui/view.js"), ["ui/view.js: module ui/missing.js does not exist"]);
});

test("a dynamic import of an unmapped specifier is an error, and a comment that names one is not", () => {
  const files = {
    "ui/view.js": '// import { x } from "@soksak/plugin-api/screen-hash";\nconst m = await import("fixture-module");\n',
  };
  assert.deepEqual(checkViewModules(reader(files), "ui/view.js"), [
    "ui/view.js: import fixture-module is not in the view import map",
  ]);
});
