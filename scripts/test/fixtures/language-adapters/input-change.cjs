// Asserts the tested content of source.txt in the folder of the case, then changes the file during the run.
require('node:assert/strict').equal(require('node:fs').readFileSync('source.txt', 'utf8'), 'tested content');
require('node:fs').writeFileSync('source.txt', 'untested content');
console.log('PASS: input assertion');
