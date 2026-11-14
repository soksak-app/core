import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { host, selectPageWire } from '@soksak/runtime';
import { HostWorkspaceStore } from '../host-store.js';
import { effectiveSettings } from '../settings-scope.js';

// The host calls of the settings are answered by the page-wire case of each test (docs/spec/cases/page-wire/README.md). A test selects its case
// before it imports a module that reads the host, and the settings module of a test is a copy of its own, so its state is new. The
// store of the settings is the store that the application uses over the host of the case. Each application of the settings sends the theme and
// then the menu language to the host in turn, so a test waits for the ordered calls before it goes on.
const dom = new JSDOM('<body></body>', { url: 'http://localhost/' });
globalThis.document = dom.window.document;
after(() => dom.window.close());

// The page starts with the default policy of the event log written, as the first application of the stored settings writes it. The policy
// module of the page keeps the policy that it wrote last, so the cases of the tests state the calls of a policy that differs from it. The page
// without an operation sink stores no first event of an operation; the test of the actor installs the sink that the log of the page installs.
const start = selectPageWire('settings-policy-start');
const { installOperationSink } = await import('../operations.js');
await import('../page-log.js');
installOperationSink(null);
const { setLogPolicy } = await import('../log-policy.js');
await setLogPolicy({});
start.finish();

/** Ends after the host calls that the page started in one turn were answered, as the notice of the host reaches the listeners in a turn of its own. */
const settled = () => new Promise((resolve) => setImmediate(resolve));
const isSettingsWrite = ({ name, payload }) => name === 'workspace' && payload.kind === 'settings';
const isSnapshot = ({ name, payload }) => name === 'workspace' && payload.kind === 'snapshot';
const settingsWrites = (wire) => wire.calls.filter(isSettingsWrite);
const logCalls = (wire) => wire.calls.filter(({ name }) => name === 'log');
const performanceActions = (wire) => wire.calls.filter(({ name }) => name === 'performance').map(({ payload }) => payload.action);
const ALL_ERROR = { lifecycle: 'error', input: 'error', call: 'error', io: 'error', frame: 'error' };

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
  const wire = selectPageWire('settings-performance-flag');
  const { connectSettings, set: change, value } = await import('../settings.js?test=performance-flag');
  const { orderedCallsAnswered } = await import('../host.js');
  await connectSettings(new HostWorkspaceStore(host));
  // The trace is off by default: no layer builds or stores a trace event until the debug switch turns it on (docs/spec/settings.md, the section of core.settings.debug).
  assert.equal(value('diagnostics.performance'), false);
  await change({ 'diagnostics.performance': false }, 'common', 'test');
  await orderedCallsAnswered();
  assert.equal(settingsWrites(wire)[0].payload.patch['diagnostics.performance'], false);
  assert.equal(value('diagnostics.performance'), false);
  assert.throws(() => change({ 'diagnostics.performance': 'yes' }, 'common', 'test'),
    /Invalid setting diagnostics.performance/);
  assert.deepEqual(performanceActions(wire), ['off'], 'the page reported the stored switch once');
  wire.finish();
});

