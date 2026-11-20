import assert from "node:assert/strict";
import test from "node:test";
import { windows } from "../runtime/windows.js";

// A fixture that stands in for the browser global object. It records the opened addresses.
function browserGlobals(allowed = true) {
  const opened = [];
  globalThis.location = new URL("https://example.test/index.html?project=old");
  globalThis.window = { open: (url, name) => { opened.push([String(url), name]); return allowed ? {} : null; } };
  return opened;
}

test("the browser runtime identifies a folder by its trimmed path and creates no folders", async () => {
  assert.deepEqual(await windows.folder("  /work/a "), { root: "/work/a", identity: "path:/work/a" });
  assert.equal(windows.createsFolders, false);
  await assert.rejects(windows.createFolder({ parent: "/", name: "x" }), /cannot create folders/);
  await assert.rejects(windows.chooseFolder(), /cannot choose folders/);
  assert.equal(await windows.state(), null);
});

test("a separate project opens in another tab only when this tab shows a different project", async () => {
  const opened = browserGlobals();
  assert.deepEqual(await windows.openProject({ id: "p1", separate: false, current: "p0" }), { local: true, staged: false });
  assert.deepEqual(await windows.openProject({ id: "p1", separate: true, current: null }), { local: true, staged: false });
  assert.deepEqual(await windows.openProject({ id: "p1", separate: true, current: "p1" }), { local: true, staged: false });
  assert.deepEqual(opened, []);
  assert.deepEqual(await windows.openProject({ id: "p1", separate: true, current: "p0" }), { local: false, staged: false });
  assert.deepEqual(opened, [["https://example.test/index.html?project=p1", "soksak-p1"]]);
});

test("a blocked tab fails the request", async () => {
  browserGlobals(false);
  await assert.rejects(windows.openProject({ id: "p1", separate: true, current: "p0" }), /blocked the project window/);
  assert.throws(() => windows.newWindow(), /blocked the new window/);
});

test("the tab holds the record of the activities of its projects and sends it at ready, at each change and at a release", async () => {
  const sent = [];
  await windows.onProjectActivity((record) => sent.push(record));
  await windows.ready();
  assert.deepEqual(sent, [{ revision: 0, projects: {} }]);
  const spaces = { s1: { activity: "failed", cards: { "card-1": "failed" }, groups: {} } };
  await windows.projectActivity({ id: "p1", spaces });
  assert.deepEqual(sent.at(-1), { revision: 1, projects: { p1: { activity: "failed", spaces } } });
  await windows.projectActivity({ id: "p1", spaces });
  assert.equal(sent.length, 2, "an unchanged publication sends nothing");
  await assert.rejects(windows.projectActivity({ id: "p1", spaces: { s1: { activity: "busy", cards: {}, groups: {} } } }),
    /project p1 space s1: activity "busy" is not one of attention, failed, running, idle/);
  await windows.releaseProject("p1");
  assert.deepEqual(sent.at(-1), { revision: 2, projects: {} });
});
