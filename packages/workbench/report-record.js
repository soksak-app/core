// The record that the page sends to the host through the host call `report` (docs/spec/diagnostics.md#forms). The start
// document imports this module before any other module of the page, so it imports nothing.

/**
 * Makes a record of a line of the workbench: a line is `<where>: <text>`, and a line without `: ` has the place `workbench` and
 * the whole line as its text. The host writes the record as `<time> <level> workbench <where>: <text>`.
 */
export function recordOf(level, line) {
  const text = String(line);
  const at = text.indexOf(": ");
  return at > 0 && !text.slice(0, at).includes("\n")
    ? { level, where: text.slice(0, at), text: text.slice(at + 2) }
    : { level, where: "workbench", text };
}