test('the log policy is a declared object of levels for the classes, applied when the settings load and when it changes', async () => {
  const wire = selectPageWire('settings-log-policy');
  const { connectSettings, set: change, value } = await import('../settings.js?test=log-policy');
  const { orderedCallsAnswered } = await import('../host.js');
  const { logGate } = await import('../log-gate.js');
  await connectSettings(new HostWorkspaceStore(host));
  await orderedCallsAnswered();
  // The policy stores only errors by default: a class that the setting does not name stores the level error. The policy that the stored
  // settings give is in force in the gate of the page, and the host holds it already, so no call carries it.
  assert.deepEqual(value('diagnostics.log'), {});
  assert.deepEqual(logGate.classes(), ALL_ERROR);
  assert.deepEqual(logCalls(wire), []);
  await change({ 'diagnostics.log': { call: 'info' } }, 'common', 'test');
  await orderedCallsAnswered();
  // The policy of a change carries the cids of the change, the same cids that the write of the settings carries
  // (docs/spec/logging.md#policy). The case binds both to one identifier.
  const writes = settingsWrites(wire);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].payload.patch['diagnostics.log'], { call: 'info' });
  assert.ok(Array.isArray(writes[0].cids) && writes[0].cids.length > 0, `the write carries the cids ${JSON.stringify(writes[0].cids)}`);
  const applied = logCalls(wire).filter(({ payload }) => payload.cids !== undefined);
  assert.deepEqual(applied.map(({ payload }) => [payload.classes, payload.cids]),
    [[{ ...ALL_ERROR, call: 'info' }, writes[0].cids]]);
  for (const bad of [{ audio: 'off' }, { call: 'loud' }, 'off', null, []]) {
    assert.throws(() => change({ 'diagnostics.log': bad }, 'common', 'test'), /Invalid setting diagnostics.log/);
  }
  assert.deepEqual(value('diagnostics.log'), { call: 'info' });
  wire.finish();
});

test('a settings file change propagates the effective performance switch', async () => {
  const wire = selectPageWire('settings-external-performance');
  const { connectSettings } = await import('../settings.js?test=external-performance');
  const { orderedCallsAnswered } = await import('../host.js');
  await connectSettings(new HostWorkspaceStore(host));
  // The trace starts off by default, and a settings file that turns it on propagates the change.
  wire.deliverNotice();
  await settled();
  await orderedCallsAnswered();
  assert.deepEqual(performanceActions(wire), ['off', 'on'], 'file changes did not propagate the effective switch');
  wire.finish();
});

test('settings stored in an earlier form are refused with the file that holds them and are not written', async () => {
  const wire = selectPageWire('settings-earlier-form');
  const { connectSettings } = await import('../settings.js?test=removed-keys');
  await assert.rejects(connectSettings(new HostWorkspaceStore(host)),
    /^Error: settings\.json: unknown setting cardSidebar$/);
  const { beginSettings } = await import('../settings.js?test=removed-project-keys');
  assert.throws(() => beginSettings({ common: {}, projects: [{ id: 'prj-a', root: '/work/a', settings: { rail: 'flow' } }] }, 'prj-a'),
    /^Error: \/work\/a\/\.soksak\/settings\.json: unknown setting rail$/);
  assert.deepEqual(settingsWrites(wire), []);
  // A report of the page leaves in a batch of the call log; the case has no call of the log.
  assert.deepEqual(logCalls(wire), []);
  wire.finish();
});

test('stored settings of a plugin that is not loaded are kept and not applied', async () => {
  const wire = selectPageWire('settings-absent-plugin');
  const { connectSettings, set: change, value } = await import('../settings.js?test=absent-plugin');
  const { orderedCallsAnswered } = await import('../host.js');
  await connectSettings(new HostWorkspaceStore(host));
  await orderedCallsAnswered();
  assert.equal(value('gap'), 8);
  assert.equal(value('absent.option'), undefined, 'a setting of a plugin that is not loaded was applied');
  await change({ gap: 9 }, 'common', 'test');
  await orderedCallsAnswered();
  // The write names the key that changed and no key of the plugin that is not loaded, so the stored value of that key stays in the file,
  // and no write reaches the settings file of the project.
  assert.deepEqual(settingsWrites(wire).map(({ payload }) => payload), [{ kind: 'settings', id: null, patch: { gap: 9 }, remove: [] }]);
  assert.throws(() => change({ 'absent.option': 5 }, 'common', 'test'), /Unknown setting: absent.option/);
  wire.finish();
});

