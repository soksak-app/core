// Checks that checkViewPage accepts a view page whose one static import map equals VIEW_IMPORTS, and throws an error
// that names the difference otherwise (docs/spec/plugins.md#view-surfaces).
import assert from "node:assert/strict";
import test from "node:test";
import { VIEW_IMPORTS, checkViewPage } from "../index.js";

const importMap = (map) => `<script type="importmap">${JSON.stringify(map)}</script>`;
const page = (...head) =>
  `<!doctype html>\n<html>\n<head>\n<meta charset="utf-8">\n<title>view</title>\n${head.join("\n")}\n</head>\n` +
  `<body>\n<script type="module" src="./app.js"></script>\n</body>\n</html>\n`;

test("checkViewPage accepts a page whose one import map equals VIEW_IMPORTS", () => {
  assert.equal(checkViewPage(page(importMap({ imports: VIEW_IMPORTS }))), undefined);
});

test("checkViewPage refuses a page with no import map", () => {
  assert.throws(() => checkViewPage(page()), /expected one import map, found 0/);
});

test("checkViewPage refuses a page with two import maps", () => {
  const map = importMap({ imports: VIEW_IMPORTS });
  assert.throws(() => checkViewPage(page(map, map)), /expected one import map, found 2/);
});

test("checkViewPage refuses an import map that is not JSON", () => {
  assert.throws(() => checkViewPage(page(`<script type="importmap">{imports</script>`)), SyntaxError);
});

test("checkViewPage refuses an import map without an imports object", () => {
  assert.throws(() => checkViewPage(page(importMap({}))), /view page import map: imports must be an object/);
  assert.throws(() => checkViewPage(page(importMap(null))), /view page import map: expected an object/);
});

test("checkViewPage names an entry of VIEW_IMPORTS that the map lacks", () => {
  const rest = { ...VIEW_IMPORTS };
  delete rest.soksak;
  assert.throws(
    () => checkViewPage(page(importMap({ imports: rest }))),
    /view page import map: missing entry "soksak"/,
  );
});

test("checkViewPage names an entry that the map adds to VIEW_IMPORTS", () => {
  const imports = { ...VIEW_IMPORTS, "@soksak/runtime": "/modules/@soksak/runtime/index.js" };
  assert.throws(
    () => checkViewPage(page(importMap({ imports }))),
    /view page import map: unexpected entry "@soksak\/runtime"/,
  );
});

test("checkViewPage names an entry whose target differs from VIEW_IMPORTS", () => {
  const imports = { ...VIEW_IMPORTS, "@soksak/plugin-api/view": "sok://core/modules/@soksak/plugin-api/page.js" };
  assert.throws(
    () => checkViewPage(page(importMap({ imports }))),
    /view page import map: entry "@soksak\/plugin-api\/view" is "sok:\/\/core\/modules\/@soksak\/plugin-api\/page\.js", want "sok:\/\/core\/modules\/@soksak\/plugin-api\/view\.js"/,
  );
});

test("checkViewPage refuses a map with a scopes field, which could remap the imports", () => {
  const scoped = { imports: VIEW_IMPORTS, scopes: { "sok://core/": { soksak: "sok://core/x.js" } } };
  assert.throws(() => checkViewPage(page(importMap(scoped))), /view page import map: unexpected field "scopes"/);
});
