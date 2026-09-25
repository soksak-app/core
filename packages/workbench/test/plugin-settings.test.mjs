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

test("address plugin settings accept an empty or http address and reject another value", () => {
  const manifest = { id: "web", settings: { home: { label: "홈 주소", type: "address", default: "" } } };
  assert.throws(() => setPluginSettings([manifest], { web: { home: "file:///etc" } }), /address value/);
  assert.throws(() => setPluginSettings([{ ...manifest, id: "web2" }], { web2: { home: `https://a.test/${"x".repeat(2048)}` } }), /address value/);
  setPluginSettings([{ ...manifest, id: "web3" }], { web3: { home: "https://example.test/" } });
  assert.equal(value("web3.home"), "https://example.test/");
  setPluginSettings([{ ...manifest, id: "web4" }], {});
  assert.equal(value("web4.home"), "");
});
