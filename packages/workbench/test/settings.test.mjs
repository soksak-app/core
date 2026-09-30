import test from 'node:test';
import assert from 'node:assert/strict';
import { effectiveSettings } from '../settings-scope.js';

test('project values override common values and opening mode remains common-only', () => {
  const defaults = { gap:6, mode:'dark', projectOpening:'windows', links:[] };
  const common = { gap:8, mode:'light', projectOpening:'tabs' };
  const overrides = { gap:12, projectOpening:'windows' };
  assert.deepEqual(effectiveSettings(defaults,common,overrides), {gap:12,mode:'light',projectOpening:'tabs',links:[]});
  delete overrides.gap;
  assert.equal(effectiveSettings(defaults,common,overrides).gap,8);
  assert.equal(effectiveSettings(defaults,{},{}).projectOpening,'windows');
});

test('the performance trace flag is a declared boolean defaulting to false', async () => {
  const realDocument = globalThis.document;
  globalThis.document = { addEventListener: () => {}, documentElement: { dataset: {}, style: { setProperty() {} } } };
  const memory = { common: {}, projects: [] };
  const { connectSettings, set: change, value } = await import('../settings.js?test=performance-flag');
  try {
    await connectSettings({
      snapshot: async () => structuredClone(memory),
      settings: async (id, values) => { memory.common = { ...memory.common, ...values }; },
      onChange: () => () => {},
    });
    // 기본은 꺼짐 — 꺼진 상태가 성능 기록의 정상이다.
    assert.equal(value('diagnostics.performance'), false);
    await change({ 'diagnostics.performance': true }, 'common');
    assert.equal(memory.common['diagnostics.performance'], true);
    assert.equal(value('diagnostics.performance'), true);
    assert.throws(() => change({ 'diagnostics.performance': 'yes' }, 'common'),
      /Invalid setting diagnostics.performance/);
  } finally {
    globalThis.document = realDocument;
  }
});

test('a settings file change propagates the effective performance switch', async (t) => {
  const calls = [];
  t.mock.module('../performance.js', { exports: {
    setTraceEnabled: async (enabled) => { calls.push(enabled); },
    trace: () => {}, timed: async (_name, answer) => answer(),
  } });
  const previous = globalThis.document;
  globalThis.document = { addEventListener() {}, documentElement: { dataset: {}, style: { setProperty() {} } } };
  const memory = { common: {}, projects: [] };
  let changed;
  const { connectSettings } = await import('../settings.js?test=external-performance');
  try {
    await connectSettings({
      snapshot: async () => structuredClone(memory), settings: async () => {},
      onChange: (listener) => { changed = listener; },
    });
    memory.common['diagnostics.performance'] = true;
    await changed();
    assert.deepEqual(calls, [false, true], 'file changes did not propagate the effective switch');
  } finally {
    globalThis.document = previous;
  }
});
