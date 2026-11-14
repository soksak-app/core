// The application update state and operation of the plugin screen (docs/spec/installation.md#application-update).
import test from "node:test";
import assert from "node:assert/strict";
import { host, selectPageWire } from "@soksak/runtime";
import { createAppUpdate, releasePage } from "../app-update.js";

const available = {
  version: "0.0.9",
  release: { url: "https://github.com/soksak-app/core/releases/download/v0.0.9/soksak-0.0.9-darwin-arm64-wailsv3.zip", sha256: "0".repeat(64) },
};

// The host calls of each test are answered by its page-wire case (docs/spec/cases/page-wire/README.md); the update reads the host of the
// runtime that the test selected.
let wire;
/** Selects the case of the test and returns the host of the page. */
function open(name) {
  wire = selectPageWire(`app-update-${name}`);
  return host;
}
/** The calls of the page as [name, payload]. */
const sent = () => wire.calls.map(({ name, payload }) => [name, payload ?? null]);

test("the release page of a version is derived from the release URL of a published release only", () => {
  assert.equal(releasePage(available.release.url), "https://github.com/soksak-app/core/releases/tag/v0.0.9");
  assert.equal(releasePage("file:///releases/soksak-0.0.9.zip"), null);
  assert.equal(releasePage("https://example.org/files/soksak-0.0.9.zip"), null);
});

test("the status names the running version, the candidate with its release page and no operation", async () => {
  const host = open("status");
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
  wire.finish();
});

test("a state that cannot be read is the error of the status and leaves no candidate", async () => {
  const host = open("state-error");
  const update = createAppUpdate({ host, changed: () => {} });
  await update.refresh();
  assert.deepEqual(update.status(), { version: null, available: null, operation: null, error: "registry: unreachable", incompatible: [] });
  wire.finish();
});

test("updating stages the candidate, then applies the staged bundle, and reports each step", async () => {
  const host = open("update-steps");
  const steps = [];
  const update = createAppUpdate({ host, changed: () => { steps.push(update.status().operation?.state ?? null); } });
  await update.refresh();
  await update.update();
  assert.deepEqual(sent().slice(1), [
    ["appUpdateStage", { version: "0.0.9" }],
    ["appUpdateApply", { bundle: "/config/updates/0.0.9/soksak.app" }],
  ]);
  assert.deepEqual(steps, [null, "staging", "applying"]);
  wire.finish();
});

test("a failed step is the error of the operation and stops the update", async () => {
  const host = open("stage-failed");
  const update = createAppUpdate({ host, changed: () => {} });
  await update.refresh();
  await assert.rejects(update.update(), /sha256 differs/);
  assert.deepEqual(update.status().operation, { state: "failed", version: "0.0.9", error: "application update: sha256 differs" });
  assert.equal(sent().some(([name]) => name === "appUpdateApply"), false);
  wire.finish();
});

test("updating without a candidate fails before any host call", async () => {
  const host = open("no-candidate");
  const update = createAppUpdate({ host, changed: () => {} });
  await update.refresh();
  await assert.rejects(update.update(), /no application update is available/);
  assert.equal(wire.calls.length, 1);
  wire.finish();
});

test("opening the release page asks the host to open the page of the candidate and fails without one", async () => {
  const host = open("open-release");
  const update = createAppUpdate({ host, changed: () => {} });
  await update.refresh();
  await update.openRelease();
  assert.deepEqual(sent().at(-1), ["linkOpen", { url: "https://github.com/soksak-app/core/releases/tag/v0.0.9" }]);
  const other = createAppUpdate({ host, changed: () => {} });
  await other.refresh();
  await assert.rejects(other.openRelease(), /no release page/);
  wire.finish();
});

/** A plugin state whose index lists plugin versions with their `engines.soksak` ranges. */
const pluginState = {
  index: {
    plugins: [
      { id: "tty", versions: [{ version: "0.1.0", engines: { soksak: "*" } }, { version: "0.2.0", engines: { soksak: "0.0.8" } }, { version: "0.3.0", engines: { soksak: ">=0.0.9" } }, { version: "0.4.0", engines: { soksak: ">=0.0.9" } }] },
      { id: "notes", versions: [{ version: "1.0.0", engines: { soksak: "0.0.8" } }] },
      { id: "any", versions: [{ version: "1.0.0", engines: { soksak: "*" } }] },
      { id: "gone", versions: [{ version: "1.0.0", engines: { soksak: ">=0.0.9" } }] },
    ],
    revoked: { plugins: [{ id: "tty", version: "0.4.0", reason: "broken" }], sidecars: [] },
  },
  installed: { plugins: { tty: { version: "0.2.0" }, notes: { version: "1.0.0" }, any: { version: "1.0.0" }, absent: { version: "1.0.0" } } },
};

test("a plugin whose range does not contain the candidate is listed with its newest version that does", async () => {
  const host = open("incompatible-plugins");
  const update = createAppUpdate({ host, changed: () => {}, plugins: () => pluginState });
  await update.refresh();
  // tty 0.2.0 needs 0.0.8; 0.4.0 is revoked, so 0.3.0 is the newest version for 0.0.9. notes has no version for 0.0.9.
  // A plugin whose installed version the index does not list is not judged.
  assert.deepEqual(update.status().incompatible, [
    { id: "notes", installed: "1.0.0", range: "0.0.8", compatible: null },
    { id: "tty", installed: "0.2.0", range: "0.0.8", compatible: "0.3.0" },
  ]);
  wire.finish();
});

test("without a candidate or a plugin state no plugin is incompatible", async () => {
  const none = createAppUpdate({ host: open("incompatible-none"), changed: () => {}, plugins: () => pluginState });
  await none.refresh();
  assert.deepEqual(none.status().incompatible, []);
  const unread = createAppUpdate({ host, changed: () => {}, plugins: () => null });
  await unread.refresh();
  assert.deepEqual(unread.status().incompatible, []);
  wire.finish();
});

test("the release page of a command that carries the cids of its cause opens it with those cids", async () => {
  const host = open("open-release-cids");
  const update = createAppUpdate({ host, changed: () => {} });
  await update.refresh();
  await update.openRelease({ cids: ["p1700000000000.6"] });
  assert.deepEqual(wire.calls.at(-1), { name: "linkOpen", payload: { url: "https://github.com/soksak-app/core/releases/tag/v0.0.9" }, cids: ["p1700000000000.6"] });
  wire.finish();
});

test("an update state read that ended after a newer read does not replace its state", async () => {
  const host = open("read-order");
  const update = createAppUpdate({ host, changed: () => {} });
  // The reply of the older read is held, and the newer read is answered first.
  const older = update.refresh();
  const newer = update.refresh();
  await newer;
  wire.release();
  await older;
  assert.equal(update.status().available?.version, "0.0.9", "the older read replaced the state of the newer read");
  wire.finish();
});

test("a read that finds what the page holds calls no listener, and a read that finds a change calls it once", async () => {
  let changes = 0;
  const update = createAppUpdate({ host: open("changed-once"), changed: () => { changes += 1; } });
  const counted = async () => { const before = changes; await update.refresh(); return changes - before; };
  assert.equal(await counted(), 1, "the first state");
  assert.equal(await counted(), 0, "the same state");
  assert.equal(await counted(), 1, "another state");
  assert.equal(await counted(), 1, "a failed read");
  assert.equal(await counted(), 0, "the same failure");
  wire.finish();
});
