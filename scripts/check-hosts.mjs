// Checks that the file structures of the two native hosts and the two native applications are the same.
//
// .go and .rs files are compared by the path without the extension, and other files are compared by the path as it is.
// A file that exists on only one side passes only when a row of the Allowed differences table of docs/spec/hosts.md lists it (the row IDs of PAIRS).
//
//   node scripts/check-hosts.mjs
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = new URL("../", import.meta.url).pathname;

const PAIRS = [
  { left: "packages/host/wailsv3", right: "packages/host/tauriv2", rows: ["A4", "H1", "H3", "H4", "H5", "H6", "H7", "H8", "H9", "H10", "H12", "H13", "H14", "H15", "H16", "H17", "H18", "H19", "H20", "H21"] },
  { left: "packages/sok/wailsv3", right: "packages/sok/tauriv2", rows: ["A4", "C1", "C2", "C3", "C4", "C5", "C6"] },
  { left: "apps/wailsv3", right: "apps/tauriv2", rows: ["A2", "A3", "A4", "A5"] },
];

/** Converts the files under a directory to paths for comparison. */
function tree(dir) {
  const prefix = `${dir}/`;
  return new Set(tracked
    .filter((path) => path.startsWith(prefix))
    .map((path) => path.slice(prefix.length).replace(/\.(go|rs)$/, "")));
}

const allowed = (path, files) => files.some((key) => key.endsWith("/") ? path.startsWith(key) : path === key);

/**
 * Returns the files that exist on the left host only (left) and on the right host only (right) in the rows of the Allowed differences table
 * of the host specification (docs/spec/hosts.md). The Wails cell of a row lists the left files and the Tauri cell lists the right files; each
 * file is compared without a .go or .rs extension, and a path that ends with "/" is a directory. A cell of none lists no file. A row that the
 * table lacks is an error, so a pair cannot rely on a difference that the specification does not state.
 */
