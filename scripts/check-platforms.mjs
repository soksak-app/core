// Checks that operating-system-specific code exists only under platform/<os>/.
//
// So that adding another operating system needs only one more directory, operating-system conditions and operating-system
// suffix files are placed only in platform/<os>/ of the owning package. The following are not checked.
//
//   native/<os>/                      the directory name denotes the operating system
//   scripts/check-build-environment.sh the build tool checks the running host
//   Cargo.toml                        the target-specific dependency tables are declarations
//   platform/platform.{go,rs,js}      implementation selection files
//   scripts/check-platforms.mjs       this check itself
//
//   node scripts/check-platforms.mjs
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const ROOT = new URL("../", import.meta.url).pathname;
const OS = "(darwin|macos|linux|windows|unix|other|freebsd|ios|android)";
const SOURCE = /\.(js|mjs|go|rs|m|h|sh)$/;
const SKIPPED = [
  /^native\/[^/]+\//,
  /^scripts\/check-build-environment\.sh$/,
  // This file checks whether the command supervisor supports the current host.
  // That is an execution environment contract, not an OS implementation.
  /^scripts\/test-command\.mjs$/,
  /(^|\/)platform\/platform\.(go|rs|js)$/,
  /^scripts\/check-platforms\.mjs$/,
];
const RULES = [
  { what: "Go runtime.GOOS", pattern: /\bruntime\.GOOS\b/ },
  { what: "Go OS build tag", pattern: new RegExp(`^//go:build .*\\b!?${OS}\\b`) },
  { what: "Rust OS cfg", pattern: /cfg!?\((not\()?(target_os|unix|windows)\b/ },
  { what: "Node process.platform", pattern: /\bprocess\.platform\b/ },
];

// A platform adapter may be grouped under a domain directory (for example
// platform/pty.rs). The owning platform root is still explicit.
const inPlatform = (path) => /(^|\/)platform\//.test(path);
const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { cwd: ROOT, encoding: "utf8" }).split("\0").filter((path) => path && existsSync(`${ROOT}${path}`));
const errors = [];
for (const path of files) {
  if (SKIPPED.some((skip) => skip.test(path)) || inPlatform(path)) continue;
  if (new RegExp(`_${OS}\\.(go|rs|m|h)$`).test(path)) errors.push(`${path}: operating system file suffix`);
  if (!SOURCE.test(path)) continue;
  readFileSync(`${ROOT}${path}`, "utf8").split("\n").forEach((line, index) => {
    for (const rule of RULES) {
      if (rule.pattern.test(line)) errors.push(`${path}:${index + 1}: ${rule.what} outside platform/<os>/`);
    }
  });
}
if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Platform checks passed: ${files.length} files`);
}
