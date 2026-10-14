// Checks the diagnostic code of the release bundles. While the version is 0.0.x every release is a diagnostic build
// (AGENTS.md), so its executables carry the diagnostic methods and the frontend embeds the page diagnostic module; a
// later version series carries no diagnostic code and embeds the release page diagnostic module.
//
// Diagnostic code (the diagnostic methods of the host, window recording, the page diagnostic module) is included only in diagnostic builds. This check
// reads every executable in Contents/MacOS of the given bundle. Both applications put the frontend into the executable without compression,
// so every file that the workbench publishes and the release page diagnostic module must appear verbatim in the executable for
// the frontend to be checked. If any is missing, the frontend cannot be read and the check reports an error. The workbench is found as a dependency of the application
// package.json. Plugins and sidecars are not in the bundle; they are installed into the configuration folder (docs/spec/installation.md).
// `make release-check` runs the release build first.
//
// The check also compares each bundle with the macOS minimum of the Makefile (`MACOS_MINIMUM`): Info.plist declares it
// in LSMinimumSystemVersion, the application executable is built for it, and no other executable is built for a newer
// macOS (docs/spec/hosts.md#nativedarwin).
//
//   node scripts/check-release.mjs --macos-minimum VERSION --wailsv3-bundle PATH --tauriv2-bundle PATH
import { parseArgs } from "node:util";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { plistString, RELEASE } from "./check-versions.mjs";

const ROOT = new URL("../", import.meta.url).pathname;

const APPS = ["wailsv3", "tauriv2"];

/** The markers of diagnostic code: diagnostic method names, recording library symbols, and sidecar diagnostic symbols. */
const MARKS = [
  { what: "diagnostic method", pattern: /diagnostics\.(fixture|drag|knob|transcript|capture|modal|surface)/ },
  { what: "window capture symbol", pattern: /sp_capture_/ },
  // A release executable with symbols stripped has no sp_capture_. The ObjC class names of the recording remain as strings.
  { what: "window capture class", pattern: /SPCapture/ },
  { what: "sidecar diagnostic symbol", pattern: /sp_diag_/ },
  // The release build does not declare the diagnostic argument --registry-ca (docs/spec/hosts.md#application-arguments).
  { what: "diagnostic argument", pattern: /registry-ca/ },
];

/** Whether a release of version is a diagnostic build: every 0.0.x release is one (AGENTS.md). */
export const diagnosticRelease = (version) => /^0\.0\./.test(version);

/**
 * Audits the diagnostic code of an executable. A diagnostic release requires the diagnostic methods; another release
 * refuses every diagnostic mark.
 */
export function auditDiagnostics(errors, label, text, required) {
  if (!required) return find(errors, label, text);
  if (!MARKS[0].pattern.test(text)) errors.push(`${label}: lacks the diagnostic methods that a 0.0.x release carries`);
}

// Finds diagnostic markers in the text. Adds each one found to the errors array.
export const find = (errors, label, text) => {
  for (const mark of MARKS) {
    if (mark.pattern.test(text)) errors.push(`${label}: contains a ${mark.what} (${mark.pattern.exec(text)[0]})`);
  }
};

const latin1 = (bytes) => Buffer.from(bytes).toString("latin1");

/**
 * Checks the frontend included in an application executable. text is the executable read as latin1.
 * published is the files {path, bytes} that the workbench publishes, and releaseModule is the bytes of the release page diagnostic module.
 * If a published file or the release module is not present verbatim, the check reports that the frontend cannot be read.
 */
export function auditFrontend(errors, label, text, { published, pageModule, pageModuleName }) {
  const missing = published.filter((file) => !text.includes(latin1(file.bytes))).map((file) => file.path);
  if (!text.includes(latin1(pageModule))) missing.push(pageModuleName);
  if (missing.length) errors.push(`${label}: does not embed a readable frontend; missing ${missing.join(", ")}`);
}

/** The minimum macOS version of a thin 64-bit Mach-O executable, from LC_BUILD_VERSION or LC_VERSION_MIN_MACOSX. */
export function machoMinimum(bytes) {
  if (bytes.length < 32 || bytes.readUInt32LE(0) !== 0xfeedfacf) throw new Error("not a 64-bit Mach-O executable");
  const count = bytes.readUInt32LE(16);
  for (let offset = 32, index = 0; index < count && offset + 16 <= bytes.length; index += 1) {
    const cmd = bytes.readUInt32LE(offset);
    const at = cmd === 0x32 ? offset + 12 : cmd === 0x24 ? offset + 8 : -1;
    if (at >= 0) {
      const encoded = bytes.readUInt32LE(at);
      const patch = encoded & 0xff;
      return `${encoded >>> 16}.${(encoded >>> 8) & 0xff}${patch ? `.${patch}` : ""}`;
    }
    offset += bytes.readUInt32LE(offset + 4);
  }
  throw new Error("declares no minimum macOS version");
}

/** Negative, zero or positive as version a is older than, equal to or newer than version b. */
function compareVersions(a, b) {
  const [x, y] = [a, b].map((version) => version.split(".").map(Number));
  for (let index = 0; index < Math.max(x.length, y.length); index += 1) {
    const difference = (x[index] ?? 0) - (y[index] ?? 0); // default: a missing component is 0
    if (difference) return difference;
  }
  return 0;
}

