// Checks that the file structures of the two native hosts and the two native applications are the same.
//
// .go and .rs files are compared by the path without the extension, and other files are compared by the path as it is.
// A file that exists on only one side passes only when a row of the Allowed differences table of docs/spec/hosts.md lists it (the row IDs of PAIRS).
//
//   node scripts/check-hosts.mjs
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const ROOT = new URL("../", import.meta.url).pathname;

const PAIRS = [
  { left: "packages/host/wailsv3", right: "packages/host/tauriv2", rows: ["A4", "H1", "H3", "H4", "H5", "H6", "H7", "H8", "H9", "H10", "H12", "H13", "H14", "H15", "H16", "H17", "H18", "H19", "H20"] },
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
};

const mainThreadFree = (name) => Object.keys(MAIN_THREAD_FREE)
  .some((key) => key.endsWith("*") ? name.startsWith(key.slice(0, -1)) : name === key);

// Keywords after which a [ starts an Objective-C message and not a subscript, and the keywords whose condition in parentheses
// a statement follows.
const C_KEYWORDS = new Set(["return", "else", "do", "case", "in"]);
const C_CONDITIONS = new Set(["if", "while", "for", "switch"]);

/**
 * Splits C or Objective-C text into tokens with their line numbers, starting at line first. Comments, preprocessor directives
 * (with their continued lines), string literals and character literals are removed; a string literal becomes the token
 * "string" so that a [ after it is a subscript.
 */
function cTokens(text, first = 1) {
  const tokens = [];
  let line = first;
  let lineStart = true;
  for (let i = 0; i < text.length;) {
    const ch = text[i];
    if (ch === "\n") { line++; lineStart = true; i++; continue; }
    if (ch === " " || ch === "\t" || ch === "\r") { i++; continue; }
    if (lineStart && ch === "#") {
      while (i < text.length && !(text[i] === "\n" && text[i - 1] !== "\\")) { if (text[i] === "\n") line++; i++; }
      continue;
    }
    lineStart = false;
    if (text.startsWith("//", i)) { while (i < text.length && text[i] !== "\n") i++; continue; }
    if (text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2);
      if (end < 0) throw new Error(`unterminated comment at line ${line}`);
      line += text.slice(i, end).split("\n").length - 1;
      i = end + 2;
      continue;
    }
    if (ch === "\"" || ch === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== ch) { if (text[j] === "\\") j++; if (text[j] === "\n") throw new Error(`unterminated literal at line ${line}`); j++; }
      tokens.push({ text: ch === "\"" ? "string" : "char", kind: "literal", line });
      i = j + 1;
      continue;
    }
    const word = /^[A-Za-z_][A-Za-z0-9_]*|^[0-9][A-Za-z0-9_.]*/.exec(text.slice(i, i + 200));
    if (word) {
      tokens.push({ text: word[0], kind: /^[0-9]/.test(word[0]) ? "literal" : "word", line });
      i += word[0].length;
      continue;
    }
    tokens.push({ text: ch, kind: "punct", line });
    i++;
  }
  return tokens;
}

/**
 * Annotates each token with the brackets that enclose it. A token gets the depth of braces (depth), the wrapper of the
 * nearest enclosing call of wailsRunOnWorker, ON_WORKER, wailsRunOnMain or ON_MAIN (wrapper, or undefined), whether any
 * enclosing call is wailsRunOnMain or ON_MAIN (main), and whether it is a [ that starts an Objective-C message (message).
 */
function annotate(tokens) {
  const stack = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const previous = tokens[i - 1];
    token.depth = stack.filter((entry) => entry.text === "{").length;
    token.wrapper = stack.findLast((entry) => entry.wrapper)?.wrapper;
    token.main = stack.some((entry) => MAIN_WRAPPERS.has(entry.wrapper));
    if (token.text === "(" || token.text === "{" || token.text === "[") {
      const callee = token.text === "(" && previous?.kind === "word" ? previous.text : undefined;
      const wrapper = WORKER_WRAPPERS.has(callee) || MAIN_WRAPPERS.has(callee) ? callee : undefined;
      if (token.text === "[") token.message = isMessage(tokens, i);
      stack.push({ text: token.text, wrapper, index: i });
    } else if (token.text === ")" || token.text === "}" || token.text === "]") {
      const open = stack.pop();
      if (open === undefined || ({ ")": "(", "}": "{", "]": "[" })[token.text] !== open.text) {
        throw new Error(`unbalanced ${token.text} at line ${token.line}`);
      }
      token.open = open.index;
    }
  }
  if (stack.length) throw new Error(`unclosed ${stack.at(-1).text} at line ${tokens[stack.at(-1).index].line}`);
  return tokens;
}

