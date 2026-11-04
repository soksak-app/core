// Checks that the file structures of the language host libraries, the framework adapters, the command lines and the native
// applications are the same.
//
// .go and .rs files are compared by the path without the extension, and other files are compared by the path as it is.
// A file that exists on only one side passes only when a row of the allowed differences of docs/spec/hosts.md lists it: the rows
// of the table of the pair whose ID starts with the letter of the pair.
//
//   node scripts/check-hosts.mjs
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = new URL("../", import.meta.url).pathname;

// The two tables of the allowed differences: the language table compares the packages of the two languages, and the framework table
// compares the packages of the frameworks. Each names the columns of the left and the right package of its pairs.
export const LANGUAGE_TABLE = { title: "Language table", left: "Go", right: "Rust" };
export const FRAMEWORK_TABLE = { title: "Framework table", left: "Wails", right: "Tauri" };
// The mygo pairs read the same table with the column of mygo as their right column.
export const MYGO_TABLE = { ...FRAMEWORK_TABLE, right: "mygo" };

// A pair reads the rows of its table whose ID starts with its letter: H for the host packages, C for the command lines and A for the
// applications.
const PAIRS = [
  { left: "packages/host/go", right: "packages/host/rust", table: LANGUAGE_TABLE, letter: "H" },
  { left: "packages/sok/go", right: "packages/sok/rust", table: LANGUAGE_TABLE, letter: "C" },
  { left: "packages/host/wailsv3", right: "packages/host/tauriv2", table: FRAMEWORK_TABLE, letter: "H" },
  { left: "apps/wailsv3", right: "apps/tauriv2", table: FRAMEWORK_TABLE, letter: "A" },
  { left: "packages/host/wailsv3", right: "packages/host/mygo", table: MYGO_TABLE, letter: "H" },
  { left: "apps/wailsv3", right: "apps/mygo", table: MYGO_TABLE, letter: "A" },
];

const allowed = (path, files) => files.some((key) => key.endsWith("/") ? path.startsWith(key) : path === key);

/**
 * Returns the rows of each table of the allowed differences of the host specification (docs/spec/hosts.md): for each table title, the
 * cells of each row by the column names of the header. A section or a table that is missing, and a row ID that appears twice across
 * the tables, are errors, so a pair cannot rely on a difference that the specification does not state once.
 */
export function allowedDifferenceTables(hostsMarkdown, tables = [LANGUAGE_TABLE, FRAMEWORK_TABLE]) {
  const start = hostsMarkdown.indexOf("## Allowed differences");
  if (start < 0) throw new Error("hosts spec has no Allowed differences section");
  const end = hostsMarkdown.indexOf("\n## ", start + 1);
  const section = hostsMarkdown.slice(start, end < 0 ? undefined : end);
  const result = new Map();
  const seen = new Map();
  for (const table of tables) {
    const heading = section.indexOf(`### ${table.title}\n`);
    if (heading < 0) throw new Error(`hosts spec has no ${table.title} in the Allowed differences section`);
    const next = section.indexOf("\n### ", heading + 1);
    const lines = section.slice(heading, next < 0 ? undefined : next).split("\n").filter((line) => line.startsWith("|"));
    const cellsOf = (line) => line.split("|").slice(1, -1).map((cell) => cell.trim());
    const header = cellsOf(lines[0] ?? "");
    const rows = new Map();
    for (const line of lines.slice(2)) {
      const cells = cellsOf(line);
      const id = cells[0];
      if (seen.has(id)) throw new Error(`hosts spec row ${id} appears in the ${seen.get(id)} and in the ${table.title}`);
      seen.set(id, table.title);
      rows.set(id, Object.fromEntries(header.map((name, index) => [name, cells[index]])));
    }
    result.set(table.title, rows);
  }
  return result;
}

/**
 * Returns the files that exist on the left package only (left) and on the right package only (right) in the rows of the table of
 * pair whose ID starts with the letter of the pair, or in the rows that pair.rows lists. The column of the left package lists the
 * left files and the column of the right package lists the right files; each file is compared without a .go or .rs extension, and a
 * path that ends with "/" is a directory. A cell of none lists no file, and a cell of content differs states a file that both
 * packages have with a different content, so a row with such a cell lists no file for that pair.
 */
