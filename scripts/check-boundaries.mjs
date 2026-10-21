// Checks that core packages do not name plugins or sidecars in code.
//
// Components are connected only by declaration files. Plugins and sidecars live in their own repositories
// (docs/spec/plugins.md#repositories), and their names are read from the package.json and plugin.json of the folders that scripts/workspace-registry.json
// declares. A core source names only core packages: every `@soksak/` name whose base is not exactly a core package name
// fails, whether it is declared or not (decision D3, rule 1). Other scopes are not checked.
// Declaration files (package.json, plugin.json, sidecar.json) and documents (.md) are not checked either.
// Each plugin and sidecar repository checks its own sources.
//
//   node scripts/check-boundaries.mjs [core checkout]
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { checkDeclaration, gitCommonDir, repositoryFolder } from "./workspace-registry.mjs";

const ROOT = resolve(process.argv[2] ?? new URL("../", import.meta.url).pathname);
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "target", "frontend", "bin", "gen"]);
const SKIP_FILES = new Set(["package.json", "plugin.json", "sidecar.json"]);
const SOURCE = /\.(js|mjs|cjs|ts|tsx|html|css|json|go|rs|m|h|toml)$/;
// The base of an @soksak/ name: the scope and the first segment. A subpath is not part of the base.
const SOKSAK_NAME = /@soksak\/[a-z0-9][a-z0-9-]*/g;
// The import-map prefix that core serves to view pages (`sok://core/shared/`, docs/spec/plugins.md). It is a core name
// without a package.json.
const CORE_SERVED = ["@soksak/shared"];

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const listDirs = (path) => existsSync(path)
  ? readdirSync(path).map((name) => join(path, name)).filter((dir) => existsSync(join(dir, "package.json")))
  : [];

/** A component. kind is one of core, plugin, and sidecar. Only the core of this checkout has sources that are read. */
export function components(root = ROOT) {
  const found = [];
  const add = (dir, kind) => {
    const pkg = readJson(join(dir, "package.json"));
    const allowed = new Set([pkg.name, ...Object.keys({
      ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies,
    })]);
    const manifest = existsSync(join(dir, "plugin.json")) ? readJson(join(dir, "plugin.json")) : null;
    found.push({ dir, kind, name: pkg.name, allowed, pluginId: manifest?.id ?? null });
  };
  for (const dir of listDirs(join(root, "packages"))) add(dir, "core");
  for (const dir of listDirs(join(root, "packages/host"))) add(dir, "core");
  const declaration = checkDeclaration(readJson(join(root, "scripts/workspace-registry.json")));
  const commonDir = gitCommonDir(root);
  for (const folder of declaration.plugins) add(repositoryFolder(folder, commonDir), "plugin");
  for (const { repository, folder } of declaration.sidecars) {
    add(join(repositoryFolder(repository, commonDir), folder), "sidecar");
  }
  return found;
}

/**
 * Checks the @soksak/ names of the given files. A name is allowed only when its base is an exact core package name
 * (a Set of names, see corePackageNames). readSource reads a file by its path relative to the checkout.
 */
export function checkNames(core, files, readSource = (file) => readFileSync(join(ROOT, file), "utf8")) {
  const errors = [];
  for (const file of files) {
    let source;
    try { source = readSource(file); }
    catch (error) {
      errors.push(`${file}: cannot be read: ${error?.message ?? error}`);
      continue;
    }
    source.split("\n").forEach((line, index) => {
      for (const match of line.matchAll(SOKSAK_NAME)) {
        if (!core.has(match[0])) {
          errors.push(`${file}:${index + 1}: core source names ${match[0]}, which is not a core package`);
        }
      }
    });
  }
  return errors;
}

/**
 * The names of the core packages: the name of every package.json tracked in the core checkout, except the
 * declarations of the registry folders, which are not in the checkout. Test packages and applications of the checkout
 * are core packages too (for example @soksak/runtime, the workbench test runtime, and @soksak/e2e).
 */
export function corePackageNames(root = ROOT) {
  const names = [];
  for (const file of execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0")) {
    if (!/(^|\/)package\.json$/.test(file)) continue;
    const name = readJson(join(root, file)).name;
    if (typeof name === "string") names.push(name);
  }
  return [...names, ...CORE_SERVED];
}

/** The tracked source files of the checkout that the boundary rule covers. */
function trackedSources(root) {
  return execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] })
    .split("\0")
    .filter((file) => file !== "")
    .filter((file) => SOURCE.test(file) && !SKIP_FILES.has(file.split("/").pop()))
    .filter((file) => !file.split("/").some((segment) => SKIP_DIRS.has(segment)));
}

function main() {
  const all = components(ROOT);
  const errors = checkNames(new Set(corePackageNames(ROOT)), trackedSources(ROOT), (file) => readFileSync(join(ROOT, file), "utf8"));
  for (const component of all.filter((item) => item.kind === "core")) {
    // Finds the plugin ids written in quotes, attribute values and section prefixes in core sources.
    const rules = [];
    for (const other of all) {
      if (other === component || component.allowed.has(other.name) || other.kind === "core") continue;
      if (other.pluginId) {
        const id = other.pluginId.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
        rules.push({
          what: `plugin id ${other.pluginId}`,
          pattern: new RegExp(`["'\`=]${id}(["'\`\\]:]|\\.[a-z])`),
        });
      }
    }
    if (!rules.length) continue;
    for (const file of trackedSources(component.dir)) {
      const lines = readFileSync(join(component.dir, file), "utf8").split("\n");
      lines.forEach((line, index) => {
        for (const rule of rules) {
          if (rule.pattern.test(line)) {
            errors.push(`${relative(ROOT, join(component.dir, file))}:${index + 1}: ${component.kind} ${component.name} names ${rule.what}`);
          }
        }
      });
    }
  }
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else {
    console.log(`Boundary checks passed: ${all.length} components`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
