// Checks that core package sources and package tests do not name plugins or sidecars in code.
//
// Components are connected only by declaration files. Plugins and sidecars live in their own repositories
// (docs/spec/plugins.md#repositories), and the check knows none of them: it reads no other repository and runs in CI with the core
// checkout alone. A plugin that a core window check, benchmark or harness module names is core, the host or a fixture plugin of
// e2e/fixtures (checkPluginNames), and the gate of a core release names no registry index URL, no plugin repository and no registry
// other than the fixture registry (checkGateSources; docs/spec/plugin-processes.md#verification-boundaries). Every `@soksak/` name whose base is not exactly a core package name fails, whether it is declared or not
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
import { declaresFile, specFilesOf, workspacePackages } from "./node-tests.mjs";
import { fixturePluginIds, fixtureSources } from "./fixture-registry.mjs";

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
    const manifest = readJson(join(root, file));
    if (typeof manifest.name === "string") names.push(manifest.name);
    // A kit is a tool of the repositories, and its release is the one release of another repository that a manifest names
    // (docs/spec/plugins.md#repositories).
    names.push(...Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }).filter((name) => name === "@soksak/kit"));
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

// The owners of names that are no plugin: core and the host (`exposure.list` of docs/spec/exposure.md).
export const CORE_OWNERS = ["core", "host"];
const ID = "[a-z][a-z0-9-]*";
const QUOTE = "[\"'`]";
// The places where a check names a plugin: a plugin id (`plugin: "<id>"`, as `core.card.add-tab {plugin}` takes it, a comparison
// `plugin === "<id>"`, `sok plugin install|remove|update <id>`, and the settings keys `plugin:<id>` and `link:<place>:<id>`), and the
// namespace of a status, command, element, section or set `"<id>.<name>"` that a check passes to a call of the endpoint (`s.run`,
// `s.get`, `s.until`, `s.registered`, `watch`) or names as a section, set or element.
const PLUGIN_NAMINGS = [
  new RegExp(`\\bplugin\\s*:\\s*${QUOTE}(${ID})${QUOTE}`, "g"),
  new RegExp(`(?<!typeof\\s+[\\w$?.]*)\\bplugin\\s*[!=]==?\\s*${QUOTE}(${ID})${QUOTE}`, "g"),
  new RegExp(`${QUOTE}plugin:(${ID})${QUOTE}`, "g"),
  new RegExp(`\\blink:[a-z-]+:(${ID})${QUOTE}`, "g"),
  new RegExp(`\\bplugin(?:${QUOTE}\\s*,\\s*${QUOTE}|\\s+)(?:install|remove|update)(?:${QUOTE}\\s*,\\s*${QUOTE}|\\s+)(${ID})(?![\\w$-])`, "g"),
  new RegExp(`\\b(?:section|set|element)\\s*:\\s*${QUOTE}(${ID})\\.[\\w.-]+${QUOTE}`, "g"),
  new RegExp(`\\.(?:run|get|until|registered|watch)\\(\\s*${QUOTE}(${ID})\\.[a-z][\\w.-]*${QUOTE}`, "g"),
];

// A sidecar that a check names: the sidecar name of an event or status `"sidecar.<name>.<event>"`.
const SIDECAR_NAMING = new RegExp(`${QUOTE}sidecar\\.(${ID})\\.[a-z][\\w.-]*${QUOTE}`, "g");

/** The names of the sidecars that a line names, in the order of the line. */
export function namedSidecars(line) {
  return [...line.matchAll(SIDECAR_NAMING)].map((match) => match[1]);
}

/**
 * The names of the fake sidecars of the fixtures under root: the part after `sidecar-` of the package name of each folder that
 * fixtureSources of scripts/fixture-registry.mjs releases, which names its events `sidecar.<name>.<event>`.
 */
export function fixtureSidecarNames(root) {
  return fixtureSources(root).sidecars.map((dir) => {
    const name = readJson(join(dir, "package.json")).name;
    const match = /(?:^|\/)sidecar-([a-z][a-z0-9-]*)$/.exec(name ?? "");
    if (!match) throw new Error(`${join(dir, "package.json")}: the name ${JSON.stringify(name)} of a fake sidecar does not end with sidecar-<name>`);
    return match[1];
  });
}

/** The ids of the plugins that a line names, in the order of the line. */
export function namedPlugins(line) {
  const found = [];
  for (const pattern of PLUGIN_NAMINGS) for (const match of line.matchAll(pattern)) found.push({ id: match[1], index: match.index });
  return found.sort((a, b) => a.index - b.index).map((item) => item.id);
}

