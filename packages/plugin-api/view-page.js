// The view page rules of docs/spec/plugin-processes.md (rule 4). The host inserts the view import map into each view page, so a
// plugin page holds no map of its own. The native view handler of each host applies the same insertion
// (sp_view_page_insert in native/darwin/src/document_view.m), and the shared cases of contract/view-page.json check both.

/** The doctype token that a view page begins with. */
const DOCTYPE = /^<!doctype[^>]*>/i;
/** A start tag of a script whose type is importmap, with its attributes in any order and quoted or unquoted. */
const IMPORT_MAP = /<script\b[^>]*\btype\s*=\s*["']?importmap\b/i;
/** The end of a script element, which would end the import map element early if it were in the map text. */
const SCRIPT_END = /<\/script/i;

/**
 * Checks a view page that a plugin ships: it begins with a doctype and holds no import map. Throws an error that names the
 * reason when the page does not meet the rule.
 */
export function checkViewPage(html) {
  if (DOCTYPE.exec(html) === null) throw new Error("view page has no doctype at its start");
  if (IMPORT_MAP.test(html)) throw new Error("view page has an import map");
}

/**
 * Returns the view page with the import map text map inserted directly after its doctype. A page that does not meet checkViewPage
 * is refused, and so is a map text that is empty or ends a script element.
 */
export function insertViewImportMap(html, map) {
  checkViewPage(html);
  if (map === "") throw new Error("the view import map is empty");
  if (SCRIPT_END.test(map)) throw new Error("import map text ends a script element");
  const doctype = DOCTYPE.exec(html)[0];
  return `${doctype}<script type="importmap">${map}</script>${html.slice(doctype.length)}`;
}
