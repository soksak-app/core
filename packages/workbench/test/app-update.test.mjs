// The application update state and operation of the plugin screen (docs/spec/installation.md#application-update).
import test from "node:test";
import assert from "node:assert/strict";
import { createAppUpdate, releasePage } from "../app-update.js";

const available = {
  version: "0.0.9",
  release: { url: "https://github.com/soksak-app/core/releases/download/v0.0.9/soksak-0.0.9-darwin-arm64-wailsv3.zip", sha256: "0".repeat(64) },
};

/** A host whose calls are answered by `replies` and recorded in `calls`. */
function fakeHost(replies) {
  const calls = [];
  return {
    calls,
    async call(name, params) {
      calls.push([name, params ?? null]);
      const reply = replies[name];
      if (reply instanceof Error) throw reply;
      return reply;
    },
  };
}

test("the release page of a version is derived from the release URL of a published release only", () => {
  assert.equal(releasePage(available.release.url), "https://github.com/soksak-app/core/releases/tag/v0.0.9");
  assert.equal(releasePage("file:///releases/soksak-0.0.9.zip"), null);
  assert.equal(releasePage("https://example.org/files/soksak-0.0.9.zip"), null);
});

test("the status names the running version, the candidate with its release page and no operation", async () => {
  const host = fakeHost({ appUpdateState: { version: "0.0.8", available } });
  let changes = 0;
  const update = createAppUpdate({ host, changed: () => { changes += 1; } });
  assert.deepEqual(update.status(), { version: null, available: null, operation: null, error: null, incompatible: [] });
  await update.refresh();
  assert.deepEqual(update.status(), {
    version: "0.0.8",
    available: { version: "0.0.9", release: "https://github.com/soksak-app/core/releases/tag/v0.0.9" },
    operation: null,
    error: null,
    incompatible: [],
  });
  assert.equal(changes, 1);
});

test("a state that cannot be read is the error of the status and leaves no candidate", async () => {
  const host = fakeHost({ appUpdateState: new Error("registry: unreachable") });
  const update = createAppUpdate({ host, changed: () => {} });
  await update.refresh();
  assert.deepEqual(update.status(), { version: null, available: null, operation: null, error: "registry: unreachable", incompatible: [] });
});

test("updating stages the candidate, then applies the staged bundle, and reports each step", async () => {
  const host = fakeHost({ appUpdateState: { version: "0.0.8", available }, appUpdateStage: { bundle: "/config/updates/0.0.9/soksak.app" }, appUpdateApply: null });
  const steps = [];
  const update = createAppUpdate({ host, changed: () => { steps.push(update.status().operation?.state ?? null); } });
  await update.refresh();
  await update.update();
  assert.deepEqual(host.calls.slice(1), [
    ["appUpdateStage", { version: "0.0.9" }],
    ["appUpdateApply", { bundle: "/config/updates/0.0.9/soksak.app" }],
  ]);
  assert.deepEqual(steps, [null, "staging", "applying"]);
});

test("a failed step is the error of the operation and stops the update", async () => {
  const host = fakeHost({ appUpdateState: { version: "0.0.8", available }, appUpdateStage: new Error("application update: sha256 differs"), appUpdateApply: null });
  const update = createAppUpdate({ host, changed: () => {} });
  await update.refresh();
  await assert.rejects(update.update(), /sha256 differs/);
  assert.deepEqual(update.status().operation, { state: "failed", version: "0.0.9", error: "application update: sha256 differs" });
  assert.equal(host.calls.some(([name]) => name === "appUpdateApply"), false);
});

test("updating without a candidate fails before any host call", async () => {
  const host = fakeHost({ appUpdateState: { version: "0.0.9", available: null } });
  const update = createAppUpdate({ host, changed: () => {} });
  await update.refresh();
  await assert.rejects(update.update(), /no application update is available/);
  assert.equal(host.calls.length, 1);
});

test("opening the release page asks the host to open the page of the candidate and fails without one", async () => {
  const host = fakeHost({ appUpdateState: { version: "0.0.8", available }, linkOpen: null });
  const update = createAppUpdate({ host, changed: () => {} });
  await update.refresh();
  await update.openRelease();
  assert.deepEqual(host.calls.at(-1), ["linkOpen", { url: "https://github.com/soksak-app/core/releases/tag/v0.0.9" }]);
  const local = fakeHost({ appUpdateState: { version: "0.0.8", available: { ...available, release: { ...available.release, url: "file:///releases/soksak.zip" } } } });
  const other = createAppUpdate({ host: local, changed: () => {} });
  await other.refresh();
  await assert.rejects(other.openRelease(), /no release page/);
});

/** A plugin state whose index lists plugin versions with their `engines.soksak` ranges. */
const pluginState = {
  index: {
    plugins: [
      { id: "term", versions: [{ version: "0.1.0", engines: { soksak: "*" } }, { version: "0.2.0", engines: { soksak: "^0.0.8" } }, { version: "0.3.0", engines: { soksak: ">=0.0.9" } }, { version: "0.4.0", engines: { soksak: ">=0.0.9" } }] },
      { id: "notes", versions: [{ version: "1.0.0", engines: { soksak: "^0.0.8" } }] },
      { id: "any", versions: [{ version: "1.0.0", engines: { soksak: "*" } }] },
      { id: "gone", versions: [{ version: "1.0.0", engines: { soksak: ">=0.0.9" } }] },
    ],
    revoked: { plugins: [{ id: "term", version: "0.4.0", reason: "broken" }], sidecars: [] },
  },
  installed: { plugins: { term: { version: "0.2.0" }, notes: { version: "1.0.0" }, any: { version: "1.0.0" }, absent: { version: "1.0.0" } } },
};

test("a plugin whose range does not contain the candidate is listed with its newest version that does", async () => {
  const host = fakeHost({ appUpdateState: { version: "0.0.8", available: { ...available, version: "0.0.9" } } });
  const update = createAppUpdate({ host, changed: () => {}, plugins: () => pluginState });
  await update.refresh();
  // term 0.2.0 needs ^0.0.8; 0.4.0 is revoked, so 0.3.0 is the newest version for 0.0.9. notes has no version for 0.0.9.
  // A plugin whose installed version the index does not list is not judged.
  assert.deepEqual(update.status().incompatible, [
    { id: "notes", installed: "1.0.0", range: "^0.0.8", compatible: null },
    { id: "term", installed: "0.2.0", range: "^0.0.8", compatible: "0.3.0" },
  ]);
});

test("without a candidate or a plugin state no plugin is incompatible", async () => {
  const none = createAppUpdate({ host: fakeHost({ appUpdateState: { version: "0.0.9", available: null } }), changed: () => {}, plugins: () => pluginState });
  await none.refresh();
  assert.deepEqual(none.status().incompatible, []);
  const unread = createAppUpdate({ host: fakeHost({ appUpdateState: { version: "0.0.8", available } }), changed: () => {}, plugins: () => null });
  await unread.refresh();
  assert.deepEqual(unread.status().incompatible, []);
});
