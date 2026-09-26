import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { DEFAULT_TIMEOUT_MS, discoverLanguageCases } from '../language-test-adapters.mjs';
import { auditExecutableLanguageCoverage, repositoryFiles } from '../check-test-parity.mjs';

test('the committed language manifest declares one non-empty case for every supported language', async () => {
  const manifest = JSON.parse(await readFile(new URL('../language-test-cases.json', import.meta.url), 'utf8'));
  const cases = discoverLanguageCases(manifest);
  assert.deepEqual(cases.map(({ language }) => language).sort(), Object.keys(DEFAULT_TIMEOUT_MS).filter((language) => language !== 'application').sort());
  assert.ok(cases.every(({ command, args }) => command && Array.isArray(args)));
});

test('the language manifest covers every executable implementation language in the repository', async () => {
  const manifest = JSON.parse(await readFile(new URL('../language-test-cases.json', import.meta.url), 'utf8'));
  const cases = discoverLanguageCases(manifest);
  assert.deepEqual(auditExecutableLanguageCoverage(repositoryFiles(), cases.map(({ language }) => language)), [],
    'each executable source language must have an adapter case, and the manifest must not claim absent languages');
});
