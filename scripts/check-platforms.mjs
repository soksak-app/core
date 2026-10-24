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
import { parse } from "acorn";

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
const testPath = (path) => /(^|\/)(test|tests)(\/|$)|\.test\.[^/]+$|(^|\/)[^/]+_test\.(go|rs)$/.test(path);

function nodePlatformFindings(path, source) {
  if (!/\.(js|mjs)$/.test(path) || !source.includes("process.platform")) return [];
  const ast = parse(source, { ecmaVersion: "latest", sourceType: "module", locations: true });
  const findings = [];
  const visit = (node, ancestors = []) => {
    if (!node || typeof node !== "object") return;
    if (node.type === "MemberExpression" && !node.computed
      && node.object?.type === "Identifier" && node.object.name === "process"
      && node.property?.type === "Identifier" && node.property.name === "platform") {
      const line = node.loc.start.line;
      const property = ancestors.at(-1);
      const object = ancestors.at(-2);
      const returned = ancestors.at(-3);
      const environment = ancestors.findLast((ancestor) =>
        (ancestor.type === "FunctionDeclaration" || ancestor.type === "FunctionExpression")
        && ancestor.id?.name === "environment");
      const metadataField = property?.type === "Property" && property.value === node
        && property.key?.type === "Identifier" && property.key.name === "platform"
        && object?.type === "ObjectExpression" && returned?.type === "ReturnStatement"
        && returned.argument === object && environment !== undefined;
      const call = ancestors.at(-1);
      const comparedValue = call?.type === "CallExpression" && call.arguments[1] === node
        && call.callee?.type === "MemberExpression" && call.callee.object?.name === "assert"
        && ["equal", "strictEqual"].includes(call.callee.property?.name)
        && call.arguments[0]?.type === "MemberExpression" && call.arguments[0].property?.name === "platform"
        && call.arguments[0].object?.type === "MemberExpression"
        && call.arguments[0].object.property?.name === "environment"
        && call.arguments[0].object.object?.name === "result";
      if (!metadataField && !(testPath(path) && comparedValue)) findings.push(line);
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "loc" || key === "start" || key === "end") continue;
      if (Array.isArray(value)) {
        for (const child of value) if (child?.type) visit(child, [...ancestors, node]);
      } else if (value?.type) {
        visit(value, [...ancestors, node]);
      }
    }
  };
  visit(ast);
  return findings;
}

/** Reports platform selectors outside implementation boundaries, permitting the benchmark's runtime metadata contract. */
export function auditPlatformSource(path, source) {
  const errors = [];
  const extension = path.slice(path.lastIndexOf(".") + 1);
  if (["js", "mjs"].includes(extension)) {
    for (const line of nodePlatformFindings(path, source)) {
      errors.push(`${path}:${line}: Node process.platform outside platform/<os>/`);
    }
    return errors;
  }
  source.split("\n").forEach((line, index) => {
    for (const rule of RULES) {
      if (rule.what === "Node process.platform") continue;
      if (rule.what.startsWith("Go ") && extension !== "go") continue;
      if (rule.what === "Rust OS cfg" && extension !== "rs") continue;
      if (!rule.pattern.test(line)) continue;
      errors.push(`${path}:${index + 1}: ${rule.what} outside platform/<os>/`);
    }
  });
  return errors;
}

// A platform adapter may be grouped under a domain directory (for example
// platform/pty.rs). The owning platform root is still explicit.
const inPlatform = (path) => /(^|\/)platform\//.test(path);
const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { cwd: ROOT, encoding: "utf8" }).split("\0").filter((path) => path && existsSync(`${ROOT}${path}`));
function main() {
  const errors = [];
  for (const path of files) {
    if (SKIPPED.some((skip) => skip.test(path)) || inPlatform(path)) continue;
    if (new RegExp(`_${OS}\\.(go|rs|m|h)$`).test(path)) errors.push(`${path}: operating system file suffix`);
    if (!SOURCE.test(path)) continue;
    errors.push(...auditPlatformSource(path, readFileSync(`${ROOT}${path}`, "utf8")));
  }
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else {
    console.log(`Platform checks passed: ${files.length} files`);
  }
}

if (import.meta.main) main();
