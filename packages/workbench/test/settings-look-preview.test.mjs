// The look preview of the Appearance page is drawn with the applied gap, radius, font and size, and with the seam when the gap is 0
// (docs/spec/settings.md#look). The two cards touch and share one line when the gap is 0.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startSettingsTab, openSettingsTab } from "./support/settings-tab-window.mjs";

const css = readFileSync(fileURLToPath(new URL("../settings.css", import.meta.url)), "utf8");

/** The declarations of the first rule whose selector is the given text. */
function declarationsOf(selector) {
  const start = css.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `no rule for ${selector}`);
  return css.slice(start, css.indexOf("}", start));
}

const ctx = await startSettingsTab(null, {
  project: null,
  setup: async () => ({ common: {}, projects: [] }),
});

test("the preview card takes the applied radius, font and font size", () => {
  const card = declarationsOf(".set-preview__card");
  assert.match(card, /border-radius:\s*var\(--r\)/, "the card radius is the applied radius");
  const body = declarationsOf(".set-preview__body");
  assert.match(body, /font-family:\s*var\(--font\)/, "the body font is the applied font");
  assert.match(body, /font-size:\s*var\(--size\)/, "the body size is the applied size");
});

test("the preview gap is the applied gap, and the cards share one line when it is 0", async () => {
  await openSettingsTab(ctx);
  await ctx.run("core.settings.change", { key: "gap", value: 0, scope: "common" });
  assert.equal(ctx.document.documentElement.dataset.seam, "line", "a zero gap sets the seam on the root");
  assert.match(declarationsOf(':root[data-seam="line"] .set-preview__card + .set-preview__card'), /margin-left/, "the seam overlaps the cards");
  await ctx.run("core.settings.change", { key: "gap", value: 12, scope: "common" });
  assert.equal(ctx.document.documentElement.dataset.seam, "gap", "a non-zero gap sets the gap seam on the root");
});
