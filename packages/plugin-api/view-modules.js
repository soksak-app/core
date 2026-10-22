// The module graph rule of a view page (docs/spec/plugins.md#view-surfaces): every module that the page loads imports bare
// specifiers only from the view import map. The page check of view-check.js compares the map itself and does not read the modules,
// so an import outside the map (which stops the whole graph before any module runs) passes that check.
import { VIEW_IMPORTS } from "./index.js";

/** Removes block comments and line comments, so an import named in a comment is not read. A `//` after `:` is part of a URL. */
function withoutComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

/** Reports whether a bare specifier is one of the import map entries: an exact key, or a key with a trailing slash as a prefix. */
function isMapped(specifier) {
  return Object.keys(VIEW_IMPORTS).some((key) => (key.endsWith("/") ? specifier.startsWith(key) : specifier === key));
}

/**
 * Returns the errors of the module graph of a view page, from the module entry. read(path) returns the text of a module of the
 * page, with paths relative to the page folder, or null when the module does not exist. Each static import, re-export and dynamic
 * import with a literal specifier is read: a relative one is followed, and a bare one must be in the view import map. An error
 * names the importing module and the specifier.
 */
export function checkViewModules(read, entry) {
  const errors = [];
  const seen = new Set();
  const pending = [entry];
  const pattern = /(?:import|export)\s[^'"`;]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|import\s*["']([^"']+)["']/g;
  while (pending.length > 0) {
    const path = pending.shift();
    if (seen.has(path)) continue;
    seen.add(path);
    const text = read(path);
    if (text === null) continue;
    for (const match of withoutComments(text).matchAll(pattern)) {
      const specifier = match[1] ?? match[2] ?? match[3];
      if (specifier.startsWith("./") || specifier.startsWith("../")) {
        const target = resolveRelative(path, specifier);
        if (read(target) === null) errors.push(`${path}: module ${target} does not exist`);
        else pending.push(target);
      } else if (!isMapped(specifier)) {
        errors.push(`${path}: import ${specifier} is not in the view import map`);
      }
    }
  }
  return errors;
}

/** The path of a relative specifier from the module that imports it, with the folder of that module as its base. */
function resolveRelative(from, specifier) {
  const parts = from.split("/").slice(0, -1);
  for (const part of specifier.split("/")) {
    if (part === "." || part === "") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}
