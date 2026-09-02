import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const pkg = JSON.parse(read("package.json"));

test("every exported path exists in the build", () => {
  for (const path of [pkg.main, pkg.module, pkg.types]) {
    assert.equal(existsSync(new URL(`../${path}`, import.meta.url)), true, path);
  }
  // An entry is either a path or a map of conditions to paths, and a condition
  // may itself be a map. Walk to the strings.
  const paths = (entry) =>
    typeof entry === "string" ? [entry] : Object.values(entry).flatMap(paths);
  for (const [name, entry] of Object.entries(pkg.exports)) {
    for (const path of paths(entry)) {
      assert.equal(existsSync(new URL(`../${path}`, import.meta.url)), true, `${name} -> ${path}`);
    }
  }
});

test("the package declares its toolchain", () => {
  // `.node-version` is the Node this is built on. `engines.node` is the Node a
  // consumer needs. Those are different questions, and pinning the second to
  // the first told everyone else to run the version I happen to have — an
  // install refused on Node 20 for a build that targets ES2019. What must hold
  // is only that what I build on satisfies what I advertise.
  const built = read(".node-version").trim();
  assert.match(pkg.engines.node, /^>=\d+/, "consumers are given a floor, not my version");
  const floor = Number(pkg.engines.node.slice(2).split(".")[0]);
  assert.ok(Number(built.split(".")[0]) >= floor, `built on ${built}, advertised ${pkg.engines.node}`);
  assert.match(pkg.packageManager, /^pnpm@\d+[.]\d+[.]\d+$/);
  assert.equal(pkg.type, "module");
  const makefile = read("Makefile");
  for (const target of ["preflight", "prepare", "build", "verify"]) {
    assert.match(makefile, new RegExp(`^${target}:`, "m"));
  }
});

/** Comments are not code — a card standing at a window's edge is prose about furniture. */
const codeOf = (file) =>
  read(file)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

test("the core imports no DOM API", () => {
  for (const file of ["src/card.ts", "src/geometry.ts", "src/slicing.ts", "src/soksak.ts", "src/outline.ts"]) {
    const source = codeOf(file);
    assert.doesNotMatch(source, /\bdocument\b/, `${file} touches document`);
    assert.doesNotMatch(source, /\bwindow\b/, `${file} touches window`);
    assert.doesNotMatch(source, /HTMLElement/, `${file} names an element type`);
  }
});

test("the view creates only div elements and writes no markup", () => {
  const source = read("src/dom.ts");
  const created = [...source.matchAll(/createElement\(['"](\w+)['"]\)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(created)], ["div"], "only bare divs, so the host owns the markup");
  assert.doesNotMatch(source, /innerHTML/, "the view never writes markup");
  assert.doesNotMatch(source, /style\.(background|border|color|font)/, "the view never styles");
});

test("every exported name appears in the README", async () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const lib = await import("../dist/index.js");
  for (const name of Object.keys(lib)) {
    assert.match(readme, new RegExp(`\\b${name}\\b`), `${name} is exported and undocumented`);
  }

  // And every public method of the two classes.
  const methods = (cls) =>
    Object.getOwnPropertyNames(cls.prototype).filter((n) => n !== "constructor" && !n.startsWith("_"));
  const declared = readFileSync(new URL("../dist/soksak.d.ts", import.meta.url), "utf8");
  for (const name of methods(lib.Soksak)) {
    if (!new RegExp(`^\\s{4}(get |set )?${name}[(<:]`, "m").test(declared)) continue;   // private
    assert.match(readme, new RegExp(`\\b${name}\\b`), `Soksak.${name} is public and undocumented`);
  }
});

test("the declaration files name a DOM lib for the view only", () => {
  const dts = (name) => readFileSync(new URL(`../dist/${name}`, import.meta.url), "utf8");
  // A consumer compiling without the DOM lib reads the public types. Only the
  // view needs one and declares it, so the core typechecks in a worker or on a
  // server.
  assert.match(dts("dom.d.ts"), /^\/\/\/ <reference lib="dom" \/>/, "dom.d.ts declares it");
  for (const name of ["soksak.d.ts", "geometry.d.ts", "outline.d.ts", "card.d.ts", "slicing.d.ts"]) {
    assert.doesNotMatch(dts(name), /HTMLElement|PointerEvent|ResizeObserver/, `${name} needs no DOM`);
  }
  const tsconfig = readFileSync(new URL("../tsconfig.json", import.meta.url), "utf8");
  assert.doesNotMatch(tsconfig, /"DOM"/, "the build proves the reference carries it");
});