test('a settings file of the shown project that the host refuses is reported and the applied settings stay', async () => {
  const wire = selectPageWire('settings-refused-project-file');
  // The page reports the refusal as the error event of the document, which the window of this document receives.
  const reported = [];
  const listener = (event) => reported.push(event.message);
  dom.window.addEventListener('error', listener);
  const before = { dispatchEvent: globalThis.dispatchEvent, ErrorEvent: globalThis.ErrorEvent };
  globalThis.dispatchEvent = dom.window.dispatchEvent.bind(dom.window);
  globalThis.ErrorEvent = dom.window.ErrorEvent;
  try {
    const { beginSettings, connectSettings, value } = await import('../settings.js?test=refused-project-file');
    const { orderedCallsAnswered } = await import('../host.js');
    beginSettings({ common: { gap: 8 }, projects: [{ id: 'prj-a', root: '/work/a', settings: { gap: 12 } }] }, 'prj-a');
    await orderedCallsAnswered();
    await connectSettings(new HostWorkspaceStore(host));
    const error = '/work/a/.soksak/settings.json: settings.json: format must be 1';
    wire.deliverNotice();
    await settled();
    assert.deepEqual(reported, [error], 'the refused project settings file was not reported');
    assert.equal(value('gap'), 12, 'the refused file replaced the applied project settings');
    wire.finish();
  } finally {
    dom.window.removeEventListener('error', listener);
    for (const [name, original] of Object.entries(before)) {
      if (original === undefined) delete globalThis[name];
      else globalThis[name] = original;
    }
  }
});

test('the start document applies the common and project settings in the current format before the store connects', async () => {
  const wire = selectPageWire('settings-begin');
  const { beginSettings, value, settingProject } = await import('../settings.js?test=begin');
  const { orderedCallsAnswered } = await import('../host.js');
  beginSettings({ common: { gap: 8 }, projects: [{ id: 'prj-a', root: '/work/a', settings: { gap: 12 } }, { id: 'prj-b', root: '/work/b', settings: { gap: 4 } }] }, 'prj-a');
  assert.equal(value('gap'), 12, 'the project overrides were not applied');
  assert.throws(() => beginSettings({ common: { gap: 8, latency: 3 }, projects: [] }, null), /^Error: settings\.json: unknown setting latency$/);
  assert.equal(settingProject(), 'prj-a');
  assert.throws(() => beginSettings({ common: { unknownSetting: 1 }, projects: [] }, null), /settings\.json: unknown setting unknownSetting/);
  await orderedCallsAnswered();
  wire.finish();
});

test('stored and changed core setting values must have their declared form', async () => {
  const wire = selectPageWire('settings-core-values');
  const { beginSettings, connectSettings, set: change } = await import('../settings.js?test=core-values');
  const { orderedCallsAnswered } = await import('../host.js');
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
  // The first snapshot of the case holds the value gap wide, and the second holds no stored settings.
  await assert.rejects(connectSettings(new HostWorkspaceStore(host)), /Invalid setting gap: "wide"/);
  await connectSettings(new HostWorkspaceStore(host));
  for (const [key, value] of invalid) {
    assert.throws(() => change({ [key]: value }, 'common', 'test'), new RegExp(`Invalid setting ${key}`),
      `changing ${key} to ${JSON.stringify(value)} was accepted`);
  }
  beginSettings({ common: { gap: 0, radius: 24, size: 10, font: 'mono-jet', theme: 'slate', mode: 'light',
    projectOpening: 'tabs', projectTabs: 'left', focusInd: 'corner', fullRule: 'none', left: false, right: true, dim: true },
  projects: [] }, null);
  await orderedCallsAnswered();
  assert.deepEqual(settingsWrites(wire), [], 'a refused value was written');
  wire.finish();
});

test('a stored link to a set that does not exist is refused and not written', async () => {
  const wire = selectPageWire('settings-gone-sets');
  const { connectSettings } = await import('../settings.js?test=gone-sets');
  await assert.rejects(connectSettings(new HostWorkspaceStore(host)), /a right link requires a known set/);
  assert.deepEqual(settingsWrites(wire), []);
  assert.deepEqual(logCalls(wire), []);
  wire.finish();
});

