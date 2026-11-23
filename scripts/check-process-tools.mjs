// Checks that no Go or Rust source or test starts ps, kill, pgrep or lsof as a subprocess.
//
// A process is read and signalled through the platform interfaces: the hosts read a process through the native library and
// signal through kill(2), and a test judges its own child by its wait status. A process tool that a source starts reads a
// process table that changes while it runs and adds a process of its own to it. Node sources still start these tools until
// F1117-4 moves them to native/darwin/process-identity, and PENDING lists the Go and Rust sources that wait for F1117-4.
//
//   node scripts/check-process-tools.mjs
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const TOOLS = ["ps", "kill", "pgrep", "lsof"];
// The tool is the first argument of exec.Command or exec.CommandContext in Go and of Command::new in Rust, by name or by an
// absolute path whose last part is the name.
const tool = `"(?:/[^"]*/)?(${TOOLS.join("|")})"`;
const STARTS = [
  new RegExp(`\\bexec\\.Command\\(\\s*${tool}`, "g"),
  new RegExp(`\\bexec\\.CommandContext\\(\\s*[^,()]+,\\s*${tool}`, "g"),
  new RegExp(`\\bCommand::new\\(\\s*${tool}`, "g"),
];
// The Go and Rust sources that start a process tool until F1117-4 moves them.
export const PENDING = new Map([
  ["e2e/fixtures/sidecars/agentprobe/tests/process.rs", "F1117-4"],
]);

/** Returns the findings of one source: `<path>:<line>: starts <tool> as a subprocess`, in the order of the source. */
export function processToolFindings(path, source) {
  const found = [];
  for (const pattern of STARTS) {
    for (const match of source.matchAll(pattern)) {
      found.push({ index: match.index, name: match[1] });
    }
  }
  return found.sort((a, b) => a.index - b.index).map(({ index, name }) =>
    `${path}:${source.slice(0, index).split("\n").length}: starts ${name} as a subprocess`);
}

function main() {
  const root = new URL("../", import.meta.url).pathname;
  const paths = execFileSync("git", ["ls-files", "-z", "--", "*.go", "*.rs"], { cwd: root, encoding: "utf8" })
    .split("\0").filter(Boolean);
  const findings = [];
  const pending = [];
  for (const path of paths) {
    const found = processToolFindings(path, readFileSync(root + path, "utf8"));
    if (PENDING.has(path)) {
      if (found.length === 0) findings.push(`${path}: starts no process tool, so it is no longer pending ${PENDING.get(path)}`);
      else pending.push(path);
      continue;
    }
    findings.push(...found);
  }
  for (const path of PENDING.keys()) {
    if (!paths.includes(path)) findings.push(`${path}: is pending ${PENDING.get(path)} but is not a tracked source`);
  }
  if (findings.length > 0) {
    console.error(`Process tool check failed: ${findings.length} findings\n${findings.join("\n")}`);
    process.exit(1);
  }
  console.log(`Process tool check passed: ${paths.length} Go and Rust sources; pending F1117-4: ${pending.join(", ")}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