/**
 * Checks that the files name no plugin other than core, the host or a fixture plugin, and no sidecar other than a fake sidecar.
 * `fixtures` are the ids of the fixture plugins of e2e/fixtures, `sidecars` the names of its fake sidecars, `exempt` the files that
 * docs/spec/verification-boundaries.json still lists, and readSource reads a relative path. Each error names the file, the line and
 * the plugin or sidecar.
 */
export function checkPluginNames(files, { fixtures, sidecars = [], exempt = new Set(), readSource = (file) => readFileSync(join(ROOT, file), "utf8") }) {
  const fakeSidecars = new Set(sidecars);
  const allowed = new Set([...CORE_OWNERS, ...fixtures]);
  const errors = [];
  for (const file of files) {
    if (exempt.has(file)) continue;
    let source;
    try { source = readSource(file); }
    catch (error) {
      errors.push(`${file}: cannot be read: ${error?.message ?? error}`);
      continue;
    }
    source.split("\n").forEach((line, index) => {
      for (const id of namedPlugins(line)) {
        if (!allowed.has(id)) errors.push(`${file}:${index + 1}: names the plugin ${id}, which is neither core nor a fixture plugin of e2e/fixtures`);
      }
      for (const name of namedSidecars(line)) {
        if (!fakeSidecars.has(name)) errors.push(`${file}:${index + 1}: names the sidecar ${name}, which is not a fake sidecar of e2e/fixtures/sidecars`);
      }
    });
  }
  return errors;
}

// The core window checks, benchmarks and harness modules whose plugin names checkPluginNames reads: the sources of e2e/ and scripts/.
// The headless tests of e2e/test/ and scripts/test/ drive no application and test the modules with fakes of their own, and the
// ledger scripts/check-tests.mjs quotes the sources that it connects, so neither is a check that names a plugin.
const CHECK_SOURCE = /^(e2e|scripts)\/.*\.(mjs|js|cjs|ts)$/;
const NOT_CHECKS = /^(e2e\/test|scripts\/test)\/|^scripts\/check-tests\.mjs$/;

/** The files of `tracked` that checkPluginNames reads. */
export function pluginNameScope(tracked) {
  return tracked.filter((file) => CHECK_SOURCE.test(file) && !NOT_CHECKS.test(file));
}

/** The files that the classification docs/spec/verification-boundaries.json lists, which name a real plugin until their conversion. */
export function classifiedFiles(classification) {
  if (classification === null || typeof classification !== "object" || !Array.isArray(classification.files)) {
    throw new Error("docs/spec/verification-boundaries.json holds no list files");
  }
  return new Set(classification.files.map((entry) => entry.file));
}

// The sources of the gate of a core release: the build, the window check runner, the candidate acceptance and the publication gate.
export const GATE_SOURCES = ["Makefile", "scripts/acceptance-run.mjs", "scripts/candidate-acceptance.mjs", "scripts/test-app.mjs"];
const GATE_RULES = [
  { what: "a registry index URL", pattern: /https?:\/\/[^\s"'`)]*(?:registry|index\.json)/ },
  { what: "a plugin repository path", pattern: /\.\.\/(?:plugins|sidecars)\b/ },
  { what: "a registry other than the fixture registry", pattern: /\btarget\/(?!fixture-registry\b)[\w-]*registry\b/ },
];

/** Checks that the gate sources name no registry index URL, no plugin repository path and no registry other than the fixture registry. */
export function checkGateSources(files, readSource = (file) => readFileSync(join(ROOT, file), "utf8")) {
  const errors = [];
  for (const file of files) {
    let source;
    try { source = readSource(file); }
    catch (error) {
      errors.push(`${file}: cannot be read: ${error?.message ?? error}`);
      continue;
    }
    source.split("\n").forEach((line, index) => {
      for (const rule of GATE_RULES) if (rule.pattern.test(line)) errors.push(`${file}:${index + 1}: the gate of a core release names ${rule.what}`);
    });
  }
  return errors;
}

/** The tracked source files of the checkout that the boundary rule covers. */
function trackedSources(root) {
  return execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] })
    .split("\0")
    .filter((file) => file !== "")
    .filter((file) => SOURCE.test(file) && !SKIP_FILES.has(file.split("/").pop()))
    .filter((file) => !file.split("/").some((segment) => SKIP_DIRS.has(segment)));
}

