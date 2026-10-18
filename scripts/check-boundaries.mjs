// Checks that core packages do not name plugins or sidecars in code.
//
// Components are connected only by declaration files. Plugins and sidecars live in their own repositories
// (docs/spec/plugins.md#repositories), and their names are read from the package.json and plugin.json of the folders that scripts/workspace-registry.json
// declares. References between core packages are not checked here. Each plugin and sidecar repository checks its own sources.
// Applications (apps/) and window checks (e2e/) own the combination, so they are not checked.
// Declaration files (package.json, plugin.json, sidecar.json) and documents (.md) are not checked either.
//
//   node scripts/check-boundaries.mjs [core checkout]
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { checkDeclaration, gitCommonDir, repositoryFolder } from "./workspace-registry.mjs";

const ROOT = resolve(process.argv[2] ?? new URL("../", import.meta.url).pathname);
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "target", "frontend", "bin", "gen"]);
const SKIP_FILES = new Set(["package.json", "plugin.json", "sidecar.json"]);
const SOURCE = /\.(js|mjs|html|css|json|go|rs|m|h|toml)$/;

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const listDirs = (path) => existsSync(path)
  ? readdirSync(path).map((name) => join(path, name)).filter((dir) => existsSync(join(dir, "package.json")))
  : [];

/** A component. kind is one of core, plugin, and sidecar. Only the core of this checkout has sources that are read. */
function components() {
  const found = [];
  const add = (dir, kind) => {
    const pkg = readJson(join(dir, "package.json"));
    const allowed = new Set([pkg.name, ...Object.keys({
      ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies,
    })]);
    const manifest = existsSync(join(dir, "plugin.json")) ? readJson(join(dir, "plugin.json")) : null;
    found.push({ dir, kind, name: pkg.name, allowed, pluginId: manifest?.id ?? null });
  };
  for (const dir of listDirs(join(ROOT, "packages"))) add(dir, "core");
  for (const dir of listDirs(join(ROOT, "packages/host"))) add(dir, "core");
  const declaration = checkDeclaration(readJson(join(ROOT, "scripts/workspace-registry.json")));
  const commonDir = gitCommonDir(ROOT);
  for (const folder of declaration.plugins) add(repositoryFolder(folder, commonDir), "plugin");
  for (const { repository, folder } of declaration.sidecars) {
    add(join(repositoryFolder(repository, commonDir), folder), "sidecar");
  }
  return found;
}

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (!SKIP_DIRS.has(name)) yield* files(path);
    } else if (SOURCE.test(name) && !SKIP_FILES.has(name)) {
      yield path;
    }
  }
}

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

const all = components();
const errors = [];
for (const component of all.filter((item) => item.kind === "core")) {
  // Finds the package.json names of plugins and sidecars and the plugin ids written in quotes, attribute values and
  // section prefixes.
  const rules = [];
  for (const other of all) {
    if (other === component || component.allowed.has(other.name) || other.kind === "core") continue;
    rules.push({ what: `package ${other.name}`, pattern: new RegExp(`(^|[^\\w@/-])${escape(other.name)}($|[^\\w/-])`) });
    if (other.pluginId) {
      const id = escape(other.pluginId);
      rules.push({
        what: `plugin id ${other.pluginId}`,
        pattern: new RegExp(`["'\`=]${id}(["'\`\\]:]|\\.[a-z])`),
      });
    }
  }
  for (const path of files(component.dir)) {
    const lines = readFileSync(path, "utf8").split("\n");
    lines.forEach((line, index) => {
      for (const rule of rules) {
        if (rule.pattern.test(line)) {
          errors.push(`${relative(ROOT, path)}:${index + 1}: ${component.kind} ${component.name} names ${rule.what}`);
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
