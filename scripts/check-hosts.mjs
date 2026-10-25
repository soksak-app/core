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
  { left: "packages/host/wailsv3", right: "packages/host/tauriv2", rows: ["A4", "H1", "H3", "H4", "H5", "H6", "H7", "H8", "H9", "H10", "H11", "H12", "H13", "H14", "H15"] },
  { left: "packages/sok/wailsv3", right: "packages/sok/tauriv2", rows: ["A4", "C1", "C2", "C3", "C4", "C5"] },
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
// (docs/spec/native-host.md#host-calls).
const FRAMEWORK_ARGUMENT = /^(Window|Webview|AppHandle|(tauri::)?State<.*>|tauri::ipc::Channel<.*>)$/s;
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

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const tracked = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: ROOT, encoding: "utf8" }).split("\0").filter((path) => path && existsSync(`${ROOT}${path}`));
  const errors = auditHostPairs(tracked);
  for (const file of tracked.filter((path) => path.startsWith("packages/host/tauriv2/src/") && path.endsWith(".rs"))) {
    errors.push(...findUndecodedCommandArguments(readFileSync(`${ROOT}${file}`, "utf8"), file));
  }
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
