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

test("the toolchain owners are exact", () => {
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

test("the soksak core carries no DOM dependency", () => {
  for (const file of ["src/card.ts", "src/geometry.ts", "src/slicing.ts", "src/soksak.ts", "src/outline.ts"]) {
    const source = codeOf(file);
    assert.doesNotMatch(source, /\bdocument\b/, `${file} touches document`);
    assert.doesNotMatch(source, /\bwindow\b/, `${file} touches window`);
    assert.doesNotMatch(source, /HTMLElement/, `${file} names an element type`);
  }
});

test("the view creates no markup of its own beyond what input needs", () => {
  const source = read("src/dom.ts");
  const created = [...source.matchAll(/createElement\(['"](\w+)['"]\)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(created)], ["div"], "only bare divs, so the host owns the markup");
  assert.doesNotMatch(source, /innerHTML/, "the view never writes markup");
  assert.doesNotMatch(source, /style\.(background|border|color|font)/, "the view never styles");
});

test("the README documents the exported surface", () => {
  const readme = read("README.md");
  for (const name of ["Soksak", "SoksakView", "outline"]) {
    assert.match(readme, new RegExp(name), name);
  }
});