// The host sets the window title bar from textSize of the common settings before the page starts, so the frame scale is common only
// (docs/spec/native-surfaces.md#title-bar-height).
test('the frame text factor is common-only', async () => {
  const wire = selectPageWire('settings-text-size-common');
  const { beginSettings, set: change } = await import('../settings.js?test=text-size-common');
  const { orderedCallsAnswered } = await import('../host.js');
  assert.throws(() => beginSettings({ common: {}, projects: [{ id: 'prj-a', settings: { textSize: 1.5 } }] }, 'prj-a'),
    /project settings: textSize is common-only/);
  beginSettings({ common: { textSize: 1.5 }, projects: [{ id: 'prj-a', settings: {} }] }, 'prj-a');
  assert.throws(() => change({ textSize: 2 }, 'project', 'test'), { message: 'textSize is common-only' });
  await orderedCallsAnswered();
  wire.finish();
});

// A project write of a common-only key fails with the message of the hosts, `<key> is common-only` (docs/spec/projects.md#persistence).
test('a project write of each common-only key fails with the message of the hosts', async () => {
  const wire = selectPageWire('settings-common-only-write');
  const { beginSettings, set: change } = await import('../settings.js?test=common-only-write');
  const { orderedCallsAnswered } = await import('../host.js');
  beginSettings({ common: {}, projects: [{ id: 'prj-a', settings: {} }] }, 'prj-a');
  for (const [key, value] of [['projectOpening', 'tabs'], ['textSize', 2], ['memorySaver', false], ['memorySaverDelay', 30]]) {
    assert.throws(() => change({ [key]: value }, 'project', 'test'), { message: `${key} is common-only` });
  }
  await orderedCallsAnswered();
  wire.finish();
});

// The memory saver settings are common-only, memorySaver is a boolean defaulting to true and memorySaverDelay an integer
// from 5 to 720 minutes defaulting to 120 (docs/spec/settings.md#values).
test('the memory saver settings are common-only with their defaults and ranges', async () => {
  const wire = selectPageWire('settings-memory-saver');
  const { beginSettings, set: change, value } = await import('../settings.js?test=memory-saver');
  const { orderedCallsAnswered } = await import('../host.js');
  beginSettings({ common: {}, projects: [{ id: 'prj-a', settings: {} }] }, 'prj-a');
  assert.equal(value('memorySaver'), true);
  assert.equal(value('memorySaverDelay'), 120);
  assert.throws(() => beginSettings({ common: {}, projects: [{ id: 'prj-a', settings: { memorySaverDelay: 10 } }] }, 'prj-a'),
    /project settings: memorySaverDelay is common-only/);
  beginSettings({ common: {}, projects: [{ id: 'prj-a', settings: {} }] }, 'prj-a');
  assert.throws(() => change({ memorySaver: false }, 'project', 'test'), /memorySaver is common-only/);
  for (const delay of [4, 721, 7.5, '60']) {
    assert.throws(() => change({ memorySaverDelay: delay }, 'common', 'test'),
      { message: `Invalid setting memorySaverDelay: ${JSON.stringify(delay)}` });
  }
  assert.throws(() => change({ memorySaver: 'on' }, 'common', 'test'), /Invalid setting memorySaver: "on" is not a boolean/);
  await orderedCallsAnswered();
  wire.finish();
});

