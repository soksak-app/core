// The module graph rule of a view page (docs/spec/plugins.md#view-surfaces): every module that the page loads imports bare
// specifiers only from the view import map. The page check of view-check.js compares the map itself and does not read the modules,
// so an import outside the map (which stops the whole graph before any module runs) passes that check.
// The imports are read by es-module-lexer, which lexes code: a string literal or a comment of a minified bundle is not an import.
// A regular expression reads the text of a string literal as an import (ui/vendor/libraries.js of the editor holds the text
// "import export from" in a keyword list), so the rule does not use one.
import { parse } from "es-module-lexer/js";
import { viewImports } from "./index.js";

/** Reports whether a bare specifier is one of the declared import map entries: exact key or slash-terminated prefix. */
function isMapped(specifier, imports) {
  return Object.keys(imports).some((key) => (key.endsWith("/") ? specifier.startsWith(key) : specifier === key));
}

/**
 * Returns the errors of the module graph of a view page, from the module entry. read(path) returns the text of a module of the
 * page, with paths relative to the page folder, or null when the module does not exist. Each static import, re-export and dynamic
 * import with a literal specifier is read: a relative one is followed, and a bare one must be in the view import map. A dynamic
 * import whose specifier is not literal (a non-literal argument, or a template with a substitution) is not read. An error names
 * the importing module and the specifier. A module whose imports the lexer rejects is an error that names the module.
 */
export function checkViewModules(read, entry, { diagnostics = false } = {}) {
  if (typeof diagnostics !== "boolean") throw new TypeError("checkViewModules diagnostics must be a boolean");
  const allowedImports = viewImports({ diagnostics });
  const errors = [];
  const seen = new Set();
  const pending = [entry];
  while (pending.length > 0) {
    const path = pending.shift();
    if (seen.has(path)) continue;
    seen.add(path);
    const text = read(path);
    if (text === null) continue;
    let imports;
    try {
      [imports] = parse(text, path);
    } catch (error) {
      errors.push(`${path}: the imports of the module cannot be read: ${error.message}`);
      continue;
    }
    for (const entryImport of imports) {
      // The specifier is undefined for an import.meta reference and for a dynamic import of a non-literal argument. A glob is a
      // template with a substitution, so its specifier is not a literal.
      if (entryImport.specifier === undefined || entryImport.specifier === null || entryImport.glob) continue;
      const specifier = entryImport.specifier;
      if (specifier.startsWith("./") || specifier.startsWith("../")) {
        const target = resolveRelative(path, specifier);
        if (read(target) === null) errors.push(`${path}: module ${target} does not exist`);
        else pending.push(target);
      } else if (!isMapped(specifier, allowedImports)) {
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
