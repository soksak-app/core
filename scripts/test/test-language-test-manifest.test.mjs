import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { discoverLanguageCases } from '../language-test-adapters.mjs';

test('the committed language manifest declares one non-empty case for every supported language', async () => {
  const manifest = JSON.parse(await readFile(new URL('../language-test-cases.json', import.meta.url), 'utf8'));
  const cases = discoverLanguageCases(manifest);
  assert.deepEqual(cases.map(({ language }) => language).sort(), ['go', 'js-ts', 'objective-c', 'rust']);
  assert.ok(cases.every(({ command, args }) => command && Array.isArray(args)));
});
