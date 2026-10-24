// Checks that core package sources and package tests do not name plugins or sidecars in code.
//
// Components are connected only by declaration files. Plugins and sidecars live in their own repositories
// (docs/spec/plugins.md#repositories), and their names are read from the package.json and plugin.json of the folders that scripts/workspace-registry.json
// declares. Every `@soksak/` name whose base is not exactly a core package name fails, whether it is declared or not
// (decision D3, rule 1), except a declared end-to-end window check, which tests the application's installed cohort.
// Other scopes are not checked.
// Declaration files (package.json, plugin.json, sidecar.json) and documents (.md) are not checked either.
// Each plugin and sidecar repository checks its own sources.
//
//   node scripts/check-boundaries.mjs [core checkout]
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, posix, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "acorn";
import { checkDeclaration, gitCommonDir, repositoryFolder } from "./workspace-registry.mjs";

const ROOT = resolve(process.argv[2] ?? new URL("../", import.meta.url).pathname);
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "target", "frontend", "bin", "gen"]);
const SKIP_FILES = new Set(["package.json", "plugin.json", "sidecar.json"]);
const SOURCE = /\.(js|mjs|cjs|ts|tsx|html|css|json|go|rs|m|h|toml)$/;
// The base of an @soksak/ name: the scope and the first segment. A subpath is not part of the base.
const SOKSAK_NAME = /@soksak\/[a-z0-9][a-z0-9-]*/g;
// The import-map prefix that core serves to view pages (`soksak://core/shared/`, docs/spec/plugins.md). It is a core name
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
 * (a Set of names, see corePackageNames), or the file is a declared window check. readSource reads a relative path.
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
    if (isDeclaredWindowCheck(file, source)) continue;
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

/** A window check uses the declared application endpoint instead of testing a package in isolation. */
function isDeclaredWindowCheck(file, source) {
  if (!file.startsWith("e2e/") || !file.endsWith(".test.mjs")) return false;
  const program = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  const openBindings = new Set();
  for (const statement of program.body) {
    if (statement.type !== "ImportDeclaration" || statement.source.value !== "@soksak/window-check/app.mjs") continue;
    for (const specifier of statement.specifiers) {
      const imported = specifier.type === "ImportSpecifier"
        ? (specifier.imported.name ?? specifier.imported.value)
        : null;
      if (imported === "open") openBindings.add(specifier.local.name);
    }
  }
  if (openBindings.size === 0) return false;

  let shadowed = false;
  const declarePattern = (pattern) => {
    if (!pattern || shadowed) return;
    if (pattern.type === "Identifier") shadowed ||= openBindings.has(pattern.name);
    else if (pattern.type === "RestElement") declarePattern(pattern.argument);
    else if (pattern.type === "AssignmentPattern") declarePattern(pattern.left);
    else if (pattern.type === "ArrayPattern") pattern.elements.forEach(declarePattern);
    else if (pattern.type === "ObjectPattern") pattern.properties.forEach((property) =>
      declarePattern(property.type === "RestElement" ? property.argument : property.value));
  };
  const checkBindings = (node) => {
    if (!node || shadowed) return;
    if (node.type === "VariableDeclarator") declarePattern(node.id);
    if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression") {
      declarePattern(node.id);
      node.params.forEach(declarePattern);
    }
    if (node.type === "ClassDeclaration" || node.type === "ClassExpression") declarePattern(node.id);
    if (node.type === "CatchClause") declarePattern(node.param);
    if (node.type === "ImportDeclaration") {
      for (const specifier of node.specifiers) {
        const imported = specifier.type === "ImportSpecifier"
          ? (specifier.imported.name ?? specifier.imported.value)
          : null;
        if (!(node.source.value === "@soksak/window-check/app.mjs" && imported === "open")) {
          declarePattern(specifier.local);
        }
      }
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(checkBindings);
      else if (value && typeof value.type === "string") checkBindings(value);
    }
  };
  checkBindings(program);
  if (shadowed) return false;

  const pending = [program];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node.type === "CallExpression" && node.callee.type === "Identifier" && openBindings.has(node.callee.name)) return true;
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) pending.push(...value.filter((child) => child && typeof child.type === "string"));
      else if (value && typeof value.type === "string") pending.push(value);
    }
  }
  return false;
}

/** The tracked source files of the checkout that the boundary rule covers. */
function trackedSources(root) {
  return execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] })
    .split("\0")
    .filter((file) => file !== "")
    .filter((file) => SOURCE.test(file) && !SKIP_FILES.has(file.split("/").pop()))
    .filter((file) => !file.split("/").some((segment) => SKIP_DIRS.has(segment)));
}

// The folders of the core packages that tests belong to: a folder under packages/ or packages/<group>/ with a package.json,
// go.mod or Cargo.toml. The Go and Rust packages of sok and the host have no package.json.
const PACKAGE_MARKERS = ["package.json", "go.mod", "Cargo.toml"];
export function corePackageFolders(root = ROOT) {
  const folders = [];
  const isPackage = (dir) => PACKAGE_MARKERS.some((marker) => existsSync(join(dir, marker)));
  const subdirs = (dir) => existsSync(dir)
    ? readdirSync(dir).map((name) => join(dir, name)).filter((path) => statSync(path).isDirectory())
    : [];
  for (const dir of subdirs(join(root, "packages"))) {
    if (isPackage(dir)) folders.push({ dir: relative(root, dir), kind: "core", name: relative(root, dir) });
    for (const inner of subdirs(dir)) {
      if (isPackage(inner)) folders.push({ dir: relative(root, inner), kind: "core", name: relative(root, inner) });
    }
  }
  return folders;
}

