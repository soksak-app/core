// Verifies that the cells of a markdown table row follow the GitHub Flavored Markdown table: an escaped pipe is a pipe of
// its cell, an unescaped pipe ends a cell also inside a code span, and a row without its closing pipe is an error.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tableCells } from '../markdown-table.mjs';

test('an escaped pipe is a pipe of its cell and the cells after it keep their places', () => {
  assert.deepEqual(tableCells('| `install.version.ranges-and-order` | a union `<range> \\|\\| <range>` contains what one part contains | all |'),
    ['`install.version.ranges-and-order`', 'a union `<range> || <range>` contains what one part contains', 'all']);
});

test('an unescaped pipe ends a cell also inside a code span, and an escaped backslash does not escape the pipe after it', () => {
  assert.deepEqual(tableCells('| `a | b` |'), ['`a', 'b`']);
  assert.deepEqual(tableCells('| a\\\\| b |'), ['a\\\\', 'b']);
  assert.deepEqual(tableCells('| a\\*b |'), ['a\\*b']);
});

test('the cells are trimmed, an empty cell is kept, and the spaces around the row are not cells', () => {
  assert.deepEqual(tableCells('  |  x  ||  y |  '), ['x', '', 'y']);
  assert.deepEqual(tableCells('| --- | :---: |'), ['---', ':---:']);
});

test('a row that does not start or end with an unescaped pipe is an error that names the row', () => {
  assert.throws(() => tableCells('a | b |'), /the table row does not start with \|: a \| b \|/);
  assert.throws(() => tableCells('| a | b'), /the table row does not end with \|: \| a \| b/);
  assert.throws(() => tableCells('| a | b \\|'), /the table row does not end with \|/);
});