/**
 * Returns whether the [ at index starts an Objective-C message. A [ after a name, a literal or a ] is a subscript; a [ after a
 * ) is a subscript only when the parenthesis closes a call or a subscripted expression, and a message after a cast otherwise.
 */
function isMessage(tokens, index) {
  const previous = tokens[index - 1];
  if (previous === undefined) return true;
  if (previous.text === "@") return false;
  if (previous.kind === "word") return C_KEYWORDS.has(previous.text);
  if (previous.kind === "literal" || previous.text === "]") return false;
  if (previous.text === ")") {
    const before = tokens[previous.open - 1];
    if (before?.kind === "word") return C_KEYWORDS.has(before.text) || C_CONDITIONS.has(before.text);
    return before?.text !== ")" && before?.text !== "]";
  }
  return true;
}

/** Returns the functions that the C tokens define at file scope: name -> { start, end, line } of the body. */
function cFunctions(tokens) {
  const functions = new Map();
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.text !== "{" || token.depth !== 0 || tokens[i - 1]?.text !== ")") continue;
    const name = tokens[tokens[i - 1].open - 1];
    let end = i + 1;
    while (end < tokens.length && !(tokens[end].text === "}" && tokens[end].open === i)) end++;
    if (name?.kind === "word") functions.set(name.text, { start: i + 1, end, line: name.line });
    i = end;
  }
  return functions;
}

/** Returns the names of the functions that the C tokens of a header declare at file scope. */
function cDeclarations(tokens) {
  const names = new Set();
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    const previous = tokens[i - 1];
    // A ( followed by * or ^ starts the declarator of a function pointer or a block type, and not a parameter list.
    if (token.kind !== "word" || token.depth !== 0 || tokens[i + 1]?.text !== "(" || ["*", "^"].includes(tokens[i + 2]?.text)) continue;
    if (previous.kind === "word" && tokens[i - 2]?.text !== "@" || previous.text === "*") names.add(token.text);
  }
  return names;
}

/** Splits Go text into the cgo preamble (with the line of its first line) and the Go tokens without comments and literals. */
function goSource(text) {
  const tokens = [];
  let preamble;
  let comment;
  let line = 1;
  for (let i = 0; i < text.length;) {
    const ch = text[i];
    if (ch === "\n") { line++; i++; continue; }
    if (ch === " " || ch === "\t" || ch === "\r") { i++; continue; }
    if (text.startsWith("//", i)) {
      const end = text.indexOf("\n", i);
      const body = text.slice(i + 2, end < 0 ? undefined : end);
      comment = comment?.end === line - 1 ? { ...comment, text: `${comment.text}\n${body}`, end: line } : { text: body, line, end: line };
      i = end < 0 ? text.length : end;
      continue;
    }
    if (text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2);
      if (end < 0) throw new Error(`unterminated comment at line ${line}`);
      const body = text.slice(i + 2, end);
      const lines = body.split("\n").length - 1;
      comment = { text: body, line, end: line + lines };
      line += lines;
      i = end + 2;
      continue;
    }
    if (ch === "\"" || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < text.length && text[j] !== ch) { if (ch !== "`" && text[j] === "\\") j++; if (text[j] === "\n") line++; j++; }
      if (tokens.at(-1)?.text === "import" && text.slice(i, j + 1) === "\"C\"") {
        if (comment === undefined || comment.end !== line - 1) throw new Error(`import "C" at line ${line} has no preamble`);
        preamble = comment;
      }
      tokens.push({ text: "literal", kind: "literal", line });
      i = j + 1;
      continue;
    }
    const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i, i + 200));
    tokens.push({ text: word ? word[0] : ch, kind: word ? "word" : "punct", line });
    i += word ? word[0].length : 1;
  }
  return { preamble, tokens };
}

/**
 * Returns the errors of the main-thread rule of the darwin layer of the Wails host. sources maps repository paths to their
 * text; the audit reads the Go and Objective-C files of the darwin layer and the headers of native/darwin/src.
 *
 * - A function that a Go file exports to C (//export) is referenced in C only inside wailsRunOnWorker or ON_WORKER, so it runs
 *   on the worker while the main thread waits in C.
 * - Go code calls a native function only when MAIN_THREAD_FREE lists it; it calls each other native function through a
 *   function of the layer (a main_ wrapper) that runs it through wailsRunOnMain or ON_MAIN.
 * - A function of the layer that Go code calls sends no Objective-C message and calls no native function outside
 *   wailsRunOnMain or ON_MAIN, directly or through another function of the layer.
 * - No native function and no Objective-C message runs inside wailsRunOnWorker or ON_WORKER.
 */
