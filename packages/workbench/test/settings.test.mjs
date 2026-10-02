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

test('settings stored under removed keys are deleted once when the settings are connected', async (t) => {
  const reports = [];
  t.mock.module('../host.js', { namedExports: {
    surfaces: { theme() {}, menuLanguage() {} }, log: (line) => { reports.push(line); },
  } });
  const previous = globalThis.document;
  globalThis.document = { addEventListener() {}, documentElement: { dataset: {}, style: { setProperty() {} } } };
  const memory = {
    common: { gap: 8, cardSidebar: 'inset', railWidth: 190 },
    projects: [{ id: 'prj-a', settings: { rail: 'flow', mode: 'light' } }, { id: 'prj-b' }],
  };
  const writes = [];
  const { connectSettings, value } = await import('../settings.js?test=removed-keys');
  try {
    await connectSettings({
      snapshot: async () => structuredClone(memory),
      settings: async (id, values) => {
        writes.push([id, values]);
        const target = id === null ? memory.common : memory.projects.find((p) => p.id === id).settings;
        for (const [key, val] of Object.entries(values)) {
          if (val === undefined) delete target[key];
          else target[key] = val;
        }
      },
      onChange: () => () => {},
    });
    assert.deepEqual(memory.common, { gap: 8 });
    assert.deepEqual(memory.projects[0].settings, { mode: 'light' });
    assert.deepEqual(writes.map(([id, values]) => [id, Object.keys(values)]), [[null, ['cardSidebar', 'railWidth']], ['prj-a', ['rail']]]);
    assert.deepEqual(reports, [
      'settings: converted the common settings: removed cardSidebar, railWidth because they are no longer settings',
      'settings: converted the project prj-a settings: removed rail because they are no longer settings',
    ]);
    assert.equal(value('gap'), 8);
  } finally {
    globalThis.document = previous;
  }
});

test('stored settings of a plugin that is not loaded are kept and not applied', async () => {
  const previous = globalThis.document;
  globalThis.document = { addEventListener() {}, documentElement: { dataset: {}, style: { setProperty() {} } } };
  const memory = { common: { gap: 8, 'absent.option': 3 }, projects: [{ id: 'prj-a', settings: { 'absent.option': 4 } }] };
  const { connectSettings, set: change, value } = await import('../settings.js?test=absent-plugin');
  try {
    await connectSettings({
      snapshot: async () => structuredClone(memory),
      settings: async (id, values) => {
        const target = id === null ? memory.common : memory.projects.find((p) => p.id === id).settings;
        for (const [key, val] of Object.entries(values)) {
          if (val === undefined) delete target[key];
          else target[key] = val;
        }
      },
      onChange: () => () => {},
    });
    assert.equal(value('gap'), 8);
    assert.equal(value('absent.option'), undefined, 'a setting of a plugin that is not loaded was applied');
    await change({ gap: 9 }, 'common');
    assert.deepEqual(memory.common, { gap: 9, 'absent.option': 3 });
    assert.deepEqual(memory.projects[0].settings, { 'absent.option': 4 });
    assert.throws(() => change({ 'absent.option': 5 }, 'common'), /Unknown setting: absent.option/);
  } finally {
    globalThis.document = previous;
  }
});

test('the start document applies the common and project settings in the current format before the store connects', async () => {
  const realDocument = globalThis.document;
  globalThis.document = { addEventListener: () => {}, documentElement: { dataset: {}, style: { setProperty() {} } } };
  const { beginSettings, value, settingProject } = await import('../settings.js?test=begin');
  try {
    beginSettings({ common: { gap: 8, latency: 3 }, projects: [{ id: 'prj-a', settings: { gap: 12 } }, { id: 'prj-b', settings: { gap: 4 } }] }, 'prj-a');
    assert.equal(value('gap'), 12, 'the project overrides were not applied');
    assert.equal(value('latency'), undefined, 'a removed key of the stored format was applied');
    assert.equal(settingProject(), 'prj-a');
    assert.throws(() => beginSettings({ common: { unknownSetting: 1 }, projects: [] }, null), /unknown setting unknownSetting/);
  } finally {
    globalThis.document = realDocument;
  }
});

test('stored and changed core setting values must have their declared form', async () => {
  const realDocument = globalThis.document;
  globalThis.document = { addEventListener: () => {}, documentElement: { dataset: {}, style: { setProperty() {} } } };
  const { beginSettings, connectSettings, set: change } = await import('../settings.js?test=core-values');
  try {
    const invalid = [
      ['gap', 'wide'], ['gap', 25], ['radius', 1.5], ['size', 9], ['font', 'serif'], ['theme', 'neon'], ['mode', 'dim'],
      ['projectOpening', 'tab'], ['projectTabs', 'right'], ['focusInd', 'glow'], ['fullRule', 'both'],
      ['left', 'yes'], ['right', 1], ['dim', null],
    ];
    for (const [key, stored] of invalid) {
      const pattern = new RegExp(`Invalid setting ${key}: ${JSON.stringify(stored)}`);
      assert.throws(() => beginSettings({ common: { [key]: stored }, projects: [] }, null), pattern,
        `reading ${key} ${JSON.stringify(stored)} was accepted`);
    }
    await assert.rejects(connectSettings({
      snapshot: async () => ({ common: { gap: 'wide' }, projects: [] }), settings: async () => {}, onChange: () => () => {},
    }), /Invalid setting gap: "wide"/);
    await connectSettings({
      snapshot: async () => ({ common: {}, projects: [] }), settings: async () => {}, onChange: () => () => {},
    });
    for (const [key, value] of invalid) {
      assert.throws(() => change({ [key]: value }, 'common'), new RegExp(`Invalid setting ${key}`),
        `changing ${key} to ${JSON.stringify(value)} was accepted`);
    }
    beginSettings({ common: { gap: 0, radius: 24, size: 10, font: 'mono-jet', theme: 'slate', mode: 'light',
      projectOpening: 'tabs', projectTabs: 'left', focusInd: 'corner', fullRule: 'none', left: false, right: true, dim: true },
    projects: [] }, null);
  } finally {
    globalThis.document = realDocument;
  }
});
