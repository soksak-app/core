// The ok and warn tokens of every theme and mode take the values that the design gives (docs/spec/settings.md#theme): dark ok #4cc38a
// and warn #f0a33a, light ok #17784c and warn #9e5000. The settings set them on the root with the other color tokens, and the style
// sheet holds the light values for a document that is opened alone.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const catalog = JSON.parse(readFileSync(new URL("../workbench.json", import.meta.url), "utf8"));
const design = {
  dark: { ok: "#4cc38a", warn: "#f0a33a" },
  light: { ok: "#17784c", warn: "#9e5000" },
};

test("every theme declares the ok and warn tokens of each mode with the design values", () => {
  for (const theme of catalog.themes) for (const mode of ["dark", "light"]) for (const token of ["ok", "warn"]) {
    assert.equal(theme[mode][token], design[mode][token], `${theme.name} ${mode} ${token}`);
  }
});

test("the style sheet holds the light values of the ok and warn tokens", () => {
  const css = readFileSync(new URL("../app.css", import.meta.url), "utf8").replace(/\s+/g, "");
  assert.ok(css.includes(`:root[data-mode=light]{--ok:${design.light.ok};--warn:${design.light.warn}}`), "the light override of --ok and --warn is missing from app.css");
});

test("the settings set the ok and warn tokens of the current mode on the root", () => {
  const source = readFileSync(new URL("../settings.js", import.meta.url), "utf8");
  assert.match(source, /"--ok": c\.ok, "--warn": c\.warn/);
});
