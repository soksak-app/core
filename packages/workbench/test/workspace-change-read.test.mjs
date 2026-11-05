// A change of the store gives its listeners one read of the host: the two listeners of a window read what the change left with
// one call, and each receives a value of its own.
import assert from "node:assert/strict";
import { test } from "node:test";
import { HostWorkspaceStore } from "../host-store.js";

function hostOfStore() {
  const events = [];
  const calls = [];
  return {
    calls,
    change: () => { for (const event of events) event(); },
    on: (name, listener) => { assert.equal(name, "workspace-changed"); events.push(listener); },
    call: async (name, request) => {
      calls.push([name, request]);
      return { common: { gap: 1 }, projects: [{ id: "prj" }], open: [] };
    },
  };
}

test("the listeners of one change read the host once and each receives a value of its own", async () => {
  const host = hostOfStore();
  const store = new HostWorkspaceStore(host);
  const reads = [];
  store.onChange((read) => { reads.push(read()); });
  store.onChange((read) => { reads.push(read()); });
  host.change();
  const [first, second] = await Promise.all(reads);
  assert.equal(host.calls.length, 1, "one change reads the host once");
  assert.deepEqual(host.calls[0], ["workspace", { kind: "snapshot" }]);
  assert.deepEqual(first, second);
  assert.notEqual(first, second, "a listener that changes its value leaves the other one alone");
  assert.notEqual(first.projects, second.projects);
});

test("each change reads the host again, and a change that no listener reads calls nothing", async () => {
  const host = hostOfStore();
  const store = new HostWorkspaceStore(host);
  let reading = true;
  let last = null;
  store.onChange((read) => { if (reading) last = read(); });
  host.change();
  await last;
  host.change();
  await last;
  assert.equal(host.calls.length, 2, "a change after a read reads what that change left");
  reading = false;
  host.change();
  assert.equal(host.calls.length, 2, "a change that no listener reads calls nothing");
});

test("a listener that reads after the read of its change ended reads the host again", async () => {
  const host = hostOfStore();
  const store = new HostWorkspaceStore(host);
  let later = null;
  let first = null;
  store.onChange((read) => { later = read; });
  store.onChange((read) => { first = read(); });
  host.change();
  await first;
  await later();
  assert.equal(host.calls.length, 2, "a write can follow the call that ended, and this read must find it");
});

test("a listener that reads while the read of its change runs shares that call", async () => {
  const host = hostOfStore();
  const store = new HostWorkspaceStore(host);
  let later = null;
  store.onChange((read) => { later = read; });
  store.onChange((read) => { read(); });
  host.change();
  await later();
  assert.equal(host.calls.length, 1);
});