export function allowedFileDifferences(hostsMarkdown, pair) {
  const tables = [LANGUAGE_TABLE, FRAMEWORK_TABLE];
  const rows = allowedDifferenceTables(hostsMarkdown, tables.some((table) => table.title === pair.table.title) ? tables : [...tables, pair.table]).get(pair.table.title);
  const ids = pair.rows ?? [...rows.keys()].filter((id) => id.startsWith(pair.letter));
  const result = { left: [], right: [] };
  for (const id of ids) {
    const row = rows.get(id);
    if (row === undefined) throw new Error(`hosts spec has no allowed difference row ${id} in the ${pair.table.title}`);
    const sides = [["left", pair.table.left], ["right", pair.table.right]];
    for (const [, column] of sides) {
      if (row[column] === undefined) throw new Error(`hosts spec ${pair.table.title} has no column ${column}`);
    }
    if (sides.some(([, column]) => row[column] === "content differs")) continue;
    for (const [side, column] of sides) {
      const cell = row[column];
      if (cell === "none") continue;
      const paths = [...cell.matchAll(/`([^`]+)`/g)].map((match) => match[1].replace(/\.(go|rs)$/, ""));
      if (paths.length === 0) throw new Error(`hosts spec row ${id} lists neither none nor a file in the ${column} cell: ${cell}`);
      result[side].push(...paths);
    }
  }
  return result;
}

export function auditHostPairs(tracked, pairs = PAIRS, hostsMarkdown = readFileSync(`${ROOT}docs/spec/hosts.md`, "utf8")) {
  const errors = [];
  for (const pair of pairs) {
    const only = allowedFileDifferences(hostsMarkdown, pair);
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

// The language host libraries name no framework (docs/spec/hosts.md#host-tree): no Go file of packages/host/go imports a package of
// a framework module and its go.mod requires none, and no Rust source of packages/host/rust names a framework crate and its
// Cargo.toml depends on none.
const LIBRARIES = { go: "packages/host/go/", rust: "packages/host/rust/" };
const FRAMEWORK_MODULES = ["github.com/wailsapp/wails/v3", "github.com/egoist/mygo"];
const FRAMEWORK_CRATE = /^tauri(?:[-_][\w-]+)?$/;
const frameworkModule = (path) => FRAMEWORK_MODULES.find((module) => path === module || path.startsWith(`${module}/`));

/** Returns the import paths of a Go file with their lines. */
function goImports(text) {
  const imports = [];
  let block = false;
  text.split("\n").forEach((line, index) => {
    const code = line.replace(/\/\/.*$/, "").trim();
    if (block) {
      if (code === ")") block = false;
      else if (code.match(/"([^"]+)"/)) imports.push({ path: code.match(/"([^"]+)"/)[1], line: index + 1 });
      return;
    }
    if (/^import\s*\($/.test(code)) block = true;
    else if (/^import\s/.test(code) && code.match(/"([^"]+)"/)) imports.push({ path: code.match(/"([^"]+)"/)[1], line: index + 1 });
  });
  return imports;
}

/** Returns the module paths that the require directives of a go.mod file name, with their lines. */
function goRequires(text) {
  const requires = [];
  let block = false;
  text.split("\n").forEach((line, index) => {
    const code = line.replace(/\/\/.*$/, "").trim();
    if (block) {
      if (code === ")") block = false;
      else if (code) requires.push({ path: code.split(/\s+/)[0], line: index + 1 });
      return;
    }
    if (/^require\s*\($/.test(code)) block = true;
    else if (/^require\s+\S/.test(code)) requires.push({ path: code.split(/\s+/)[1], line: index + 1 });
  });
  return requires;
}

/** Returns the crates of the dependency tables of a Cargo.toml file with their lines. */
function cargoDependencies(text) {
  const dependencies = [];
  let table = "";
  text.split("\n").forEach((line, index) => {
    const code = line.replace(/#.*$/, "").trim();
    const header = code.match(/^\[([^\]]+)\]$/);
    if (header) {
      table = header[1];
      return;
    }
    const key = code.match(/^([A-Za-z0-9_-]+)\s*=/);
    if (key && /(^|\.)(dependencies|dev-dependencies|build-dependencies)$/.test(table)) dependencies.push({ name: key[1], line: index + 1 });
    const dotted = table.match(/(?:^|\.)(?:dependencies|dev-dependencies|build-dependencies)\.([A-Za-z0-9_-]+)$/);
    if (dotted && index > 0 && !dependencies.some((entry) => entry.name === dotted[1])) dependencies.push({ name: dotted[1], line: index });
  });
  return dependencies;
}

/**
 * Returns the lines of the language host libraries that name a framework. paths are repository-relative paths and read(path) is their
 * text; the files of other packages are not read.
 */
export function auditLibraryImports(paths, read) {
  const errors = [];
  for (const path of paths) {
    if (path.startsWith(LIBRARIES.go) && path.endsWith(".go")) {
      for (const entry of goImports(read(path))) {
        if (frameworkModule(entry.path)) errors.push({ path, line: entry.line, text: `the language host library imports the framework package ${entry.path}` });
      }
    } else if (path === `${LIBRARIES.go}go.mod`) {
      for (const entry of goRequires(read(path))) {
        if (frameworkModule(entry.path)) errors.push({ path, line: entry.line, text: `the language host library requires the framework ${entry.path}` });
      }
    } else if (path.startsWith(LIBRARIES.rust) && path.endsWith(".rs")) {
      read(path).split("\n").forEach((line, index) => {
        const code = line.replace(/\/\/.*$/, "");
        for (const match of code.matchAll(/(?<![\w"'])(tauri(?:_\w+)?)\s*::/g)) {
          errors.push({ path, line: index + 1, text: `the language host library names the framework crate ${match[1]}` });
        }
      });
    } else if (path === `${LIBRARIES.rust}Cargo.toml`) {
      for (const entry of cargoDependencies(read(path))) {
        if (FRAMEWORK_CRATE.test(entry.name)) errors.push({ path, line: entry.line, text: `the language host library requires the framework crate ${entry.name}` });
      }
    }
  }
  const lines = errors
    .sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line)
    .map((error) => `${error.path}:${error.line}: ${error.text}`);
  return lines.filter((line, index) => lines.indexOf(line) === index);
}

// The language host libraries name no framework outside their comments (docs/spec/hosts.md#host-tree): no identifier and no string
// of a source or a test of packages/host/go or packages/host/rust has a word that names a framework or its host, and no contract
// declaration of their files names one. A word is a part of an identifier or a string split at underscores and at a change of case.
const FRAMEWORK_WORD = /^(?:wails|tauri|wry|tao|muda|mygo)(?:v[0-9]+)?$/i;
const LIBRARY_SOURCE = /\.(go|rs|m|h|c)$/;
const WORD = /[A-Z]+(?![a-z])[0-9]*|[A-Z]?[a-z]+[0-9]*|[0-9]+/g;
const frameworkWords = (text) => [...text.matchAll(/[A-Za-z0-9_]+/g)]
  .flatMap((token) => token[0].split("_").flatMap((part) => part.match(WORD) ?? []))
  .filter((word) => FRAMEWORK_WORD.test(word));

/**
 * Returns text with each comment replaced by spaces, so the lines keep their numbers. language is go, rust or c (also Objective-C).
 * A string, a Go raw string, a Rust raw string and a character literal are kept, so a comment marker inside them starts no comment;
 * a Rust block comment nests.
 */
export function withoutComments(text, language) {
  const blank = (part) => part.replace(/[^\n]/g, " ");
  let out = "";
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    const next = text[index + 1];
    let end;
    if (char === "/" && next === "/") {
      end = text.indexOf("\n", index);
      if (end < 0) end = text.length;
      out += blank(text.slice(index, end));
    } else if (char === "/" && next === "*") {
      let depth = 1;
      end = index + 2;
      while (end < text.length && depth > 0) {
        if (language === "rust" && text.startsWith("/*", end)) { depth += 1; end += 2; }
        else if (text.startsWith("*/", end)) { depth -= 1; end += 2; }
        else end += 1;
      }
      out += blank(text.slice(index, end));
    } else {
      const raw = language === "rust" && !/\w/.test(text[index - 1] ?? "") ? /^b?r(#*)"/.exec(text.slice(index, index + 260)) : null;
      const character = char === "'" ? /^'(?:\\(?:x[0-9a-fA-F]{2}|u\{[0-9a-fA-F]+\}|.)|[^\\'\n])'/.exec(text.slice(index, index + 16)) : null;
      if (raw) {
        const close = `"${raw[1]}`;
        const at = text.indexOf(close, index + raw[0].length);
        end = at < 0 ? text.length : at + close.length;
      } else if (char === '"' || (language === "go" && char === "`")) {
        end = index + 1;
        while (end < text.length && text[end] !== char) end += char === '"' && text[end] === "\\" ? 2 : 1;
        end += 1;
      } else if (character) {
        end = index + character[0].length;
      } else {
        end = index + 1;
      }
      out += text.slice(index, end);
    }
    index = end;
  }
  return out;
}

