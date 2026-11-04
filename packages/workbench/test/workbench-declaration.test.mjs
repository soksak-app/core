// The workbench declaration file workbench.json holds the theme catalog, the fonts, the menu languages, the setting definitions and the
// chrome metrics, and the modules and the stylesheets of the workbench read them from it (docs/spec/settings.md#values,
// docs/spec/text-size.md, docs/spec/projects.md#persistence).
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";

const read = (name) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
/** The declaration file, read by each test so that a missing file fails the tests that need it. */
const declared = () => JSON.parse(read("workbench.json"));

/** The stylesheets of the workbench: its CSS files and the style elements of its HTML documents. */
function stylesheets() {
  const out = [];
  for (const name of ["app.css", "library.css"]) out.push({ name, text: read(name) });
  for (const name of ["index.html", "overlay.html"]) {
    for (const [at, match] of [...read(name).matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].entries()) {
      out.push({ name: `${name} style ${at + 1}`, text: match[1] });
    }
  }
  return out;
}

/** The text of a stylesheet without its comments and string values. */
const plain = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');

/** The math functions of CSS: a unitless number that multiplies or divides inside one of them is a ratio. */
const MATH = new Set(["calc", "round", "min", "max", "clamp"]);

/** The name of the innermost function whose parenthesis is open at index of text, or "" outside every function. */
function enclosing(text, index) {
  const open = [];
  for (const match of text.slice(0, index).matchAll(/([\w-]*)\(|\)/g)) {
    if (match[0] === ")") open.pop();
    else open.push(match[1]);
  }
  return open.at(-1) ?? "";
}

/**
 * The literal lengths, ratios and durations of a declaration value. A length is a dimension of a length unit or a percentage; a duration is
 * a dimension of a time unit; a ratio is a unitless number that is not an integer, a unitless number that multiplies or divides inside a
 * math function, or a unitless number of opacity, line-height, stroke-width (a length in the units of SVG) or a custom property. Zero is not
 * a metric. An integer elsewhere (z-index, order, font-weight, a grid line, a flex factor, a repeat count, an fr share) is a count, an
 * order or a weight, and an angle is not a length, a ratio or a duration.
 */