/**
 * Compares a bundle with the macOS minimum. plist is the text of Contents/Info.plist; executables are
 * {path, application, minimum}. The application executable is built for the minimum, and no other executable is
 * built for a newer macOS.
 */
export function auditMinimum(errors, bundle, minimum, plist, executables) {
  const declared = plistString(plist, "LSMinimumSystemVersion");
  // default: an absent key is reported as missing.
  if (declared !== minimum) errors.push(`${join(bundle, "Contents/Info.plist")}: LSMinimumSystemVersion is ${declared ?? "missing"}, not the macOS minimum ${minimum}`);
  for (const executable of executables) {
    if (executable.application && compareVersions(executable.minimum, minimum) !== 0) {
      errors.push(`${executable.path}: built for macOS ${executable.minimum}, not the macOS minimum ${minimum}`);
    } else if (compareVersions(executable.minimum, minimum) > 0) {
      errors.push(`${executable.path}: built for macOS ${executable.minimum}, newer than the macOS minimum ${minimum}`);
    }
  }
}

/** Finds the directory of package name by the dependencies of package from. */
function packageDir(from, name) {
  return dirname(createRequire(join(from, "package.json")).resolve(`${name}/package.json`));
}

/** Expands a directory entry into the files below it. */
function* expand(dir, path) {
  const full = join(dir, path);
  if (!statSync(full).isDirectory()) yield path;
  else for (const name of readdirSync(full)) yield* expand(dir, join(path, name));
}

/**
 * The published files of the workbench of an application and the page diagnostic module that a release embeds: the
 * diagnostic module (observe.js) in a diagnostic release, the release module otherwise.
 */
function applicationSources(app, diagnostic) {
  const appDir = join(ROOT, "apps", app);
  const workbench = packageDir(appDir, "@soksak/workbench");
  const { files } = JSON.parse(readFileSync(join(workbench, "package.json"), "utf8"));
  const published = files.flatMap((file) => [...expand(workbench, file)]).map((path) => ({ path, bytes: readFileSync(join(workbench, path)) }));
  const module = diagnostic ? "observe.js" : "release-diagnostics.js";
  return { published, pageModule: readFileSync(join(workbench, module)), pageModuleName: `page diagnostics module ${module}` };
}

// Runs the check only when executed directly as a CLI.
if (import.meta.main) {
  // parseArgs keeps the last value of a repeated option, so a repeated option is found from the tokens and refused.
  const { values, tokens } = parseArgs({
    strict: true, tokens: true,
    options: Object.fromEntries([["macos-minimum", { type: "string" }], ...APPS.map((app) => [`${app}-bundle`, { type: "string" }])]),
  });
  const seen = new Set();
  for (const token of tokens.filter((entry) => entry.kind === "option")) {
    if (seen.has(token.name)) throw new Error(`duplicate release option: --${token.name}`);
    seen.add(token.name);
  }
  const minimum = values["macos-minimum"];
  if (minimum !== undefined && !/^\d+\.\d+(?:\.\d+)?$/.test(minimum)) throw new Error("--macos-minimum requires a macOS version such as 14.4");
  const bundles = new Map();
  for (const app of APPS) {
    const path = values[`${app}-bundle`];
    if (path === undefined) continue;
    if (path === "") throw new Error(`--${app}-bundle requires a bundle path`);
    bundles.set(app, resolve(path));
  }
  if (minimum === undefined || bundles.size !== APPS.length) {
    throw new Error("required release options: --macos-minimum VERSION --wailsv3-bundle PATH --tauriv2-bundle PATH");
  }
  const errors = [];
  // The version of the release is the declared workspace version.
  const version = RELEASE;
  const diagnostic = diagnosticRelease(version);

  for (const app of APPS) {
    // The application and the command line sok are in Contents/MacOS of the bundle (docs/spec/hosts.md).
    const executables = join(bundles.get(app), "Contents", "MacOS");
    const executable = join(executables, `soksak-${app}`);
    if (!existsSync(executable)) {
      errors.push(`${executable}: missing; run the release build first`);
      continue;
    }
    // The executable is read as bytes. The markers are ASCII, so interpreting as latin1 does not change positions.
    const built = [];
    for (const name of readdirSync(executables)) {
      const path = join(executables, name);
      const bytes = readFileSync(path);
      const text = latin1(bytes);
      // A diagnostic release requires the diagnostic methods in the application and in sok; the other executables
      // are sidecar helpers that carry none.
      if (path === executable || name === "sok") auditDiagnostics(errors, path, text, diagnostic);
      else find(errors, path, text);
      if (path === executable) auditFrontend(errors, path, text, applicationSources(app, diagnostic));
      try {
        built.push({ path, application: path === executable, minimum: machoMinimum(bytes) });
      } catch (error) {
        errors.push(`${path}: ${error.message}`);
      }
    }
    const plist = join(bundles.get(app), "Contents", "Info.plist");
    auditMinimum(errors, bundles.get(app), minimum, existsSync(plist) ? readFileSync(plist, "utf8") : "", built);
  }

  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else {
    console.log(`Release checks passed: ${APPS.length} applications, ${diagnostic ? "diagnostic" : "without diagnostics"} for version ${version}`);
  }
}