// A line that reads a file or names a path to open: a file-access call, a URL or module path, or a process. A string that a
// test passes as data (the key of a fake source, a value) is not a read, so a literal that is not a relative path counts only on such a line.
const FILE_ACCESS = /readFile|readdir|read_to_string|File::open|fs::|new URL\(|import\(|\bopen\(|[Jj]oin\(|Abs\(|Command::new|exec\.|spawn|require\(|\bfrom\s+['"]/;

// The test files: a file under a test folder, or named as a Go, Rust or Node test.
const TEST_FILE = /(^|\/)tests?\/|_test\.(go|rs)$|\.test\.mjs$/;

// A string literal of a test source: double, single or back quoted, or a Rust raw string.
const LITERAL = /"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`([^`\n]*)`|r#"([^"\n]*)"#/g;

/** The core package whose folder holds the file, the innermost one. */
function owningComponent(cores, file) {
  return cores
    .filter((item) => file.startsWith(`${item.dir}/`))
    .sort((a, b) => b.dir.length - a.dir.length)[0] ?? null;
}

/**
 * The core package that a string of a test reads a path of, or null. A relative path is resolved from the folder of the
 * test file and from the folder of its package (cargo runs a Rust test in its package folder); a path that starts with
 * `packages/` is resolved from the checkout.
 */
function readsOtherPackage(text, file, owner, cores) {
  if (text.includes("@") || text.startsWith("/modules/")) return null;
  const path = text.replace(/^file:\/\//, "");
  const segments = path.split("/");
  const parent = segments.indexOf("..");
  if (parent < 0 && segments[0] !== "packages") return null;
  const bases = segments[0] === "packages" ? [""] : [posix.dirname(file), owner.dir];
  const rest = segments[0] === "packages" ? path : segments.slice(parent).join("/");
  for (const base of bases) {
    const target = owningComponent(cores, `${posix.normalize(posix.join(base, rest))}/`);
    if (target && target !== owner) return target.name;
  }
  return null;
}

/**
 * The core package that a Go or Rust join of the line reads, or null. The string literals of the line after its first `..`
 * are the path segments of the join, resolved from the folder of the test file, which is the folder that `filepath.Dir` of
 * the test names in the Go tests.
 */
function joinReadsOtherPackage(line, file, owner, cores) {
  const literals = [...line.matchAll(LITERAL)].map((match) => match[1] ?? match[2] ?? match[3] ?? match[4] ?? "");
  const parent = literals.indexOf("..");
  if (parent < 0) return null;
  const parts = literals.slice(parent).filter((text) => !text.includes("/"));
  const target = owningComponent(cores, `${posix.normalize(posix.join(posix.dirname(file), ...parts))}/`);
  return target && target !== owner ? target.name : null;
}

/**
 * Checks that a test of a core package does not read a path of another core package (docs/spec/host-contract.md, AGENTS
 * structure rule: tests use their own package, the shared contract cases of docs/spec, and fakes). `files` are the test
 * files of the checkout; readSource reads a file by its path relative to the checkout.
 */
export function checkTestPathReads(components, files, readSource = (file) => readFileSync(join(ROOT, file), "utf8")) {
  const cores = components.filter((item) => item.kind === "core");
  const errors = [];
  for (const file of files) {
    const owner = owningComponent(cores, file);
    if (!owner) continue;
    let source;
    try { source = readSource(file); }
    catch (error) {
      errors.push(`${file}: cannot be read: ${error?.message ?? error}`);
      continue;
    }
    const sourceLines = source.split("\n");
    sourceLines.forEach((line, index) => {
      const accessLine = FILE_ACCESS.test(line) || FILE_ACCESS.test(sourceLines[index - 1] ?? "");
      for (const match of line.matchAll(LITERAL)) {
        const text = match[1] ?? match[2] ?? match[3] ?? match[4] ?? "";
        // A relative path (`../`) is a read wherever a test keeps it, such as a Rust constant; another literal is a read on a line that opens files.
        if (!text.includes("../") && !accessLine) continue;
        const target = readsOtherPackage(text, file, owner, cores);
        if (target) errors.push(`${file}:${index + 1}: test of ${owner.name} reads a path of ${target}: ${text}`);
      }
      const joined = joinReadsOtherPackage(line, file, owner, cores);
      if (joined) errors.push(`${file}:${index + 1}: test of ${owner.name} reads a path of ${joined}: ${line.trim()}`);
    });
  }
  return errors;
}

function main() {
  const all = components(ROOT);
  const errors = checkNames(new Set(corePackageNames(ROOT)), trackedSources(ROOT), (file) => readFileSync(join(ROOT, file), "utf8"));
  errors.push(...checkTestPathReads(corePackageFolders(ROOT), trackedSources(ROOT).filter((file) => TEST_FILE.test(file))));
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