function literals(property, value) {
  const found = [];
  const text = value.replace(/#[0-9a-fA-F]{3,8}\b/g, "");
  for (const match of text.matchAll(/(?<![\w.#-])-?(\d+\.?\d*|\.\d+)([a-zA-Z%]*)/g)) {
    const [whole, number, unit] = match;
    if (Number(number) === 0) continue;
    if (/^(deg|grad|rad|turn|fr)$/.test(unit)) continue;
    if (unit) { found.push(whole); continue; }
    if (!Number.isInteger(Number(number))) { found.push(whole); continue; }
    const before = text.slice(0, match.index).replace(/\s+$/, "");
    const after = text.slice(match.index + whole.length).replace(/^\s+/, "");
    if (MATH.has(enclosing(text, match.index)) && (/[*/]$/.test(before) || /^[*/]/.test(after))) { found.push(whole); continue; }
    if (["opacity", "line-height", "stroke-width"].includes(property) || property.startsWith("--")) found.push(whole);
  }
  return found;
}

/** The literal metrics of a stylesheet, as `<selector or at-rule> { <property>: <value> }` lines. */
function metricLiterals(css) {
  const out = [];
  const text = plain(css);
  for (const prelude of text.matchAll(/@(?:media|supports|container)\s*([^{]*)\{/g)) {
    for (const condition of prelude[1].matchAll(/\(\s*([\w-]+)\s*:\s*([^)]+)\)/g)) {
      if (literals(condition[1], condition[2]).length) out.push(`@media (${condition[1]}: ${condition[2].trim()})`);
    }
  }
  for (const rule of text.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    for (const declared of rule[2].split(";")) {
      const at = declared.indexOf(":");
      if (at < 0) continue;
      const property = declared.slice(0, at).trim();
      const value = declared.slice(at + 1).trim();
      if (!/^-?-?[a-zA-Z][\w-]*$/.test(property)) continue;
      if (literals(property, value).length) out.push(`${rule[1].trim()} { ${property}: ${value} }`);
    }
  }
  return out;
}

test("the stylesheet check finds each kind of literal metric and passes the counts, orders, weights and angles", () => {
  assert.deepEqual(metricLiterals(".a{width:6px;opacity:.5;transition:color .12s;flex:0 0 1em;--t:1}"),
    [".a { width: 6px }", ".a { opacity: .5 }", ".a { transition: color .12s }", ".a { flex: 0 0 1em }", ".a { --t: 1 }"]);
  assert.deepEqual(metricLiterals(".a{height:calc(var(--size) * 20 / 13);color:color-mix(in srgb,var(--fg) 7%,transparent)}"),
    [".a { height: calc(var(--size) * 20 / 13) }", ".a { color: color-mix(in srgb,var(--fg) 7%,transparent) }"]);
  assert.deepEqual(metricLiterals("@media(max-width:780px){.a{flex:1}}"), ["@media (max-width: 780px)"]);
  assert.deepEqual(metricLiterals(".a{z-index:40;order:-1;font-weight:600;grid-row:2 / -1;flex:1 1 auto;margin:0;transform:rotate(-90deg);" +
    "grid-template-columns:repeat(3,var(--w)) 1fr;width:var(--fill);color:#16181D}"), []);
});

test("no stylesheet of the workbench holds a literal length, ratio or duration", () => {
  const found = stylesheets().flatMap(({ name, text }) => metricLiterals(text).map((line) => `${name}: ${line}`));
  assert.deepEqual(found, [], `literal metrics:\n${found.join("\n")}`);
});

test("every chrome metric is a CSS value that a stylesheet or a module of the workbench reads, and every metric that a stylesheet reads is declared", () => {
  const declaration = declared();
  const sheets = stylesheets().map(({ text }) => plain(text)).join("\n");
  // A media condition cannot read a custom property, so a module reads such a metric from the declaration (chrome-metrics.js).
  const modules = readdirSync(new URL("..", import.meta.url)).filter((name) => name.endsWith(".js")).map(read).join("\n");
  const declaredHere = new Set([...sheets.matchAll(/(--[\w-]+)\s*:/g)].map((match) => match[1]));
  const set = new Set(Object.keys(declaration.chrome).map((name) => `--${name}`));
  for (const [name, value] of Object.entries(declaration.chrome)) {
    assert.match(name, /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/, `chrome metric ${name} is not a custom property name`);
    assert.equal(typeof value, "string", `chrome metric ${name} is not a CSS value`);
    assert.ok(sheets.includes(`var(--${name})`) || modules.includes(`CHROME["${name}"]`), `nothing reads the chrome metric ${name}`);
    assert.ok(!declaredHere.has(`--${name}`), `a stylesheet declares the chrome metric ${name} again`);
  }
  // The other custom properties that the stylesheets read: the theme tokens of the settings, the values of the page and the ones the stylesheets declare.
  const themeTokens = ["--bg", "--card", "--fg", "--muted", "--edge", "--rule", "--rail", "--focus", "--no", "--r", "--half-gap", "--bw", "--font", "--size"];
  const page = ["--controls-w", "--pl", "--pr", "--pt", "--pb", "--depth", "--text-zoom", "--section-height",
    "--preview-ink", "--font-mono"];
  const unknown = [...new Set([...sheets.matchAll(/var\(\s*(--[\w-]+)/g)].map((match) => match[1]))]
    .filter((name) => !set.has(name) && !declaredHere.has(name) && !themeTokens.includes(name) && !page.includes(name));
  assert.deepEqual(unknown, [], `the stylesheets read custom properties that nothing declares: ${unknown.join(", ")}`);
});

// Both workbenches read the layout values of the plane: the head and the foot of a card, which also bound the drop zones, and the widths at
// which the tab strip folds (docs/spec/settings.md#values). A value in the code of each workbench would be a second copy.
test("the layout values that the plane reads are chrome metrics of workbench.json", () => {
  const { chrome } = declared();
  const layout = ["head-h", "foot-h", "tab-peek-w", "tab-min-w"];
  assert.deepEqual(layout.filter((name) => !(name in chrome)), [], "missing chrome metrics");
  for (const name of layout) assert.match(chrome[name], /^\d+px$/, name);
});

test("the workbench sets the chrome metrics as custom properties of the document root", async () => {
  const declaration = declared();
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  try {
    const { installChromeMetrics } = await import("../chrome-metrics.js");
    installChromeMetrics(dom.window.document.documentElement);
    const style = dom.window.document.documentElement.style;
    for (const [name, value] of Object.entries(declaration.chrome)) {
      assert.equal(style.getPropertyValue(`--${name}`), value, `--${name}`);
    }
  } finally { dom.window.close(); }
});

test("settings.js and text-size.js take the values of workbench.json instead of defining them", async () => {
  const settings = await import("../settings.js");
  const { TEXT_STEPS } = await import("../text-size.js");
  const { default: imported } = await import("../workbench.json", { with: { type: "json" } });
  // A JSON module is one object, so identity shows that the module reads the declaration and holds no copy of its own.
  assert.equal(settings.THEMES, imported.themes);
  assert.equal(settings.MODES, imported.modes);
  assert.equal(settings.FONTS, imported.fonts);
  assert.equal(settings.MENU_LANGUAGES, imported.menuLanguages);
  assert.equal(settings.LAYOUT_RANGES, imported.settings.layoutRanges);
  assert.equal(settings.SHAPE_RANGES, imported.settings.shapeRanges);
  assert.equal(settings.MEMORY_SAVER_DELAY, imported.settings.memorySaverDelay);
  assert.equal(settings.COMMON_ONLY, imported.settings.commonOnly);
  assert.equal(TEXT_STEPS, imported.settings.textSteps);
  assert.deepEqual(imported, declared());
  const { gap, radius, font, size, ...stated } = settings.defaults;
  const shape = imported.themes.find((theme) => theme.name === imported.settings.defaults.theme).shape;
  // The four shape settings start at the shape of the default theme.
  assert.deepEqual({ gap, radius, font, size }, { gap: parseFloat(shape.gap), radius: parseFloat(shape.r), font: shape.font, size: parseFloat(shape.size) });
  assert.deepEqual(stated, imported.settings.defaults);
  for (const [key, choices] of Object.entries(imported.settings.choices)) assert.equal(settings.CHOICES[key], choices, key);
  assert.deepEqual(settings.CHOICES.textSize, imported.settings.textSteps);
  assert.deepEqual(settings.CHOICES.language, ["auto", ...imported.menuLanguages.map((language) => language.id)]);
});

test("the declaration states each setting of the defaults once, with a choice list, a range or a switch where the setting has one", () => {
  const declaration = declared();
  const { settings } = declaration;
  const keys = new Set(Object.keys(settings.defaults));
  for (const key of [...Object.keys(settings.choices), ...Object.keys(settings.layoutRanges), ...Object.keys(settings.shapeRanges),
    ...settings.switches, ...settings.commonOnly, "memorySaverDelay"]) {
    assert.ok(keys.has(key) || ["gap", "radius", "font", "size"].includes(key), `${key} has no default`);
  }
  assert.deepEqual(settings.commonOnly, ["projectOpening", "textSize", "memorySaver", "memorySaverDelay"]);
  assert.ok(declaration.menuLanguages.some((language) => language.id === declaration.defaultLanguage));
});