test('a change of the settings names its actor and its keys, and its identifiers go with the write', async () => {
  const wire = selectPageWire('settings-actor');
  const { installOperationSink } = await import('../operations.js');
  const { emitEvent, flushEvents, recordWorkbenchStart } = await import('../page-log.js');
  const { logGate } = await import('../log-gate.js');
  const { connectSettings, set: change, reset } = await import('../settings.js?test=actor');
  const { orderedCallsAnswered } = await import('../host.js');
  // The sink of the log of the page: it stores the first event of an operation with its identifiers, as page-log.js installs it.
  installOperationSink((event, fields, cids) => emitEvent('info', event, fields, cids));
  try {
    await connectSettings(new HostWorkspaceStore(host));
    await orderedCallsAnswered();
    // The first batch of the page anchors its clock with the clocks of the host, so the batch of the change that follows carries no clock call. The record
    // of the start of the page is that first batch.
    recordWorkbenchStart({ href: 'http://localhost/' }, 1);
    await flushEvents();
    // The policy of the gate stores the event of the operation: its class is call, at the level info.
    logGate.set({ ...logGate.classes(), call: 'info' });
    await change({ gap: 9, radius: 3 }, 'common', 'core.settings.set');
    await orderedCallsAnswered();
    await flushEvents();
    const operations = () => wire.calls
      .filter(({ name, payload }) => name === 'log' && payload.action === 'batch')
      .flatMap(({ payload }) => payload.events)
      .filter(({ event }) => event === 'workbench.settings.change');
    assert.deepEqual(operations().map(({ level, event, fields }) => [level, event, fields]), [
      ['info', 'workbench.settings.change', { scope: 'common', actor: 'core.settings.set', keys: 'gap,radius' }],
    ]);
    const writes = settingsWrites(wire);
    assert.deepEqual(writes.map(({ payload, cids }) => [payload.id, payload.patch, cids]), [[null, { gap: 9, radius: 3 }, operations()[0].cids]]);
    assert.throws(() => change({ gap: 10 }, 'common'), /set requires the actor that changes the settings/);
    assert.throws(() => change({ gap: 10 }, 'common', ''), /set requires the actor that changes the settings/);
    assert.equal(operations().length, 1, 'a refused change started an operation');
    assert.throws(() => reset('gap'), /set requires the actor|No project is selected/);
    wire.finish();
  } finally {
    installOperationSink(null);
  }
});

test('the debug switch sets the trace and every class to trace, and off restores the defaults', async () => {
  const wire = selectPageWire('settings-debug-switch');
  const { connectSettings, set: change, setDebug, debugOn, value } = await import('../settings.js?test=debug-switch');
  const { orderedCallsAnswered } = await import('../host.js');
  await connectSettings(new HostWorkspaceStore(host));
  await orderedCallsAnswered();
  assert.equal(debugOn(), false);
  await setDebug(true, 'core.settings.debug');
  await orderedCallsAnswered();
  const [on] = settingsWrites(wire);
  assert.equal(on.payload.patch['diagnostics.performance'], true);
  assert.deepEqual(on.payload.patch['diagnostics.log'], { lifecycle: 'trace', input: 'trace', call: 'trace', io: 'trace', frame: 'trace' });
  assert.equal(debugOn(), true);
  await setDebug(false, 'core.settings.debug');
  await orderedCallsAnswered();
  const [, off] = settingsWrites(wire);
  assert.equal(off.payload.patch['diagnostics.performance'], false);
  assert.deepEqual(off.payload.patch['diagnostics.log'], {});
  assert.equal(value('diagnostics.performance'), false);
  assert.equal(debugOn(), false);
  // A policy that names only some classes at trace is not the debug state, because the switch shows on only when every class is trace.
  await change({ 'diagnostics.performance': true, 'diagnostics.log': { call: 'trace' } }, 'common', 'test');
  await orderedCallsAnswered();
  assert.equal(debugOn(), false);
  wire.finish();
});

test('a change of the store is read through the read of that change', async () => {
  const wire = selectPageWire('settings-change-read');
  const { connectSettings, value } = await import('../settings.js?test=change-read');
  const { orderedCallsAnswered } = await import('../host.js');
  const store = new HostWorkspaceStore(host);
  await connectSettings(store);
  await orderedCallsAnswered();
  // The registry of a window listens to the same notice and reads through the same read: the listeners that read while one call runs share it.
  store.onChange((read) => { read(); });
  const before = wire.calls.filter(isSnapshot).length;
  wire.deliverNotice();
  await settled();
  await orderedCallsAnswered();
  assert.equal(wire.calls.filter(isSnapshot).length - before, 1, 'the settings read the store once more for the change, besides the shared read of the change');
  assert.equal(value('gap'), 9);
  wire.finish();
});
