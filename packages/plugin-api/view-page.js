// The view page insertion of docs/spec/plugin-processes.md (rule 4). The native view handler of each host applies the same rule
// (sp_view_page_insert in native/darwin/src/document_view.m), and the shared cases of contract/view-page.json check both.

/** The doctype token that a view page begins with. */
const DOCTYPE = /^<!doctype[^>]*>/i;
/** A start tag of a script whose type is importmap, with its attributes in any order and quoted or unquoted. */
const IMPORT_MAP = /<script\b[^>]*\btype\s*=\s*["']?importmap\b/i;
/** The end of a script element, which would end the import map element early if it were in the map text. */
const SCRIPT_END = /<\/script/i;

/**
 * Returns the view page with the import map text map inserted directly after its doctype. A page that has no doctype at its
 * start, that already holds an import map, or whose map text is empty or ends a script element is refused with an error that
 * names the reason.
 */
export function insertViewImportMap(html, map) {
  const doctype = DOCTYPE.exec(html);
  if (doctype === null) throw new Error("view page has no doctype at its start");
  if (IMPORT_MAP.test(html)) throw new Error("view page has an import map");
  if (map === "") throw new Error("the view import map is empty");
  if (SCRIPT_END.test(map)) throw new Error("import map text ends a script element");
  return `${doctype[0]}<script type="importmap">${map}</script>${html.slice(doctype[0].length)}`;
}
