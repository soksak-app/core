// The rules of the exposure check of the workbench (docs/spec/exposure.md).
//
//     1. Every exposed name written in a source (a name in quotes, data-expose, data-command, bindings and runs) is declared.
//     2. A declared status and command is registered, and a declared dom name is written as a value attached to an element.
// Whether an operable element has a command and a dom name is judged in the running document.
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/* A dotted name in quotes that is not an exposed name. It is a file name. */
const FILE = /\.(html|js|mjs|json|css)$/;

/** The files under dir that satisfy test. node_modules, test, dist and build are skipped. */
export function* sourceFiles(dir, test) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (!["node_modules", "test", "dist", "build"].includes(name)) yield* sourceFiles(path, test);
    } else if (test(name)) {
      yield path;
    }
  }
}

/**
 * The error list of the workbench. sources is { path, text }, registrations is the statements of the registration code, and where is
 * the place of the workbench used in registration errors.
 */
export function auditExposure({ where, exposes, sources, registrations = [] }) {
  const errors = [];
  const report = (path, index, text) => errors.push(`${path}:${index + 1}: ${text}`);
  // default: status, commands and dom of exposes are optional fields; when missing, there is no declaration of that kind.
  const entries = (list) => new Set((list ?? []).map((e) => e.name));
  const declared = { status: entries(exposes.status), command: entries(exposes.commands), dom: entries(exposes.dom) };
  // default: a name that is declared as none of the three kinds is reported.
  const any = (name) => Object.values(declared).some((set) => set.has(name));
  const quoted = new RegExp(`["'\`](core\\.[a-z0-9-]+(?:\\.[a-z0-9-]+)*)["'\`]`, "g");
  const shown = new Set();

  for (const { path, text } of sources) {
    text.split("\n").forEach((line, index) => {
      // 1. Names
      for (const [, name] of line.matchAll(quoted)) {
        if (!FILE.test(name) && !any(name)) report(path, index, `${name} is not declared`);
      }
      for (const [, name] of line.matchAll(/data-command=["']([^"']+)["']/g)) {
        if (!declared.command.has(name)) report(path, index, `data-command ${name} is not a declared command`);
      }
      for (const [, name] of line.matchAll(/\b(?:mark|bind)\(\s*\w+(?:\.\w+|\([^)]*\))*\s*,\s*["']([^"']+)["']/g)) {
        if (!declared.command.has(name)) report(path, index, `${name} is bound to an element but is not a declared command`);
      }
      for (const [, name] of line.matchAll(/\b(?:run|command)\(\s*["']([^"']+)["']/g)) {
        if (!declared.command.has(name)) report(path, index, `${name} is run but is not a declared command`);
      }
      const domNames = [
        ...[...line.matchAll(/data-expose=["']([^"']+)["']/g)].map((m) => m[1]),
        ...[...line.matchAll(/[Ee]xpose\s*[:=]\s*["']([^"']+)["']/g)].map((m) => m[1]),
        ...(line.includes("dataset.expose") ? [...line.matchAll(quoted)].map((m) => m[1]) : []),
        ...[...line.matchAll(/(?:expose|context\.exposure)\.dom\(\s*["']([^"']+)["']/g)].map((m) => m[1]),
      ];
      // Some functions (act, field and others) take a name as an argument and attach it to an element, so a place where a declared dom name is written in quotes
      // counts as a marked place.
      for (const [, name] of line.matchAll(quoted)) if (declared.dom.has(name)) shown.add(name);
      for (const name of domNames) {
        if (name.includes("${")) continue;
        shown.add(name);
        if (!declared.dom.has(name)) report(path, index, `data-expose ${name} is not a declared dom entry`);
      }
    });
  }

  // 2. Registration and marking
  const all = sources.map((source) => source.text).join("\n") + registrations.join("\n");
  for (const name of declared.status) {
    if (!new RegExp(`status\\(\\s*"${name}"`).test(all)) errors.push(`${where}: status ${name} is declared but not registered`);
  }
  for (const name of declared.command) {
    if (!new RegExp(`(?:registry|expose)\\.command\\(\\s*"${name}"`).test(all)) errors.push(`${where}: command ${name} is declared but not registered`);
  }
  for (const name of declared.dom) {
    if (!shown.has(name)) errors.push(`${where}: dom ${name} is declared but no element carries it`);
  }
  return errors;
}
