import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { serveContentPage } from "../benchmark/cases/browser.mjs";

const require = createRequire(import.meta.url);
test("controlled Browser document delivers its own canonical public renderer provider", async t => {
  const url = await serveContentPage({ cleanup: callback => t.after(callback) });
  const response = await fetch(url);
  const html = await response.text();
  assert.match(html, /<script\s+type="module"\s+src="\/rendered-reference-page.mjs"/,
    "the actual controlled document must load its renderer-owned provider");
  const script = await fetch(new URL("/rendered-reference-page.mjs", url));
  assert.equal(script.status, 200);
  assert.match(script.headers.get("content-type"), /javascript/);
  const sdk = await fetch(new URL("/diagnostic-view-frames.mjs", url));
  assert.match(sdk.headers.get("content-type"), /javascript/);
  assert.equal(await sdk.text(), readFileSync(require.resolve("@soksak/plugin-api/diagnostic-view-frames"), "utf8"),
    "the document must use the declared SDK implementation without a second text engine");
  const unknown = await fetch(new URL("/unknown-provider.mjs", url));
  assert.equal(unknown.status, 404, "missing modules cannot silently become the HTML document");
});
