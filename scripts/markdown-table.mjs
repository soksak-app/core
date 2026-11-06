// Reads the cells of a row of a markdown table by the rule of the GitHub Flavored Markdown table: a cell ends at a `|`
// that no backslash escapes, also inside a code span, and `\|` is a `|` of the cell. The checks that read the tables of
// the documents read their rows only through this function, so a cell that holds a pipe, such as the union `<range> \|\| <range>`
// of a version range, is one cell in every check as it is on the rendered page.

/**
 * The cells of the table row `line`, trimmed, without the pipes that open and close the row. A backslash keeps the
 * character after it in the cell, and `\|` becomes `|`; the other escapes stay as written. A row that does not start and
 * end with a `|` that no backslash escapes is an error that names the row.
 */
export function tableCells(line) {
  const row = line.trim();
  if (!row.startsWith('|')) throw new Error(`the table row does not start with |: ${row.slice(0, 80)}`);
  const cells = [];
  let cell = '';
  for (let index = 1; index < row.length; index++) {
    const character = row[index];
    if (character === '\\' && index + 1 < row.length) {
      cell += row[index + 1] === '|' ? '|' : row.slice(index, index + 2);
      index++;
    } else if (character === '|') {
      cells.push(cell.trim());
      cell = '';
    } else cell += character;
  }
  if (cell.trim() !== '') throw new Error(`the table row does not end with |: ${row.slice(0, 80)}`);
  return cells;
}
