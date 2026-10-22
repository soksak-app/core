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
    "ui/render.js": 'import { records } from "@soksak/plugin-api/records-check";\n',
  };
  assert.deepEqual(checkViewModules(reader(files), "ui/view.js"), [
    "ui/render.js: import @soksak/plugin-api/records-check is not in the view import map",
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

test("a view page that imports the screen hash module of plugin-api passes, because the view map serves it", () => {
  const files = {
    "ui/view.js": 'import { screenHash } from "@soksak/plugin-api/screen-hash";\n',
  };
  assert.deepEqual(checkViewModules(reader(files), "ui/view.js"), []);
});

test("a string literal of a minified vendor bundle that reads as an import is not an import", () => {
  // The text of the editor vendor bundle (ui/vendor/libraries.js): the keyword list of a highlighter holds the text "import export from"
  // as a string literal, and the newline after the entry is a line break of the bundle.
  const files = {
    "ui/vendor/libraries.js": 'const keywords = {\n  "import export from": tags5.moduleKeyword,\n  "with debugger new": tags5.keyword,\n};\n',
  };
  assert.deepEqual(checkViewModules(reader(files), "ui/vendor/libraries.js"), []);
});

test("a re-export of a bare specifier outside the view import map is an error, and a re-export of a missing relative module too", () => {
  const files = {
    "ui/view.js": 'export { records } from "@soksak/plugin-api/records-check";\nexport * from "./missing.js";\n',
  };
  assert.deepEqual(checkViewModules(reader(files), "ui/view.js"), [
    "ui/view.js: import @soksak/plugin-api/records-check is not in the view import map",
    "ui/view.js: module ui/missing.js does not exist",
  ]);
});

test("a dynamic import whose argument is not a literal is not read, and a module whose imports the lexer rejects is an error that names it", () => {
  const files = {
    "ui/view.js": "const m = await import(name);\nconst n = await import(`./locale/${lang}.js`);\nconst p = import.meta.url;\nimport './bad.js';\n",
    "ui/bad.js": "import { = from \"x\";\n",
  };
  const errors = checkViewModules(reader(files), "ui/view.js");
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^ui\/bad\.js: the imports of the module cannot be read: /);
});
