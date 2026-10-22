// Checks that checkViewPage accepts a view page that begins with a doctype and holds no import map, and throws an error that
// names the reason otherwise. The host inserts the view import map into the page (docs/spec/plugin-processes.md, rule 4).
import assert from "node:assert/strict";
import test from "node:test";
import { VIEW_IMPORTS, checkViewPage } from "../index.js";

const importMap = (map) => `<script type="importmap">${JSON.stringify(map)}</script>`;
const page = (...head) =>
  `<!doctype html>\n<html>\n<head>\n<meta charset="utf-8">\n<title>view</title>\n${head.join("\n")}\n</head>\n` +
  `<body>\n<script type="module" src="./app.js"></script>\n</body>\n</html>\n`;

test("checkViewPage accepts a page that begins with a doctype and holds no import map", () => {
  assert.equal(checkViewPage(page()), undefined);
});

test("checkViewPage accepts a doctype written in any letter case", () => {
  assert.equal(checkViewPage(`<!DOCTYPE HTML>\n<title>view</title>`), undefined);
});

test("checkViewPage refuses a page without a doctype at its start", () => {
  assert.throws(() => checkViewPage(`<title>view</title>`), { message: "view page has no doctype at its start" });
  assert.throws(() => checkViewPage(`\n<!doctype html><title>view</title>`), { message: "view page has no doctype at its start" });
});

test("checkViewPage refuses a page that holds an import map of its own, which would be a second map", () => {
  assert.throws(() => checkViewPage(page(importMap({ imports: VIEW_IMPORTS }))), { message: "view page has an import map" });
  assert.throws(() => checkViewPage(page(importMap({}))), { message: "view page has an import map" });
});

test("checkViewPage refuses an import map whose attributes are unquoted or in another order", () => {
  assert.throws(() => checkViewPage(`<!doctype html><script src=x.js type=importmap></script>`), {
    message: "view page has an import map",
  });
});
