// Checks that no Go, Rust or Node source or test starts ps, kill, pgrep or lsof as a subprocess.
//
// A process is read and signalled through the platform interfaces: the hosts read a process through the native library and
// signal through kill(2), Node reads the process table through packages/window-check/platform/platform.mjs
// (docs/spec/verification.md#process-table), and a test judges its own child by its wait status. A process tool that a source
// starts reads a process table that changes while it runs and adds a process of its own to it.
//
//   node scripts/check-process-tools.mjs
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const TOOLS = ["ps", "kill", "pgrep", "lsof"];
// The tool is the first argument of exec.Command or exec.CommandContext in Go, of Command::new in Rust and of the child_process
// functions in Node, by name or by an absolute path whose last part is the name; execSync and exec take a shell command line,
// whose first word is the tool.
const names = TOOLS.join("|");
const tool = `"(?:/[^"]*/)?(?<name>${names})"`;
const STARTS = [
  new RegExp(`\\bexec\\.Command\\(\\s*${tool}`, "g"),
  new RegExp(`\\bexec\\.CommandContext\\(\\s*[^,()]+,\\s*${tool}`, "g"),
  new RegExp(`\\bCommand::new\\(\\s*${tool}`, "g"),
  new RegExp(`\\b(?:spawn|spawnSync|execFile|execFileSync)\\(\\s*(?<quote>["'\`])(?:/[^"'\`]*/)?(?<name>${names})\\k<quote>`, "g"),
  new RegExp(`\\b(?:exec|execSync)\\(\\s*["'\`](?:/\\S*/)?(?<name>${names})\\b`, "g"),
];

/** Returns the findings of one source: `<path>:<line>: starts <tool> as a subprocess`, in the order of the source. */
export function processToolFindings(path, source) {
  const found = [];
  for (const pattern of STARTS) {
    for (const match of source.matchAll(pattern)) {
      found.push({ index: match.index, name: match.groups.name });
    }
  }
  return found.sort((a, b) => a.index - b.index).map(({ index, name }) =>
    `${path}:${source.slice(0, index).split("\n").length}: starts ${name} as a subprocess`);
}

function main() {
  const root = new URL("../", import.meta.url).pathname;
  const paths = execFileSync("git", ["ls-files", "-z", "--", "*.go", "*.rs", "*.mjs", "*.js", "*.cjs", "*.ts"], { cwd: root, encoding: "utf8" })
    .split("\0").filter(Boolean);
  const findings = [];
  for (const path of paths) findings.push(...processToolFindings(path, readFileSync(root + path, "utf8")));
  if (findings.length > 0) {
    console.error(`Process tool check failed: ${findings.length} findings\n${findings.join("\n")}`);
    process.exit(1);
  }
  console.log(`Process tool check passed: ${paths.length} Go, Rust and Node sources`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