export function auditMainThreadCalls(sources) {
  const errors = [];
  const native = new Set();
  for (const [path, text] of Object.entries(sources)) {
    if (NATIVE_HEADERS.test(path)) for (const name of cDeclarations(annotate(cTokens(text)))) native.add(name);
  }
  const isNative = (name) => native.has(name) && !mainThreadFree(name);
  const units = [];
  const exports = new Set();
  const goCalls = [];
  for (const [path, text] of Object.entries(sources)) {
    if (!path.startsWith(MAIN_THREAD_LAYER) || path.slice(MAIN_THREAD_LAYER.length).includes("/")) continue;
    try {
      if (path.endsWith(".m")) units.push({ path, tokens: annotate(cTokens(text)) });
      if (!path.endsWith(".go")) continue;
      const { preamble, tokens } = goSource(text);
      if (preamble) units.push({ path, tokens: annotate(cTokens(preamble.text, preamble.line)) });
      for (const [, name] of text.matchAll(/^\/\/export (\w+)$/gm)) exports.add(name);
      tokens.forEach((token, i) => {
        if (token.text === "C" && tokens[i + 1]?.text === "." && tokens[i + 2]?.kind === "word" && tokens[i + 3]?.text === "(") {
          goCalls.push({ path, name: tokens[i + 2].text, line: tokens[i + 2].line });
        }
      });
    } catch (error) {
      throw new Error(`${path}: ${error.message}`, { cause: error });
    }
  }
  const functions = new Map();
  for (const unit of units) {
    for (const [name, body] of cFunctions(unit.tokens)) functions.set(name, { ...body, unit });
  }
  for (const { path, tokens } of units) {
    tokens.forEach((token, i) => {
      if (token.depth > 0 && token.kind === "word" && exports.has(token.text) && !WORKER_WRAPPERS.has(token.wrapper)) {
        errors.push({ path, line: token.line, text: `${token.text} is exported to C and is referenced outside wailsRunOnWorker or ON_WORKER` });
      }
      if (!WORKER_WRAPPERS.has(token.wrapper)) return;
      if (token.kind === "word" && tokens[i + 1]?.text === "(" && isNative(token.text)) {
        errors.push({ path, line: token.line, text: `${token.text} runs on the worker inside wailsRunOnWorker or ON_WORKER; run it through wailsRunOnMain or ON_MAIN` });
      }
      if (token.message) {
        errors.push({ path, line: token.line, text: "an Objective-C message runs on the worker inside wailsRunOnWorker or ON_WORKER; run it through wailsRunOnMain or ON_MAIN" });
      }
    });
  }
  // Returns the chain of calls by which the function name reaches the main thread outside wailsRunOnMain or ON_MAIN, or undefined.
  const reaches = new Map();
  const mainUse = (name, visiting = new Set()) => {
    if (reaches.has(name)) return reaches.get(name);
    if (visiting.has(name)) return undefined;
    visiting.add(name);
    const { start, end, unit: { tokens } } = functions.get(name);
    let found;
    for (let i = start; i < end && found === undefined; i++) {
      const token = tokens[i];
      if (token.main) continue;
      if (token.message) found = `sends an Objective-C message (line ${token.line})`;
      else if (token.kind !== "word" || tokens[i + 1]?.text !== "(") continue;
      else if (isNative(token.text)) found = `calls the native function ${token.text} (line ${token.line})`;
      else if (/^NS[A-Z]/.test(token.text)) found = `calls the AppKit function ${token.text} (line ${token.line})`;
      else if (functions.has(token.text) && token.text !== name) {
        const inner = mainUse(token.text, visiting);
        if (inner) found = `calls ${token.text} (line ${token.line}), which ${inner}`;
      }
    }
    reaches.set(name, found);
    return found;
  };
  for (const call of goCalls) {
    if (isNative(call.name) && !functions.has(call.name)) {
      errors.push({ path: call.path, line: call.line, text: `Go calls the native function ${call.name} directly; call a main_ wrapper that runs it through wailsRunOnMain or ON_MAIN` });
    } else if (functions.has(call.name)) {
      const use = mainUse(call.name);
      if (use) errors.push({ path: call.path, line: call.line, text: `Go calls ${call.name}, which ${use} outside wailsRunOnMain or ON_MAIN` });
    }
  }
  return errors
    .sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line)
    .map((error) => `${error.path}:${error.line}: ${error.text}`);
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