/**
 * Returns the lines of the language host libraries whose code outside the comments names a framework, and the contract declarations
 * of their files that name one. paths are repository-relative paths and read(path) is their text; the files of other packages are
 * not read.
 */
export function auditLibraryNames(paths, read) {
  const errors = [];
  for (const path of paths) {
    if (!Object.values(LIBRARIES).some((library) => path.startsWith(library)) || !LIBRARY_SOURCE.test(path)) continue;
    const text = read(path);
    const language = path.endsWith(".go") ? "go" : path.endsWith(".rs") ? "rust" : "c";
    withoutComments(text, language).split("\n").forEach((line, index) => {
      for (const word of frameworkWords(line)) errors.push(`${path}:${index + 1}: the language host library names the framework ${word}`);
    });
    text.split("\n").forEach((line, index) => {
      const declaration = /^\s*\/\/\s*contract:\s*(\S+)/.exec(line);
      for (const word of declaration ? frameworkWords(declaration[1]) : []) {
        errors.push(`${path}:${index + 1}: the contract case ${declaration[1]} of the language host library names the framework ${word}`);
      }
    });
  }
  return errors.filter((line, index) => errors.indexOf(line) === index);
}

// Checks for stub implementations (a regression guard).
const STUB_PATTERNS = [
  /TODO:\s*Implement/,
  /not yet implemented/,
  /unimplemented!/,
  /todo!\(/,
];
const PRODUCT_DIRS = [
  "packages/host/go/src",
  "packages/host/rust/src",
  "packages/host/wailsv3/src",
  "packages/host/mygo/src",
  "packages/host/tauriv2/src",
  "native/darwin/src",
  "packages/workbench-mygo/src",
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

// The darwin layer of the Go language host library runs no Go code on the main thread (docs/spec/hosts.md, main thread of the
// Wails host). Its C code is the cgo preamble of each Go file and each Objective-C file of the folder; the native functions are
// the functions that the headers of native/darwin/src declare.
const MAIN_THREAD_LAYER = "packages/host/go/src/platform/darwin/";
const NATIVE_HEADERS = /^native\/darwin\/src\/[^/]+\.h$/;
const WORKER_WRAPPERS = new Set(["hostRunOnWorker", "ON_WORKER"]);
const MAIN_WRAPPERS = new Set(["hostRunOnMain", "ON_MAIN"]);

// The undecoded command argument audit reads the Rust sources of the Tauri framework adapter, which declares the Tauri commands.
const COMMAND_SOURCES = "packages/host/tauriv2/src/";

/**
 * Returns an error for each prefix of an audit that selects no file of tracked, so an audit whose package moved fails instead of
 * checking nothing.
 */
export function auditPrefixes(tracked) {
  const audits = [
    ["the main-thread audit", [MAIN_THREAD_LAYER]],
    ["the undecoded command argument audit", [COMMAND_SOURCES]],
    ["the stub check", PRODUCT_DIRS.map((dir) => `${dir}/`)],
  ];
  const errors = [];
  for (const [audit, prefixes] of audits) {
    for (const prefix of prefixes) {
      if (!tracked.some((path) => path.startsWith(prefix))) errors.push(`${audit} selects no file with the prefix ${prefix}`);
    }
  }
  return errors;
}

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

/** Returns whether a CallExpr calls a block: clang gives the callee the type of a block pointer, after its typedefs. */
function callsBlock(call) {
  const type = call.inner?.[0]?.type;
  return /^[^()]*\(\^/.test(type?.desugaredQualType ?? type?.qualType ?? "");
}

/**
 * Returns the nearest enclosing call of hostRunOnWorker or hostRunOnMain of a node (ON_WORKER and ON_MAIN expand to them),
 * whether any enclosing call is hostRunOnMain, and the function definition that holds the node.
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
      if (name === "hostRunOnWorker" || name === "hostRunOnMain") {
        wrapper ??= name;
        if (name === "hostRunOnMain") main = true;
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
 * - A function that a Go file exports to C (//export) is referenced in C only inside hostRunOnWorker or ON_WORKER, so it runs
 *   on the worker while the main thread waits in C.
 * - Go code calls a native function only when MAIN_THREAD_FREE lists it; it calls each other native function through a
 *   function of the layer (a main_ wrapper) that runs it through hostRunOnMain or ON_MAIN.
 * - A function of the layer that Go code calls sends no Objective-C message and calls no native or NS function and no block
 *   outside hostRunOnMain or ON_MAIN, directly or through another function of the layer.
 * - No native function, no Objective-C message and no block runs inside hostRunOnWorker or ON_WORKER.
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
      else if (node.kind === "CallExpr" && callsBlock(node)) use = { kind: "block" };
      else if (node.kind === "CallExpr" && calleeName(node) !== undefined) use = { kind: "call", name: calleeName(node) };
      else if (node.kind === "ObjCMessageExpr") use = { kind: "message" };
      if (use) uses.push({ ...use, ...enclosing(entry), path: unit.path, line });
    }
  }
  const isNative = (name) => native.has(name) && !mainThreadFree(name);
  const errors = [];
  for (const use of uses) {
    if (use.kind === "reference" && exports.has(use.name) && use.wrapper !== "hostRunOnWorker") {
      errors.push({ path: use.path, line: use.line, text: `${use.name} is exported to C and is referenced outside hostRunOnWorker or ON_WORKER` });
    }
    if (use.wrapper !== "hostRunOnWorker") continue;
    if (use.kind === "call" && isNative(use.name)) {
      errors.push({ path: use.path, line: use.line, text: `${use.name} runs on the worker inside hostRunOnWorker or ON_WORKER; run it through hostRunOnMain or ON_MAIN` });
    }
    if (use.kind === "message") {
      errors.push({ path: use.path, line: use.line, text: "an Objective-C message runs on the worker inside hostRunOnWorker or ON_WORKER; run it through hostRunOnMain or ON_MAIN" });
    }
    if (use.kind === "block") {
      errors.push({ path: use.path, line: use.line, text: "a block is called on the worker inside hostRunOnWorker or ON_WORKER; run it through hostRunOnMain or ON_MAIN" });
    }
  }
  // Returns the chain of calls by which the function name reaches the main thread outside hostRunOnMain or ON_MAIN, or undefined.
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
      else if (use.kind === "block") found = `calls a block (line ${use.line})`;
      else if (use.kind !== "call") continue;
      else if (isNative(use.name)) found = `calls the native function ${use.name} (line ${use.line})`;
      else if (/^NS[A-Z]/.test(use.name)) found = `calls the AppKit function ${use.name} (line ${use.line})`;
      else if (definitions.has(use.name) && use.name !== name && use.name !== "hostRunOnMain" && use.name !== "hostRunOnWorker") {
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
        errors.push({ path: source.file, line: call.line, text: `Go calls the native function ${call.name} directly; call a main_ wrapper that runs it through hostRunOnMain or ON_MAIN` });
      } else if (definitions.has(call.name)) {
        const use = mainUse(call.name);
        if (use) errors.push({ path: source.file, line: call.line, text: `Go calls ${call.name}, which ${use} outside hostRunOnMain or ON_MAIN` });
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
  const errors = auditPrefixes(tracked);
  errors.push(...auditHostPairs(tracked));
  errors.push(...auditLibraryImports(tracked, (file) => readFileSync(`${ROOT}${file}`, "utf8")));
  errors.push(...auditLibraryNames(tracked, (file) => readFileSync(`${ROOT}${file}`, "utf8")));
  for (const file of tracked.filter((path) => path.startsWith(COMMAND_SOURCES) && path.endsWith(".rs"))) {
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
