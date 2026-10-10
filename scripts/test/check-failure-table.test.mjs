import assert from 'node:assert/strict';
import test from 'node:test';

import { failureSites, failureTable, recordsMissingFromTable, trackedFailureSites } from '../check-failure-table.mjs';
import { readFileSync } from 'node:fs';

const GO = 'packages/host/wailsv3/src/example.go';
const RUST = 'packages/host/tauriv2/src/example.rs';
const NATIVE = 'native/darwin/src/example.m';

test('the place of an error record is the literal text of the first argument, cut at the part that the call fills in', () => {
  const sources = new Map([
    [GO, [
      'LogError("endpoint timeout", err)',
      'LogError("sidecar "+name, "failed")',
      'LogError(fmt.Sprintf("sidecar %s reconnection reconfigure", sidecar), err)',
      'LogError(StartDocumentPath, err)',
    ].join('\n')],
    [RUST, [
      'log_error("endpoint accept", error);',
      'log_failure(\n    "window close",\n    result,\n);',
      'crate::application_log::log_error(\n    &format!("sidecar {name}"),\n    text,\n);',
      'log_error(&place, error);',
    ].join('\n')],
    [NATIVE, 'sp_log_error("webview input", "send was refused");\nsp_log_error("capture", message.UTF8String);'],
    ['packages/workbench/page.js', 'report("page: not a host source")'],
  ]);
  assert.deepEqual(failureSites(sources).map(({ layer, place, filled }) => [layer, place, filled]), [
    ['host', 'endpoint timeout', false],
    ['host', 'sidecar', true],
    ['host', 'sidecar', true],
    ['host', 'endpoint accept', false],
    ['host', 'window close', false],
    ['host', 'sidecar', true],
    ['native', 'webview input', false],
    ['native', 'capture', false],
  ]);
});

test('a record is missing from the table when the table does not write it with its layer and place', () => {
  const sites = failureSites(new Map([
    [GO, 'LogError("endpoint", a)\nLogError("endpoint timeout", b)\nLogError("sidecar "+name, c)\nLogError("image frame", d)'],
    [NATIVE, 'sp_log_error("document view", e)'],
  ]));
  const table = [
    '| a | `error host endpoint timeout: <method>: <message>` and `error host image frame: ...` |',
    '| b | `error host sidecar <name>: failed: <reason>` |',
  ].join('\n');
  // `endpoint` is not written by `endpoint timeout`, and the layer of `document view` is native.
  assert.deepEqual(recordsMissingFromTable(sites, table), ['error host endpoint', 'error native document view']);
  assert.deepEqual(recordsMissingFromTable(sites, `${table}\n| c | \`error host endpoint\`, \`error native document view: x\` |`), []);
  // A place that the call fills in is written with a placeholder after it.
  assert.deepEqual(recordsMissingFromTable(failureSites(new Map([[GO, 'LogError("image notAttached "+name, e)']])), '`error host image notAttached: x`'),
    ['error host image notAttached <']);
});

test('every error record that a host or the native library writes at a literal place is in the failure table of the diagnostics', () => {
  const diagnostics = readFileSync(new URL('../../docs/spec/diagnostics.md', import.meta.url), 'utf8');
  const korean = readFileSync(new URL('../../docs/spec/diagnostics.ko.md', import.meta.url), 'utf8');
  assert.deepEqual(recordsMissingFromTable(trackedFailureSites(), failureTable(diagnostics)), []);
  assert.deepEqual(recordsMissingFromTable(trackedFailureSites(), failureTable(korean)), []);
});
