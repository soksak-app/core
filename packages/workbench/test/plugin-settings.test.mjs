import test from "node:test";
import assert from "node:assert/strict";
import { setPluginSettings, value } from "../settings.js";

test("string plugin settings accept a bounded value and reject an empty or long one", () => {
  const manifest = { id: "probe", settings: { "font.family": { type: "string", default: "D2Coding", maxLength: 12 } } };
  assert.throws(() => setPluginSettings([manifest], { probe: { "font.family": "" } }), /string value/);
  assert.throws(() => setPluginSettings([{ ...manifest, id: "long" }], { long: { "font.family": "a much too long name" } }), /string value/);
  setPluginSettings([{ ...manifest, id: "valid" }], { valid: { "font.family": "Menlo" } });
  assert.equal(value("valid.font.family"), "Menlo");
});
