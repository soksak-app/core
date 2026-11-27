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

const settled = () => new Promise((resolve) => setImmediate(resolve));

test('a setting write that the host refuses restores the stored value in the store', async () => {
  const wire = selectPageWire('settings-refused-write');
  const { connectSettings, set: change, value } = await import('../settings.js?test=refused-write');
  const { orderedCallsAnswered } = await import('../host.js');
  await connectSettings(new HostWorkspaceStore(host));
  await orderedCallsAnswered();
  assert.equal(value('memorySaver'), true);
  const refused = change({ memorySaver: false }, 'common', 'test');
  await assert.rejects(refused, /the configuration directory is read-only/);
  await orderedCallsAnswered();
  assert.equal(value('memorySaver'), true, 'the store kept the value of the refused write');
  await new Promise((resolve) => setTimeout(resolve, 50));
  await orderedCallsAnswered();
  wire.finish();
});