// The folders of declared core packages that tests belong to. Workspace package manifests include applications and the
// root e2e package; Go and Rust package manifests cover the native packages that have no package.json.
const PACKAGE_MARKERS = ["package.json", "go.mod", "Cargo.toml"];
export function corePackageFolders(root = ROOT) {
  const tracked = execFileSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).split("\0").filter((file) => file !== "");
  const folders = new Set(tracked
    .filter((file) => PACKAGE_MARKERS.includes(posix.basename(file)))
    // A package manifest in a fixtures folder describes a payload that a test installs, not an independently owned core package:
    // the payload belongs to the package whose tests hold the folder.
    .filter((file) => !/(^|\/)fixtures\//.test(file))
    .map((file) => posix.dirname(file))
    .filter((dir) => dir !== "."));
  return [...folders]
    .sort((a, b) => a.localeCompare(b))
    .map((dir) => ({ dir, kind: "core", name: dir }));
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

// The JavaScript sources whose reads of docs/spec select the Node tests of their package (scripts/node-tests.mjs --changed).
const JAVASCRIPT = /\.(js|mjs|cjs|ts)$/;

/**
 * The paths of docs/spec that the line reads: each string literal with `../`, resolved from the folder of the file as
 * `new URL(path, import.meta.url)` and a join with the folder of the file resolve it. A template literal reads the folder
 * before its first `${`.
 */
function specReadsOf(line, file) {
  const reads = [];
  for (const match of line.matchAll(LITERAL)) {
    const text = match[1] ?? match[2] ?? match[3] ?? match[4] ?? "";
    if (!text.includes("../")) continue;
    const variable = text.indexOf("${");
    const path = variable < 0 ? text : text.slice(0, text.lastIndexOf("/", variable) + 1);
    const resolved = posix.normalize(posix.join(posix.dirname(file), path));
    if (resolved.startsWith("docs/spec/")) reads.push(resolved);
  }
  return reads;
}

/**
 * Checks that each workspace package declares in `specFiles` of its package.json every file of docs/spec that its JavaScript
 * sources read, and declares no path that does not exist or that no source reads, so that a change of a specification file
 * selects the tests of the packages that read it (scripts/node-tests.mjs --changed). `packages` are the workspace package folders
 * other than the root, which owns docs/spec; `files` are the tracked sources; `exists` tells whether a path of the checkout exists.
 */
export function checkSpecReads(packages, files, {
  readManifest = (folder) => readJson(join(ROOT, folder, "package.json")),
  readSource = (file) => readFileSync(join(ROOT, file), "utf8"),
  exists = (path) => existsSync(join(ROOT, path)),
} = {}) {
  const owners = packages.map((dir) => ({ dir, name: dir }));
  const errors = [];
  const reads = new Map(packages.map((dir) => [dir, []]));
  for (const file of files.filter((item) => JAVASCRIPT.test(item))) {
    const owner = owningComponent(owners, file);
    if (!owner) continue;
    readSource(file).split("\n").forEach((line, index) => {
      for (const path of specReadsOf(line, file)) reads.get(owner.dir).push({ path, where: `${file}:${index + 1}` });
    });
  }
  for (const dir of packages) {
    const manifest = `${dir}/package.json`;
    let declared;
    try { declared = specFilesOf(readManifest(dir), manifest); }
    catch (error) {
      errors.push(error.message);
      continue;
    }
    const found = reads.get(dir);
    for (const { path, where } of found) {
      if (!declared.some((entry) => declaresFile(entry, path))) {
        errors.push(`${where}: ${dir} reads ${path}, which specFiles of ${manifest} does not declare`);
      }
    }
    for (const entry of declared) {
      if (!exists(entry)) errors.push(`${manifest}: specFiles names ${entry}, which does not exist`);
      else if (!found.some(({ path }) => declaresFile(entry, path))) errors.push(`${manifest}: specFiles names ${entry}, which no source of ${dir} reads`);
    }
  }
  return errors;
}

function main() {
  const sources = trackedSources(ROOT);
  const errors = checkNames(new Set(corePackageNames(ROOT)), sources, (file) => readFileSync(join(ROOT, file), "utf8"));
  errors.push(...checkTestPathReads(corePackageFolders(ROOT), sources.filter((file) => TEST_FILE.test(file))));
  errors.push(...checkSpecReads(workspacePackages(ROOT).filter((folder) => folder !== "."), sources));
  const checks = pluginNameScope(sources);
  errors.push(...checkPluginNames(checks, {
    fixtures: fixturePluginIds(join(ROOT, "e2e/fixtures")),
    sidecars: fixtureSidecarNames(join(ROOT, "e2e/fixtures")),
    exempt: classifiedFiles(readJson(join(ROOT, "docs/spec/verification-boundaries.json"))),
  }));
  errors.push(...checkGateSources(GATE_SOURCES));
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else {
    console.log(`Boundary checks passed: ${sources.length} sources, ${checks.length} checks and harness modules`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
