import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const pkg = JSON.parse(read("package.json"));

test("every exported path exists in the build", () => {
  for (const path of [pkg.main, pkg.module, pkg.types]) {
    assert.equal(existsSync(new URL(`../${path}`, import.meta.url)), true, path);
  }
  for (const [name, entry] of Object.entries(pkg.exports)) {
    for (const path of Object.values(entry)) {
      assert.equal(existsSync(new URL(`../${path}`, import.meta.url)), true, `${name} -> ${path}`);
    }
  }
});

test("the toolchain owners are exact", () => {
  const nodeVersion = read(".node-version").trim();
  assert.equal(pkg.engines.node, nodeVersion);
  assert.match(pkg.packageManager, /^pnpm@\d+[.]\d+[.]\d+$/);
  assert.equal(pkg.type, "module");
  const makefile = read("Makefile");
  for (const target of ["preflight", "prepare", "build", "verify"]) {
    assert.match(makefile, new RegExp(`^${target}:`, "m"));
  }
});

test("the soksak core carries no DOM dependency", () => {
  for (const file of ["src/soksak.ts", "src/outline.ts"]) {
    const source = read(file);
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
