import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { PACKAGE_PARTS, ROOT_PARTS } from "../scripts/workspace-copy.mjs";

const PACKAGE = fileURLToPath(new URL("../", import.meta.url));
const TOP = fileURLToPath(new URL("../../../", import.meta.url));
const modules = (path) => statSync(path).isDirectory()
  ? readdirSync(path).flatMap((name) => name === "node_modules" ? [] : modules(join(path, name)))
  : /\.m?js$/.test(path) ? [path] : [];

test("every file that a copied module imports from outside the package is a copied workspace part", () => {
  const missing = [];
  for (const file of PACKAGE_PARTS.flatMap((part) => modules(join(PACKAGE, part)))) {
    for (const [, specifier] of readFileSync(file, "utf8").matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)["'](\.{1,2}\/[^"']+)["']/g)) {
      const target = resolve(dirname(file), specifier);
      if (!relative(PACKAGE, target).startsWith("..")) continue;
      const path = relative(TOP, target);
      if (!ROOT_PARTS.some((part) => path === part || path.startsWith(`${part}/`))) missing.push(`${relative(PACKAGE, file)} imports ${path}`);
    }
  }
  assert.deepEqual(missing, []);
});