export function allowedFileDifferences(hostsMarkdown, ids) {
  const start = hostsMarkdown.indexOf("## Allowed differences");
  if (start < 0) throw new Error("hosts spec has no Allowed differences section");
  const end = hostsMarkdown.indexOf("\n## ", start + 1);
  const section = hostsMarkdown.slice(start, end < 0 ? undefined : end);
  const result = { left: [], right: [] };
  for (const id of ids) {
    const line = section.split("\n").find((candidate) => candidate.split("|")[1]?.trim() === id);
    if (line === undefined) throw new Error(`hosts spec has no allowed difference row ${id}`);
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    for (const [side, cell] of [["left", cells[1]], ["right", cells[2]]]) {
      if (cell === "none") continue;
      const paths = [...cell.matchAll(/`([^`]+)`/g)].map((match) => match[1].replace(/\.(go|rs)$/, ""));
      if (paths.length === 0) throw new Error(`hosts spec row ${id} lists neither none nor a file in the ${side} cell: ${cell}`);
      result[side].push(...paths);
    }
  }
  return result;
}

export function auditHostPairs(tracked, pairs = PAIRS, hostsMarkdown = readFileSync(`${ROOT}docs/spec/hosts.md`, "utf8")) {
  const errors = [];
  for (const pair of pairs) {
    const only = allowedFileDifferences(hostsMarkdown, pair.rows);
    const left = new Set(tracked
      .filter((path) => path.startsWith(`${pair.left}/`))
      .map((path) => path.slice(pair.left.length + 1).replace(/\.(go|rs)$/, "")));
    const right = new Set(tracked
      .filter((path) => path.startsWith(`${pair.right}/`))
      .map((path) => path.slice(pair.right.length + 1).replace(/\.(go|rs)$/, "")));
    if (left.size === 0) errors.push(`${pair.left}: no files`);
    if (right.size === 0) errors.push(`${pair.right}: no files`);
    for (const path of left) {
      if (!right.has(path) && !allowed(path, only.left)) errors.push(`${pair.left}/${path}: no counterpart in ${pair.right}`);
    }
    for (const path of right) {
      if (!left.has(path) && !allowed(path, only.right)) errors.push(`${pair.right}/${path}: no counterpart in ${pair.left}`);
    }
  }
  return errors;
}

// Checks for stub implementations (a regression guard).
const STUB_PATTERNS = [
  /TODO:\s*Implement/,
  /not yet implemented/,
  /unimplemented!/,
  /todo!\(/,
];
const PRODUCT_DIRS = [
  "packages/host/wailsv3/src",
  "packages/host/tauriv2/src",
  "native/darwin/src",
];
/** Paths that are not checked. Tests and the Windows unsupported implementation legitimately hold stub wording. */
const EXCLUDE = /(^|\/)(test|tests|windows)(\/|$)/;
const STUB_SOURCE = /\.(go|rs|m|js|mjs)$/;

/**
 * Returns the lines of stub implementations in product sources. files are repository-relative paths and read(file) is their text. A file that cannot be read
 * was not checked, so the check fails with an error that holds the path.
 */
export function findStubs(files, read) {
  const stubs = [];
  for (const file of files) {
    if (!PRODUCT_DIRS.some((dir) => file.startsWith(`${dir}/`)) || !STUB_SOURCE.test(file) || EXCLUDE.test(file)) continue;
    let content;
    try {
      content = read(file);
    } catch (error) {
      throw new Error(`${file}: ${error.message}`, { cause: error });
    }
    content.split("\n").forEach((line, index) => {
      for (const pattern of STUB_PATTERNS) if (pattern.test(line)) stubs.push(`${file}:${index + 1}: ${pattern.source}`);
    });
  }
  return stubs;
}

// An argument of a Tauri command is Argument<T> unless it is a framework object. Then the argument decoder of the host interprets it and rejects it with the same sentence as the Wails host
// (docs/spec/native-host.md#host-calls). A command that is generic over the runtime names the application handle as
// AppHandle<R>, which is the same framework object.
const FRAMEWORK_ARGUMENT = /^(Window|Webview|AppHandle(<R>)?|(tauri::)?State<.*>|tauri::ipc::Channel<.*>)$/s;
const COMMAND = /#\[tauri::command[^\]]*\]\s*(?:#\[[^\]]*\]\s*)*(?:pub(?:\(crate\))?\s+)?(?:async\s+)?fn\s+(\w+)(?:<[^>]*>)?\(([^)]*)\)/g;

/** Returns the arguments of the Tauri commands in source that are neither a framework object nor Argument<T>. */
export function findUndecodedCommandArguments(source, file) {
  const errors = [];
  for (const [, name, params] of source.matchAll(COMMAND)) {
    let depth = 0;
    let current = "";
    const parts = [];
    for (const ch of params) {
      if (ch === "<") depth++;
      if (ch === ">") depth--;
      if (ch === "," && depth === 0) {
        parts.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
    parts.push(current);
    for (const part of parts.map((value) => value.trim()).filter(Boolean)) {
      const [argument, ...type] = part.split(":");
      const declared = type.join(":").trim();
      if (!FRAMEWORK_ARGUMENT.test(declared) && !declared.startsWith("Argument<")) {
        errors.push(`${file}: command ${name} argument ${argument.trim()} is ${declared}, not Argument<T>`);
      }
    }
  }
  return errors;
}

// The darwin layer of the Wails host runs no Go code on the main thread (docs/spec/hosts.md, main thread of the Wails host).
// Its C code is the cgo preamble of each Go file and each Objective-C file of the folder; the native functions are the
// functions that the headers of native/darwin/src declare.
const MAIN_THREAD_LAYER = "packages/host/wailsv3/src/platform/darwin/";
const NATIVE_HEADERS = /^native\/darwin\/src\/[^/]+\.h$/;
const WORKER_WRAPPERS = new Set(["wailsRunOnWorker", "ON_WORKER"]);
const MAIN_WRAPPERS = new Set(["wailsRunOnMain", "ON_MAIN"]);

/**
 * The native functions of native/darwin that Go code calls directly because they use no AppKit, WebKit or main-thread state;
 * a name that ends with * covers the functions with that prefix. Each value states why the function needs no thread.
 */
export const MAIN_THREAD_FREE = {
  "sp_event_*": "the event ring and its policy are atomic state that any thread writes and the host drains",
  sp_mono_ns: "the clock reads mach_continuous_time, which any thread reads",
  sp_observe_flush: "the observation counters are atomic, and the flush writes them to the event ring",
  sp_phys_footprint: "the footprint reads task_info of the own task, a Mach call of any thread",
  sp_diagnostic_reports_directory: "the directory is a path of the file system that NSFileManager resolves on any thread",
  sp_capture_clock: "the capture clock reads the host time, which any thread reads",
  sp_capture_error: "the capture error is a string that the capture library returns for an error code",
  sp_facts_free: "the function frees a string that a native function returned",
  sp_ui_enqueue: "the function adds a C function to the main queue of libdispatch, which any thread may do",
  sp_ui_enqueue_after: "the function adds a C function to the main queue of libdispatch after a delay, which any thread may do",
};

const mainThreadFree = (name) => Object.keys(MAIN_THREAD_FREE)
  .some((key) => key.endsWith("*") ? name.startsWith(key.slice(0, -1)) : name === key);

// The flags of the cgo preambles and Objective-C files of the darwin layer, which cgo passes with the #cgo CFLAGS lines; the
// preamble file starts with the prolog of cgo, which includes stddef.h.
const CLANG_FLAGS = ["-x", "objective-c", "-fmodules", "-fblocks", "-mmacosx-version-min=14.4", "-w", "-fsyntax-only", "-Xclang", "-ast-dump=json"];
const PREAMBLE_PROLOG = "#include <stddef.h>\n";

/**
 * Returns the nodes of the clang JSON AST of one translation unit with their locations. clang writes the file and the line of
 * a location only when they differ from the location that it wrote before, so the walk keeps the last file and line in the
 * order of the dump. A declaration takes its location (loc) and an expression, which has none, the beginning of its range; a
 * node in a macro takes the location where the macro is used (expansionLoc). Each node gets its enclosing nodes (parents).
 */
function astNodes(root) {
  const state = { file: undefined, line: undefined };
  const bare = (location) => {
    if (location.file !== undefined) state.file = location.file;
    if (location.line !== undefined) state.line = location.line;
    return location.offset === undefined ? undefined : { file: state.file, line: state.line };
  };
  const place = (location) => {
    if (location.spellingLoc) {
      bare(location.spellingLoc);
      return bare(location.expansionLoc);
    }
    return bare(location);
  };
  const nodes = [];
  // clang also lists a block of an Objective-C method as a declaration of the method, outside the BlockExpr that holds it; that
  // copy is walked for its locations and not returned, because it has lost its enclosing call.
  const visit = (node, parents, listed = true) => {
    const entry = { node, parents };
    if (node.loc) entry.place = place(node.loc);
    if (node.range) {
      const begin = place(node.range.begin);
      place(node.range.end);
      entry.place ??= begin;
    }
    const returned = listed && !(node.kind === "BlockDecl" && parents.at(-1)?.kind !== "BlockExpr");
    if (returned) nodes.push(entry);
    const inner = [...parents, node];
    for (const child of node.inner ?? []) visit(child, inner, returned);
  };
  visit(root, []);
  return nodes;
}

/** Returns the name of the function that a CallExpr calls, from the first DeclRefExpr of its callee. */
function calleeName(call) {
  const find = (node) => {
    if (node.kind === "DeclRefExpr") return node.referencedDecl?.name;
    for (const child of node.inner ?? []) {
      const name = find(child);
      if (name !== undefined) return name;
    }
    return undefined;
  };
  return call.inner?.[0] ? find(call.inner[0]) : undefined;
}

/**
 * Returns the nearest enclosing call of wailsRunOnWorker or wailsRunOnMain of a node (ON_WORKER and ON_MAIN expand to them),
 * whether any enclosing call is wailsRunOnMain, and the function definition that holds the node.
 */
function enclosing(entry) {
  let wrapper;
  let main = false;
  let definition;
  for (let i = entry.parents.length - 1; i >= 0; i--) {
    const parent = entry.parents[i];
    const child = entry.parents[i + 1] ?? entry.node;
    if (parent.kind === "CallExpr" && parent.inner?.[0] !== child) {
      const name = calleeName(parent);
      if (name === "wailsRunOnWorker" || name === "wailsRunOnMain") {
        wrapper ??= name;
        if (name === "wailsRunOnMain") main = true;
      }
    }
    if (definition === undefined && parent.kind === "FunctionDecl") definition = parent.name;
  }
  return { wrapper, main, definition };
}

/**
 * Returns the errors of the main-thread rule of the darwin layer of the Wails host. sources maps repository paths to their
 * text; the audit reads the Go and Objective-C files of the darwin layer and the headers of native/darwin/src.
 *
 * - A function that a Go file exports to C (//export) is referenced in C only inside wailsRunOnWorker or ON_WORKER, so it runs
 *   on the worker while the main thread waits in C.
 * - Go code calls a native function only when MAIN_THREAD_FREE lists it; it calls each other native function through a
 *   function of the layer (a main_ wrapper) that runs it through wailsRunOnMain or ON_MAIN.
 * - A function of the layer that Go code calls sends no Objective-C message and calls no native or NS function outside
 *   wailsRunOnMain or ON_MAIN, directly or through another function of the layer.
 * - No native function and no Objective-C message runs inside wailsRunOnWorker or ON_WORKER.
 *
 * go/parser reads the Go files (scripts/cgo-sources.go): the preamble, the #cgo CFLAGS, the //export functions and the calls of
 * C functions. clang reads each preamble and each Objective-C file and dumps its AST as JSON, with the macros expanded and each
 * called function resolved to its declaration; a function that a header of native/darwin/src declares is a native function.
 * Two other parsers do not meet the check: cmd/cgo translates a package only with the pkg-config package soksak-darwin, which
 * native/darwin installs with the built library and the structure job of CI does not build; tree-sitter-objc does not expand
 * ON_MAIN and ON_WORKER, whose first argument is a type, and does not resolve which header declares a called function. The
 * files are written to a temporary folder of their own, which the audit removes.
 */
export function auditMainThreadCalls(sources) {
  const folder = mkdtempSync(join(tmpdir(), "main-thread-audit-"));
  try {
    for (const [path, text] of Object.entries(sources)) {
      if (!path.startsWith(MAIN_THREAD_LAYER) && !NATIVE_HEADERS.test(path)) continue;
      mkdirSync(dirname(join(folder, path)), { recursive: true });
      writeFileSync(join(folder, path), text);
    }
    return auditFolder(folder, Object.keys(sources));
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

/** Audits the files of paths that auditMainThreadCalls wrote into folder. */
function auditFolder(folder, paths) {
  const layerFiles = paths.filter((path) => path.startsWith(MAIN_THREAD_LAYER) && !path.slice(MAIN_THREAD_LAYER.length).includes("/"));
  const goFiles = layerFiles.filter((path) => path.endsWith(".go"));
  const goSources = goFiles.length === 0 ? [] : JSON.parse(execFileSync("go", ["run", `${ROOT}scripts/cgo-sources.go`],
    { cwd: folder, input: goFiles.join("\n"), encoding: "utf8", maxBuffer: 1 << 26 }));
  const defines = [...new Set(goSources.flatMap((source) => source.cflags).filter((flag) => flag.startsWith("-D")))];
  const units = [];
  for (const source of goSources) {
    if (source.preamble === null) continue;
    const file = `${source.file}.preamble.m`;
    writeFileSync(join(folder, file), PREAMBLE_PROLOG + source.preamble.text);
    units.push({ path: source.file, file, line: (line) => line - 2 + source.preamble.line });
  }
  for (const path of layerFiles.filter((path) => path.endsWith(".m"))) units.push({ path, file: path, line: (line) => line });
  const nativeFolder = join(folder, "native/darwin/src/");
  const native = new Set();
  const definitions = new Map();
  const uses = [];
  const exports = new Set(goSources.flatMap((source) => source.exports));
  for (const unit of units) {
    let dump;
    try {
      dump = execFileSync("clang", [...CLANG_FLAGS, ...defines, "-I", nativeFolder, "-I", join(folder, MAIN_THREAD_LAYER), unit.file],
        { cwd: folder, encoding: "utf8", maxBuffer: 1 << 30, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      throw new Error(`${unit.path}: clang failed: ${error.stderr || error.message}`, { cause: error });
    }
    const main = join(folder, unit.file);
    for (const entry of astNodes(JSON.parse(dump))) {
      const { node, place } = entry;
      if (node.kind === "FunctionDecl" && place?.file?.startsWith(nativeFolder)) native.add(node.name);
      if (place?.file !== main && place?.file !== unit.file) continue;
      const line = unit.line(place.line);
      if (node.kind === "FunctionDecl" && node.inner?.some((child) => child.kind === "CompoundStmt")) {
        definitions.set(node.name, { path: unit.path, line });
        continue;
      }
      let use;
      if (node.kind === "DeclRefExpr" && node.referencedDecl?.kind === "FunctionDecl") use = { kind: "reference", name: node.referencedDecl.name };
      else if (node.kind === "CallExpr" && calleeName(node) !== undefined) use = { kind: "call", name: calleeName(node) };
      else if (node.kind === "ObjCMessageExpr") use = { kind: "message" };
      if (use) uses.push({ ...use, ...enclosing(entry), path: unit.path, line });
    }
  }
  const isNative = (name) => native.has(name) && !mainThreadFree(name);
  const errors = [];
  for (const use of uses) {
    if (use.kind === "reference" && exports.has(use.name) && use.wrapper !== "wailsRunOnWorker") {
      errors.push({ path: use.path, line: use.line, text: `${use.name} is exported to C and is referenced outside wailsRunOnWorker or ON_WORKER` });
    }
    if (use.wrapper !== "wailsRunOnWorker") continue;
    if (use.kind === "call" && isNative(use.name)) {
      errors.push({ path: use.path, line: use.line, text: `${use.name} runs on the worker inside wailsRunOnWorker or ON_WORKER; run it through wailsRunOnMain or ON_MAIN` });
    }
    if (use.kind === "message") {
      errors.push({ path: use.path, line: use.line, text: "an Objective-C message runs on the worker inside wailsRunOnWorker or ON_WORKER; run it through wailsRunOnMain or ON_MAIN" });
    }
  }
  // Returns the chain of calls by which the function name reaches the main thread outside wailsRunOnMain or ON_MAIN, or undefined.
  const reaches = new Map();
  const mainUse = (name, visiting = new Set()) => {
    if (reaches.has(name)) return reaches.get(name);
    if (visiting.has(name)) return undefined;
    visiting.add(name);
    let found;
    for (const use of uses) {
      if (found !== undefined) break;
      if (use.definition !== name || use.main) continue;
      if (use.kind === "message") found = `sends an Objective-C message (line ${use.line})`;
      else if (use.kind !== "call") continue;
      else if (isNative(use.name)) found = `calls the native function ${use.name} (line ${use.line})`;
      else if (/^NS[A-Z]/.test(use.name)) found = `calls the AppKit function ${use.name} (line ${use.line})`;
      else if (definitions.has(use.name) && use.name !== name) {
        const inner = mainUse(use.name, visiting);
        if (inner) found = `calls ${use.name} (line ${use.line}), which ${inner}`;
      }
    }
    reaches.set(name, found);
    return found;
  };
  for (const source of goSources) {
    for (const call of source.calls) {
      if (isNative(call.name) && !definitions.has(call.name)) {
        errors.push({ path: source.file, line: call.line, text: `Go calls the native function ${call.name} directly; call a main_ wrapper that runs it through wailsRunOnMain or ON_MAIN` });
      } else if (definitions.has(call.name)) {
        const use = mainUse(call.name);
        if (use) errors.push({ path: source.file, line: call.line, text: `Go calls ${call.name}, which ${use} outside wailsRunOnMain or ON_MAIN` });
      }
    }
  }
  const lines = errors
    .sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line)
    .map((error) => `${error.path}:${error.line}: ${error.text}`);
  return lines.filter((line, index) => lines.indexOf(line) === index);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const tracked = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: ROOT, encoding: "utf8" }).split("\0").filter((path) => path && existsSync(`${ROOT}${path}`));
  const errors = auditHostPairs(tracked);
  for (const file of tracked.filter((path) => path.startsWith("packages/host/tauriv2/src/") && path.endsWith(".rs"))) {
    errors.push(...findUndecodedCommandArguments(readFileSync(`${ROOT}${file}`, "utf8"), file));
  }
  errors.push(...auditMainThreadCalls(Object.fromEntries(tracked
    .filter((path) => path.startsWith(MAIN_THREAD_LAYER) || NATIVE_HEADERS.test(path))
    .map((path) => [path, readFileSync(`${ROOT}${path}`, "utf8")]))));
  const stubErrors = findStubs(tracked, (file) => readFileSync(`${ROOT}${file}`, "utf8"));
  if (stubErrors.length) {
    console.error("Stub implementations found (anti-regression check failed):");
    console.error(stubErrors.join("\n"));
    process.exitCode = 1;
  }
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else if (stubErrors.length === 0) {
    console.log(`Host structure checks passed: ${PAIRS.length} pairs`);
  }
}
