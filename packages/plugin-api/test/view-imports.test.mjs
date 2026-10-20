// Checks that the modules of a view page import only what the view import map serves (docs/plans/plugin-processes.md, rule 4).
// The walk reads the files of this package and of fixture packages in a temporary folder.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { VIEW_IMPORTS } from "../index.js";

const PACKAGE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRIES = ["index.js", "view.js"];

/** The specifiers of the static and dynamic imports and the re-exports of a module, without comments. */
function specifiersOf(source) {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const found = [];
  const pattern = /\bfrom\s+["']([^"']+)["']|\bimport\s+["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of code.matchAll(pattern)) found.push(match[1] ?? match[2] ?? match[3]);
  return found;
}

/** Whether the view import map serves a bare specifier: an exact entry, or a prefix entry that ends with a slash. */
function servedByMap(specifier) {
  if (Object.hasOwn(VIEW_IMPORTS, specifier)) return true;
  return Object.keys(VIEW_IMPORTS).some((key) => key.endsWith("/") && specifier.startsWith(key));
}

/**
 * Walks the relative imports from the entries of a package and checks the bare imports against the view import map.
 * Each reached file must be listed in the files of the package, because the core root serves the reached files.
 * Returns {files, problems}: files is the sorted list of reached files, problems the list of refused imports.
 */
function walkViewImports(root, entries, listed) {
  const problems = [];
  const reached = new Set();
  const pending = [...entries];
  while (pending.length > 0) {
    const file = pending.shift();
    if (reached.has(file)) continue;
    reached.add(file);
    if (!listed.includes(file)) problems.push(`${file} is reached but is not in the files of the package`);
    const source = readFileSync(join(root, file), "utf8");
    for (const specifier of specifiersOf(source)) {
      if (specifier.startsWith("./") || specifier.startsWith("../")) {
        const target = relative(root, resolve(root, dirname(file), specifier)).split(sep).join("/");
        if (target.startsWith("..") || target === "") {
          problems.push(`${file} imports ${specifier}, which is outside the package`);
          continue;
        }
        try {
          if (!statSync(join(root, target)).isFile()) problems.push(`${file} imports ${specifier}, which is not a file`);
        } catch {
          problems.push(`${file} imports ${specifier}, which does not exist`);
          continue;
        }
        pending.push(target);
      } else if (!servedByMap(specifier)) {
        problems.push(`${file} imports ${specifier}, which the view import map does not serve`);
      }
    }
  }
  return { files: [...reached].sort(), problems };
}

test("the view import map has exactly the four entries of rule 4", () => {
  assert.deepEqual(VIEW_IMPORTS, {
    "soksak": "sok://core/modules/soksak/dist/index.js",
    "@soksak/plugin-api": "sok://core/modules/@soksak/plugin-api/index.js",
    "@soksak/plugin-api/view": "sok://core/modules/@soksak/plugin-api/view.js",
    "@soksak/shared/": "sok://core/shared/",
  });
  assert.equal(Object.isFrozen(VIEW_IMPORTS), true);
});

test("every import of index.js and view.js is served by the core targets or the view import map", () => {
  const listed = JSON.parse(readFileSync(join(PACKAGE, "package.json"), "utf8")).files;
  const { files, problems } = walkViewImports(PACKAGE, ENTRIES, listed);
  assert.deepEqual(problems, []);
  assert.ok(files.includes("view.js"));
  assert.ok(files.includes("calls.js"));
  assert.ok(files.includes("snapshots.js"));
});

test("view.js imports nothing under runtime/ and no workbench specifier", () => {
  const source = readFileSync(join(PACKAGE, "view.js"), "utf8");
  for (const specifier of specifiersOf(source)) {
    assert.doesNotMatch(specifier, /runtime\//);
    assert.doesNotMatch(specifier, /^@soksak\/workbench\//);
  }
});

test("the injected script view-start.js is a plain script with no import or export", () => {
  const source = readFileSync(join(PACKAGE, "view-start.js"), "utf8");
  assert.deepEqual(specifiersOf(source), []);
  assert.doesNotMatch(source, /^\s*export\s/m);
});

test("a fixture module that imports a bare specifier outside the map is refused", (t) => {
  const root = mkdtempSync(join(tmpdir(), "view-imports-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "index.js"), `import "@soksak/workbench/state.js";\n`);
  writeFileSync(join(root, "view.js"), `export {};\n`);
  const { problems } = walkViewImports(root, ENTRIES, ["index.js", "view.js"]);
  assert.deepEqual(problems, ["index.js imports @soksak/workbench/state.js, which the view import map does not serve"]);
});

test("a fixture module that imports a runtime path outside the package is refused", (t) => {
  const root = mkdtempSync(join(tmpdir(), "view-imports-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "pkg"));
  writeFileSync(join(root, "pkg", "index.js"), `export {};\n`);
  writeFileSync(join(root, "pkg", "view.js"), `import { run } from "../runtime/index.js";\nexport { run };\n`);
  const { problems } = walkViewImports(join(root, "pkg"), ENTRIES, ["index.js", "view.js"]);
  assert.deepEqual(problems, ["view.js imports ../runtime/index.js, which is outside the package"]);
});

test("a reached file that the package does not list is refused", (t) => {
  const root = mkdtempSync(join(tmpdir(), "view-imports-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "index.js"), `export {};\n`);
  writeFileSync(join(root, "view.js"), `import { x } from "./helper.js";\nexport { x };\n`);
  writeFileSync(join(root, "helper.js"), `export const x = 1;\n`);
  const { problems } = walkViewImports(root, ENTRIES, ["index.js", "view.js"]);
  assert.deepEqual(problems, ["helper.js is reached but is not in the files of the package"]);
});

test("a shared module import through the prefix of the view import map is served", () => {
  assert.equal(servedByMap("@soksak/shared/colors.js"), true);
  assert.equal(servedByMap("@soksak/plugin-api/page"), false);
  assert.equal(servedByMap("@soksak/runtime"), false);
});
